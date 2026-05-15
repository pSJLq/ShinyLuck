// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {
    ISomniaAgentPlatform,
    IAgentRequesterHandler,
    Response,
    Request,
    ResponseStatus,
    ConsensusType
} from "../interfaces/ISomniaAgent.sol";

/// @notice Test-only mock that defers the requester callback to a separate
///         tx (`triggerCallback`). This mirrors Somnia's async consensus model
///         and avoids the race where the requester hasn't yet stored its
///         pending-state when a synchronous callback fires.
contract MockAgentPlatform is ISomniaAgentPlatform {
    uint256 public nextRequestId = 1;
    string public nextResponseText;
    ResponseStatus public nextStatus = ResponseStatus.SUCCESS;
    uint256 public nextWorkers = 4;
    uint256 public deposit = 0.01 ether;

    struct Stored {
        address callbackAddress;
        bytes4 callbackSelector;
        Request req;
        string responseText;
        ResponseStatus status;
        uint256 workers;
        bool delivered;
    }
    mapping(uint256 => Stored) public stored;

    function setNextResponse(string calldata text) external { nextResponseText = text; }
    function setNextStatus(ResponseStatus s) external { nextStatus = s; }
    function setDeposit(uint256 v) external { deposit = v; }

    function getRequestDeposit() external view returns (uint256) { return deposit; }

    function createRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload
    ) external payable returns (uint256 requestId) {
        return _store(agentId, callbackAddress, callbackSelector, payload, 1, 1, ConsensusType.EXACT, 0);
    }

    function createAdvancedRequest(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256 subcommitteeSize,
        uint256 threshold,
        ConsensusType consensusType,
        uint256 timeout
    ) external payable returns (uint256 requestId) {
        return _store(agentId, callbackAddress, callbackSelector, payload, subcommitteeSize, threshold, consensusType, timeout);
    }

    function _store(
        uint256 agentId,
        address callbackAddress,
        bytes4 callbackSelector,
        bytes calldata payload,
        uint256 subcommitteeSize,
        uint256 threshold,
        ConsensusType consensusType,
        uint256 timeout
    ) internal returns (uint256 requestId) {
        requestId = nextRequestId++;
        stored[requestId] = Stored({
            callbackAddress: callbackAddress,
            callbackSelector: callbackSelector,
            req: Request({
                agentId: agentId,
                callbackAddress: callbackAddress,
                callbackSelector: callbackSelector,
                payload: payload,
                subcommitteeSize: subcommitteeSize,
                threshold: threshold,
                consensusType: consensusType,
                timeout: timeout,
                deposit: msg.value
            }),
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
        bytes memory result = abi.encode(s.responseText);
        for (uint256 i; i < s.workers; i++) {
            responses[i] = Response({worker: address(uint160(i + 1)), result: result});
        }

        (bool ok, bytes memory data) = s.callbackAddress.call(
            abi.encodeWithSelector(s.callbackSelector, requestId, responses, s.status, s.req)
        );
        if (!ok) {
            assembly { revert(add(data, 32), mload(data)) }
        }
    }
}
