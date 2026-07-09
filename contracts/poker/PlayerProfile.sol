// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PlayerProfile
/// @notice On-chain, self-service player identity for ShinyPoker. Each address
///         can claim ONE unique handle (case-insensitive) plus an avatar id.
///         Everything lives on-chain — nothing is stored off-chain. Used across
///         cash tables and tournaments to show human names (e.g. a tournament
///         creator approving applicants sees their handles). Permissionless:
///         no owner, no fees, one cheap headless tx to set.
contract PlayerProfile {
    struct Profile {
        string handle;
        uint16 avatar;
        uint64 since;
    }

    mapping(address => Profile) internal _profiles;
    /// @notice keccak256(lowercased handle) => current holder (0 = free).
    mapping(bytes32 => address) public holderOfHandleHash;

    event ProfileSet(address indexed user, string handle, uint16 avatar);
    event HandleReleased(address indexed user, string handle);

    error BadHandle();
    error HandleTaken();

    /// @notice Claim or update your handle (+ avatar). 3–20 chars, [A–Z a–z 0–9 _],
    ///         unique case-insensitively. Re-call to change handle or avatar; a
    ///         changed handle frees the previous one for others.
    function setProfile(string calldata handle, uint16 avatar) external {
        bytes32 h = _validateAndHash(bytes(handle));
        address holder = holderOfHandleHash[h];
        if (holder != address(0) && holder != msg.sender) revert HandleTaken();

        Profile storage p = _profiles[msg.sender];
        bytes memory prev = bytes(p.handle);
        if (prev.length != 0) {
            bytes32 ph = _lowerHash(prev);
            if (ph != h) {
                delete holderOfHandleHash[ph];
                emit HandleReleased(msg.sender, p.handle);
            }
        }

        holderOfHandleHash[h] = msg.sender;
        p.handle = handle;
        p.avatar = avatar;
        if (p.since == 0) p.since = uint64(block.timestamp);
        emit ProfileSet(msg.sender, handle, avatar);
    }

    /// @notice Release your handle (frees it for others).
    function clearHandle() external {
        Profile storage p = _profiles[msg.sender];
        bytes memory prev = bytes(p.handle);
        if (prev.length == 0) return;
        delete holderOfHandleHash[_lowerHash(prev)];
        emit HandleReleased(msg.sender, p.handle);
        delete p.handle;
    }

    // ---- views ----

    function profileOf(address user) external view returns (string memory handle, uint16 avatar, uint64 since) {
        Profile storage p = _profiles[user];
        return (p.handle, p.avatar, p.since);
    }

    function handleOf(address user) external view returns (string memory) {
        return _profiles[user].handle;
    }

    function hasHandle(address user) external view returns (bool) {
        return bytes(_profiles[user].handle).length != 0;
    }

    /// @notice Address that currently holds `handle` (0 if free). Case-insensitive.
    function addressOfHandle(string calldata handle) external view returns (address) {
        return holderOfHandleHash[_lowerHash(bytes(handle))];
    }

    /// @notice True if `handle` is well-formed AND not currently taken.
    function handleAvailable(string calldata handle) external view returns (bool) {
        bytes memory b = bytes(handle);
        if (!_isValid(b)) return false;
        return holderOfHandleHash[_lowerHash(b)] == address(0);
    }

    // ---- internal ----

    function _validateAndHash(bytes memory b) internal pure returns (bytes32) {
        if (!_isValid(b)) revert BadHandle();
        return _lowerHash(b);
    }

    function _isValid(bytes memory b) internal pure returns (bool) {
        if (b.length < 3 || b.length > 20) return false;
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            bool ok = (c >= 0x30 && c <= 0x39) // 0-9
                || (c >= 0x41 && c <= 0x5A) // A-Z
                || (c >= 0x61 && c <= 0x7A) // a-z
                || c == 0x5F; // _
            if (!ok) return false;
        }
        return true;
    }

    function _lowerHash(bytes memory b) internal pure returns (bytes32) {
        bytes memory lo = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            uint8 c = uint8(b[i]);
            if (c >= 0x41 && c <= 0x5A) c += 32; // A-Z -> a-z
            lo[i] = bytes1(c);
        }
        return keccak256(lo);
    }
}
