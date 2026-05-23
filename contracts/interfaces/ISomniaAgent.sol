// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title  Somnia IAgentRequester - consumer interface for invoking
///         decentralized AI / oracle / web-extraction agents on Somnia.
/// @notice This file is the canonical interface vendored from
///         github.com/somnia-chain/agentathon
///         (somnia-agents-skills/references/interfaces/IAgentRequester.sol).
///         An earlier in-house copy in this repo had the wrong enum names
///         (EXACT/NUMERIC/SUBJECTIVE → don't exist) and a fictional `Request`
///         struct shape, which meant every `createAdvancedRequest` we sent
///         was silently malformed at the consensus layer - workers picked
///         up the request, couldn't agree on a result shape, and let it
///         time out. This corrected file matches the on-chain platform
///         byte-for-byte.
///
///         Platform deployment:
///           - Mainnet (5031):  0x5E5205CF39E766118C01636bED000A54D93163E6
///           - Testnet (50312): 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776

/// @notice How responses are aggregated to reach finality.
enum ConsensusType {
    Majority,   // Finalizes when `threshold` validators return byte-identical results
    Threshold   // Finalizes when `threshold` validators return any successful result
}

/// @notice Lifecycle status of a request or individual response.
enum ResponseStatus {
    None,       // 0 - uninitialized
    Pending,    // 1 - awaiting responses
    Success,    // 2 - consensus reached
    Failed,     // 3 - explicit failure
    TimedOut    // 4 - deadline elapsed before consensus
}

/// @notice A single validator's response to a request.
struct Response {
    address validator;
    bytes result;             // ABI-encoded return value(s) of the agent function
    ResponseStatus status;
    uint256 receipt;          // Off-chain receipt ID (currently always 0 on-chain)
    uint256 timestamp;
    uint256 executionCost;    // Self-reported, capped at perAgentBudget
}

/// @notice On-chain representation of an agent execution request.
struct Request {
    uint256 id;
    address requester;
    address callbackAddress;
    bytes4 callbackSelector;
    address[] subcommittee;
    Response[] responses;
    uint256 responseCount;
    uint256 failureCount;
    uint256 threshold;
    uint256 createdAt;
    uint256 deadline;
    ResponseStatus status;
    ConsensusType consensusType;
    uint256 remainingBudget;
    uint256 perAgentBudget;
}

/// @title IAgentRequester
/// @notice Consumer interface for invoking agents on Somnia. Methods on this
///         contract are the ENTRY POINTS - workers responding via
///         `submitResponse` are an internal-only flow.
interface IAgentRequester {
    error AgentNotFound(uint256 agentId);
    error RequestNotFound(uint256 requestId);
    error InsufficientDeposit(uint256 sent, uint256 required);

    event RequestCreated(
        uint256 indexed requestId,
        uint256 indexed agentId,
        uint256 perAgentBudget,
        bytes payload,
        address[] subcommittee
    );
    event RequestFinalized(uint256 indexed requestId, ResponseStatus status);

    /// @notice Standard request - default consensus (Majority), default sub
    ///         size (3), default timeout (15 min).
    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable returns (uint256 requestId);

    /// @notice Custom consensus parameters.
    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256 subcommitteeSize,
        uint256 threshold,
        ConsensusType consensusType,
        uint256 timeout
    ) external payable returns (uint256 requestId);

    /// @notice Operations-reserve floor. NOTE: meeting it only is NOT enough
    ///         to get the request executed - runners ignore requests whose
    ///         `perAgentBudget = (msg.value - reserve) / subSize` is zero.
    ///         Always fund `getRequestDeposit() + pricePerAgent × subSize`.
    function getRequestDeposit() external view returns (uint256);

    /// @notice Operations-reserve floor for a custom subcommittee size.
    function getAdvancedRequestDeposit(uint256 subcommitteeSize) external view returns (uint256);
}

/// @notice Callback signature your contract MUST implement to receive results.
///         The platform invokes this when consensus (or timeout) is reached.
interface IAgentRequesterHandler {
    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory details
    ) external;
}

/// @notice LLM Inference Agent (agentId = 12847293847561029384, same on
///         testnet + mainnet). Per-worker cost: 0.07 STT/SOMI. Default
///         consensus = Majority (deterministic - fixed seed, temp=0).
interface ILLMAgent {
    function inferString(
        string memory prompt,
        string memory system,
        bool chainOfThought,
        string[] memory allowedValues
    ) external returns (string memory response);

    function inferNumber(
        string memory prompt,
        string memory system,
        int256 minValue,
        int256 maxValue,
        bool chainOfThought
    ) external returns (int256 response);
}

/// @notice JSON API Request Agent (agentId = 13174292974160097713). Fetches
///         JSON from public HTTPS endpoints and extracts a value by JSONPath
///         selector. Per-worker cost: 0.03 STT/SOMI. Consensus = Majority.
interface IJsonApiAgent {
    function fetchString(string memory url, string memory selector)
        external returns (string memory result);

    function fetchUint(string memory url, string memory selector, uint8 decimals)
        external returns (uint256 result);

    function fetchInt(string memory url, string memory selector, uint8 decimals)
        external returns (int256 result);
}

/// @dev Back-compat aliases - older files in this repo reference these names.
///      New code should use IAgentRequester / IAgentRequesterHandler.
interface ISomniaAgentPlatform is IAgentRequester {}
