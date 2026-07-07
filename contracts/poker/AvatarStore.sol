// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AvatarStore — fully on-chain player avatars.
/// @notice Players upload a TINY image (the frontend crops/compresses to
///         ~96×96 WebP, a few KB) and it lives in contract storage — no
///         server, no IPFS pinning, nothing to rot. Anyone can read it
///         straight from the chain and render a data URI.
/// @dev    Permissionless and ownerless by design: an avatar belongs to
///         msg.sender alone. Size-capped so a griefer can't stuff megabytes.
contract AvatarStore {
    uint256 public constant MAX_BYTES = 8192;

    mapping(address => bytes) private _img;

    event AvatarSet(address indexed player, uint256 size);

    error TooBig();

    /// @notice Set (or replace) your avatar. `data` is the raw image bytes
    ///         (WebP/JPEG/PNG — the frontend sniffs the magic for the MIME).
    function setAvatar(bytes calldata data) external {
        if (data.length > MAX_BYTES) revert TooBig();
        _img[msg.sender] = data;
        emit AvatarSet(msg.sender, data.length);
    }

    /// @notice Remove your avatar (falls back to the profile's preset/auto look).
    function clearAvatar() external {
        delete _img[msg.sender];
        emit AvatarSet(msg.sender, 0);
    }

    function avatarOf(address p) external view returns (bytes memory) {
        return _img[p];
    }

    function hasAvatar(address p) external view returns (bool) {
        return _img[p].length > 0;
    }
}
