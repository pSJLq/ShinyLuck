// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Somnia Agent Platform interface (subset).
/// @dev   Source: docs.somnia.network/agents/invoking-agents/from-solidity
///        Platform deployed on Shannon testnet at 0x5E5205CF39E766118C01636bED000A54D93163E6.
///
///        Async model: the requesting contract pays a deposit, the platform
///        dispatches the call to a subcommittee of nodes, and once consensus
///        is reached the platform calls back into `callbackAddress` using
///        `callbackSelector` with a fixed handler signature (see IAgentRequesterHandler).

enum ConsensusType {
    EXACT,      // bytewise-equal results required
    NUMERIC,    // numeric comparison within tolerance
    SUBJECTIVE  // best-of subjective scoring
}

enum ResponseStatus {
    PENDING,
    SUCCESS,
    FAILED_CONSENSUS,
    TIMEOUT,
    ERROR
}

struct Response {
    address worker;
    bytes   result;
}

struct Request {
    uint256 agentId;
    address callbackAddress;
    bytes4  callbackSelector;
    bytes   payload;
    uint256 subcommitteeSize;
    uint256 threshold;
    ConsensusType consensusType;
    uint256 timeout;
    uint256 deposit;
}

interface ISomniaAgentPlatform {
    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable returns (uint256 requestId);

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

    function getRequestDeposit() external view returns (uint256);
}

/// @dev Callback contract MUST implement this exact handler signature.
///      The selector passed to createRequest must equal handleResponse.selector
///      (or whatever name the contract uses, as long as the signature matches).
interface IAgentRequesterHandler {
    function handleResponse(
        uint256 requestId,
        Response[] memory responses,
        ResponseStatus status,
        Request memory details
    ) external;
}

/// @dev LLM Inference Agent ABI used to encode the payload bytes.
///      Actual on-chain function is not directly callable — its selector and
///      args are wrapped via abi.encodeWithSelector into the request payload.
interface ILLMAgent {
    struct OnchainTool { string signature; string description; }

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
