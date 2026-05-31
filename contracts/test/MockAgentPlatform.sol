// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IAgentRequester,
    Response,
    Request,
    ResponseStatus,
    ConsensusType
} from "../interfaces/ISomniaAgent.sol";

/// @notice Test-only mock matching the corrected canonical IAgentRequester
///         interface. Unit tests trigger callbacks manually via
///         `triggerCallback`. Re-aligned to the real Request/Response struct
///         shapes (`validator`/`status`/`receipt`/`timestamp`/`executionCost`
///         on Response; the full Request struct with `subcommittee` array,
///         `responseCount`, etc.) so tests catch interface drift early.
contract MockAgentPlatform is IAgentRequester {
    uint256 public nextRequestId = 1;
    string public nextResponseText;
    ResponseStatus public nextStatus = ResponseStatus.Success;
    uint256 public nextWorkers = 4;
    uint256 public deposit = 0.01 ether;

    struct Stored {
        address callbackAddress;
        bytes4 callbackSelector;
        uint256 agentId;
        uint256 threshold;
        ConsensusType consensusType;
        string responseText;
        ResponseStatus status;
        uint256 workers;
        bool delivered;
    }
    mapping(uint256 => Stored) public stored;

    function setNextResponse(string calldata text) external { nextResponseText = text; }
    function setNextStatus(ResponseStatus s) external { nextStatus = s; }
    function setDeposit(uint256 v) external { deposit = v; }

    // Raw-result override: when set, triggerCallback delivers this exact bytes
    // blob as each worker's `result` (instead of abi.encode(string)). Lets
    // tests feed a canned inferToolsChat 6-tuple. Cleared after each delivery.
    bytes public nextRawResult;
    bool public useRaw;
    function setNextRawResult(bytes calldata raw) external { nextRawResult = raw; useRaw = true; }

    function getRequestDeposit() external view returns (uint256) { return deposit; }
    function getAdvancedRequestDeposit(uint256 /*subSize*/) external view returns (uint256) { return deposit; }

    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata /* payload */
    ) external payable returns (uint256 requestId) {
        return _store(agentId, callbackAddress, callbackSelector, 1, ConsensusType.Majority);
    }

    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata /* payload */,
        uint256 /* subcommitteeSize */,
        uint256 threshold,
        ConsensusType consensusType,
        uint256 /* timeout */
    ) external payable returns (uint256 requestId) {
        return _store(agentId, callbackAddress, callbackSelector, threshold, consensusType);
    }

    function _store(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        uint256 threshold,
        ConsensusType consensusType
    ) internal returns (uint256 requestId) {
        requestId = nextRequestId++;
        stored[requestId] = Stored({
            callbackAddress: callbackAddress,
            callbackSelector: callbackSelector,
            agentId: agentId,
            threshold: threshold,
            consensusType: consensusType,
            responseText: nextResponseText,
            status: nextStatus,
            workers: nextWorkers,
            delivered: false
        });
    }

    /// @notice Test helper: deliver the callback for a stored request.
    function triggerCallback(uint256 requestId) external {
        Stored storage s = stored[requestId];
        require(s.callbackAddress != address(0), "no such request");
        require(!s.delivered, "already delivered");
        s.delivered = true;

        Response[] memory responses = new Response[](s.workers);
        bytes memory result = useRaw ? nextRawResult : abi.encode(s.responseText);
        if (useRaw) useRaw = false; // one-shot
        for (uint256 i; i < s.workers; i++) {
            responses[i] = Response({
                validator: address(uint160(i + 1)),
                result: result,
                status: s.status,
                receipt: 0,
                timestamp: block.timestamp,
                executionCost: 0
            });
        }

        address[] memory subcommittee = new address[](s.workers);
        for (uint256 i; i < s.workers; i++) subcommittee[i] = address(uint160(i + 1));
        Request memory details = Request({
            id: requestId,
            requester: address(this),
            callbackAddress: s.callbackAddress,
            callbackSelector: s.callbackSelector,
            subcommittee: subcommittee,
            responses: responses,
            responseCount: s.workers,
            failureCount: 0,
            threshold: s.threshold,
            createdAt: block.timestamp,
            deadline: block.timestamp + 900,
            status: s.status,
            consensusType: s.consensusType,
            remainingBudget: 0,
            perAgentBudget: 0
        });

        (bool ok, bytes memory data) = s.callbackAddress.call(
            abi.encodeWithSelector(s.callbackSelector, requestId, responses, s.status, details)
        );
        if (!ok) {
            assembly { revert(add(data, 32), mload(data)) }
        }
    }
}
