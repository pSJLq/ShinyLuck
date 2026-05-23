// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Casino} from "./Casino.sol";
import {CommitReveal} from "./CommitReveal.sol";
import {
    ISomniaAgentPlatform,
    IAgentRequesterHandler,
    ILLMAgent,
    Response,
    Request,
    ResponseStatus,
    ConsensusType
} from "./interfaces/ISomniaAgent.sol";

/// @title AgentQuorumVerifier
/// @notice Optional redundancy check on settled bets. Asks the LLM Inference
///         Agent (via Somnia's subcommittee + threshold consensus) to
///         independently produce the same keccak256 randomness the Casino
///         already computed on-chain. Emits QuorumOk on match, QuorumWarning
///         on mismatch or failed consensus. Money never depends on this.
///
/// @dev    This is a "hackathon demo" feature. Real-money fairness is
///         guaranteed by Casino + CommitReveal. The agents only confirm.
contract AgentQuorumVerifier is Ownable, ReentrancyGuard, IAgentRequesterHandler {
    Casino public immutable casino;
    ISomniaAgentPlatform public platform;
    uint256 public llmAgentId;

    /// @notice Per-call extra reward the platform forwards to each worker.
    ///         Set by owner; must be enough for the LLM agent to run.
    uint256 public perAgentReward = 0.001 ether;
    uint256 public subcommitteeSize = 4;
    uint256 public threshold = 3;
    uint256 public timeoutSeconds = 60;

    struct PendingVerification {
        uint256 betId;
        bytes32 expected;
        address requester;
        bool resolved;
    }
    mapping(uint256 => PendingVerification) public pending;

    event QuorumRequested(uint256 indexed betId, uint256 indexed requestId, address indexed requester);
    /// @notice Per-bet quorum receipt. `signers` = number of subcommittee
    ///         workers whose result decoded to the on-chain randomness.
    ///         level: 0=critical (≤1/4), 1=warning (2/4), 2=ok (3+/4).
    event QuorumResult(
        uint256 indexed betId,
        uint256 indexed requestId,
        bytes32 expected,
        uint8 signers,
        uint8 totalWorkers,
        uint8 level,
        ResponseStatus status,
        string sampleResponse
    );

    error UnknownRequest();
    error AlreadyResolved();
    error BetNotSettled();
    error WrongCaller();

    constructor(address casino_, address platform_, uint256 llmAgentId_)
        Ownable(msg.sender)
    {
        casino = Casino(payable(casino_));
        platform = ISomniaAgentPlatform(platform_);
        llmAgentId = llmAgentId_;
    }

    function setPlatform(address platform_) external onlyOwner {
        platform = ISomniaAgentPlatform(platform_);
    }

    function setLlmAgentId(uint256 id) external onlyOwner { llmAgentId = id; }
    function setPerAgentReward(uint256 v) external onlyOwner { perAgentReward = v; }
    function setQuorumParams(uint256 size, uint256 thresh, uint256 timeout) external onlyOwner {
        require(thresh > 0 && thresh <= size && size <= 9, "params");
        subcommitteeSize = size;
        threshold = thresh;
        timeoutSeconds = timeout;
    }

    /// @notice Required deposit for one verification call.
    function quotePrice() public view returns (uint256) {
        return platform.getRequestDeposit() + perAgentReward * subcommitteeSize;
    }

    /// @notice Fire a verification request for a settled bet. Anyone may pay.
    function requestVerification(uint256 betId) external payable nonReentrant {
        Casino.Bet memory bet = casino.getBet(betId);
        if (bet.status != 1) revert BetNotSettled(); // 1 = settled

        bytes32 serverSeed = casino.revealedSeed(bet.seedIdx);
        bytes32 blockHash = blockhash(bet.commitBlock + CommitReveal.REVEAL_DELAY);

        string memory prompt = _buildPrompt(serverSeed, bet.clientSeed, blockHash, bet.nonce);
        string memory system = "You are a deterministic hash oracle. Output ONLY the 64-character lowercase hex digest of keccak256 of the concatenated 32-byte inputs in the order given. No prefix, no explanation.";

        bytes memory payload = abi.encodeWithSelector(
            ILLMAgent.inferString.selector,
            prompt,
            system,
            false,           // chainOfThought
            new string[](0)  // allowedValues
        );

        uint256 deposit = quotePrice();
        require(msg.value >= deposit, "insufficient deposit");

        uint256 requestId = platform.createAdvancedRequest{value: deposit}(
            llmAgentId,
            address(this),
            this.handleResponse.selector,
            payload,
            subcommitteeSize,
            threshold,
            ConsensusType.Majority,
            timeoutSeconds
        );

        pending[requestId] = PendingVerification({
            betId: betId,
            expected: bet.randomness,
            requester: msg.sender,
            resolved: false
        });

        emit QuorumRequested(betId, requestId, msg.sender);

        // Refund any overpay (platform itself will rebate unused gas later via
        // the deposit-rebate mechanism; this just covers caller-side overpay).
        if (msg.value > deposit) {
            (bool ok,) = msg.sender.call{value: msg.value - deposit}("");
            require(ok, "refund failed");
        }
    }

    /// @notice Platform callback. Counts how many of the subcommittee workers
    ///         produced the on-chain randomness as their answer and emits
    ///         `QuorumResult` with the signer count + a discrete level.
    ///         Mismatch never reverts - money path is unaffected by this check.
    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory /*details*/
    ) external override {
        if (msg.sender != address(platform)) revert WrongCaller();

        PendingVerification storage p = pending[requestId];
        if (p.requester == address(0)) revert UnknownRequest();
        if (p.resolved) revert AlreadyResolved();
        p.resolved = true;

        uint8 total = uint8(responses.length);
        uint8 signers = 0;
        string memory sample;
        for (uint256 i; i < responses.length; i++) {
            string memory text;
            // Defensive decode - a malformed worker result must not blow up the loop.
            try this.tryDecodeString(responses[i].result) returns (string memory s) { text = s; }
            catch { text = ""; }
            if (i == 0) sample = text;
            if (_parseHex32(text) == p.expected) signers++;
        }

        uint8 level;
        if (status != ResponseStatus.Success || total == 0)             level = 0; // critical
        else if (signers * 4 >= total * 3)                              level = 2; // ok (≥75%)
        else if (signers * 2 >= total)                                  level = 1; // warning (≥50%)
        else                                                            level = 0; // critical

        emit QuorumResult(p.betId, requestId, p.expected, signers, total, level, status, sample);
    }

    /// @dev Wrapper exposed for the try/catch defensive decode above. Must be
    ///      external so it gets its own call frame; reverts on bad input.
    function tryDecodeString(bytes calldata b) external pure returns (string memory) {
        return abi.decode(b, (string));
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _buildPrompt(
        bytes32 a, bytes32 b, bytes32 c, uint256 nonce
    ) internal pure returns (string memory) {
        return string(abi.encodePacked(
            "keccak256(",
            _toHex(a), ",",
            _toHex(b), ",",
            _toHex(c), ",",
            _u2s(nonce),
            ") = ?"
        ));
    }

    function _toHex(bytes32 v) internal pure returns (string memory) {
        bytes memory s = new bytes(66);
        s[0] = "0"; s[1] = "x";
        bytes memory hexAlpha = "0123456789abcdef";
        for (uint256 i; i < 32; i++) {
            uint8 b = uint8(v[i]);
            s[2 + i*2]     = hexAlpha[b >> 4];
            s[2 + i*2 + 1] = hexAlpha[b & 0x0f];
        }
        return string(s);
    }

    function _u2s(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 t = v; uint256 d;
        while (t != 0) { d++; t /= 10; }
        bytes memory s = new bytes(d);
        while (v != 0) { d--; s[d] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(s);
    }

    /// @dev Parses a string of exactly 64 hex chars (no 0x prefix) into bytes32.
    ///      Accepts leading/trailing whitespace and an optional 0x prefix.
    function _parseHex32(string memory s) internal pure returns (bytes32) {
        bytes memory b = bytes(s);
        // strip whitespace
        uint256 start = 0;
        uint256 end = b.length;
        while (start < end && (b[start] == 0x20 || b[start] == 0x0a)) start++;
        while (end > start && (b[end-1] == 0x20 || b[end-1] == 0x0a)) end--;
        if (end - start >= 2 && b[start] == "0" && (b[start+1] == "x" || b[start+1] == "X")) {
            start += 2;
        }
        if (end - start != 64) return bytes32(0);
        uint256 acc = 0;
        for (uint256 i = start; i < end; i++) {
            uint8 c = uint8(b[i]);
            uint8 nib;
            if (c >= 0x30 && c <= 0x39) nib = c - 0x30;
            else if (c >= 0x61 && c <= 0x66) nib = c - 0x61 + 10;
            else if (c >= 0x41 && c <= 0x46) nib = c - 0x41 + 10;
            else return bytes32(0);
            acc = (acc << 4) | nib;
        }
        return bytes32(acc);
    }
}
