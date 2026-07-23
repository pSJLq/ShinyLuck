// Mines hidden-layout coordinator (shared, dependency-light).
//
// The v14 Mines contract never stores the mine layout — only a Merkle ROOT.
// This module is the trusted-but-verifiable coordinator half:
//   • derives the layout from the SAME randomness recipe the contract's
//     finalizeMines uses (serverSeed, clientSeed, entropy blockhash, nonce),
//   • builds the 32-leaf salted Merkle tree,
//   • serves a single cell's {isMine, salt, proof} on demand (per click),
//   • the contract adjudicates every open against the root and, at finalize,
//     recomputes the whole tree on-chain — so a lying coordinator is caught
//     publicly and the player is refunded. This code must byte-match
//     Casino.sol `_minesLayoutRoot` / `_selectMines` / `_minesProofRoot`.
//
// Pure functions only (no ethers, no network) so the unit test can pin them
// against the Solidity. The caller passes an abi-coder + keccak256.
"use strict";

// selectMines — mirror of Casino._selectMines (Fisher-Yates over 25 cells).
function selectMines(keccak256, encode, randomness, mineCount) {
  let bits = 0n;
  const cells = [];
  for (let i = 0; i < 25; i++) cells.push(i);
  let remaining = 25;
  let r = randomness;
  for (let i = 0; i < mineCount; i++) {
    r = keccak256(encode(["bytes32", "uint8"], [r, i]));
    const idx = Number(BigInt(r) % BigInt(remaining));
    bits |= 1n << BigInt(cells[idx]);
    cells[idx] = cells[remaining - 1];
    remaining--;
  }
  return bits;
}

// Per-cell salt — keccak(serverSeed, betId, i). Keeps a 1-bit leaf
// un-brute-forceable from public data while the game is live.
function cellSalt(keccak256, encode, serverSeed, betId, i) {
  return keccak256(encode(["bytes32", "uint256", "uint256"], [serverSeed, BigInt(betId), BigInt(i)]));
}

function realLeaf(keccak256, encode, betId, i, isMine, salt) {
  return keccak256(encode(["uint256", "uint256", "bool", "bytes32"], [BigInt(betId), BigInt(i), isMine, salt]));
}
function padLeaf(keccak256, encode, betId, i) {
  return keccak256(encode(["uint256", "uint256"], [BigInt(betId), BigInt(i)]));
}

// Builds the depth-5 tree (25 real cells + 7 pads = 32 leaves). Returns
// { root, leaves, levels } so a proof for any index can be sliced out.
function buildTree(keccak256, encode, concat, betId, bitmap, serverSeed) {
  const leaves = [];
  for (let i = 0; i < 25; i++) {
    const isMine = (bitmap & (1n << BigInt(i))) !== 0n;
    leaves.push(realLeaf(keccak256, encode, betId, i, isMine, cellSalt(keccak256, encode, serverSeed, betId, i)));
  }
  for (let i = 25; i < 32; i++) leaves.push(padLeaf(keccak256, encode, betId, i));
  const levels = [leaves];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) next.push(keccak256(concat([prev[i], prev[i + 1]])));
    levels.push(next);
  }
  return { root: levels[levels.length - 1][0], leaves, levels };
}

// Index-ordered sibling path (length 5) for a fixed-depth tree.
function proofFor(levels, index) {
  const proof = [];
  let idx = index;
  for (let lvl = 0; lvl < 5; lvl++) {
    proof.push(levels[lvl][idx ^ 1]);
    idx >>= 1;
  }
  return proof;
}

// The randomness finalizeMines will recompute — must match exactly.
// solidityPacked(serverSeed, clientSeed, entropyHash, nonce) then keccak.
function deriveRandomness(keccak256, solidityPacked, serverSeed, clientSeed, entropyHash, nonce) {
  return keccak256(solidityPacked(
    ["bytes32", "bytes32", "bytes32", "uint256"],
    [serverSeed, clientSeed, entropyHash, BigInt(nonce)]));
}

// One-call helper: everything the coordinator needs for a bet.
function layoutFor({ keccak256, encode, concat, solidityPacked }, { betId, serverSeed, clientSeed, entropyHash, nonce, mineCount }) {
  const randomness = deriveRandomness(keccak256, solidityPacked, serverSeed, clientSeed, entropyHash, nonce);
  const bitmap = selectMines(keccak256, encode, randomness, mineCount);
  const tree = buildTree(keccak256, encode, concat, betId, bitmap, serverSeed);
  return { randomness, bitmap, tree };
}

// Cell disclosure served to the player on click.
function cellProof({ keccak256, encode, concat }, { betId, serverSeed, bitmap, tree, idx }) {
  const isMine = (bitmap & (1n << BigInt(idx))) !== 0n;
  return {
    idx,
    isMine,
    salt: cellSalt(keccak256, encode, serverSeed, betId, idx),
    proof: proofFor(tree.levels, idx),
  };
}

module.exports = {
  selectMines, cellSalt, realLeaf, padLeaf, buildTree, proofFor,
  deriveRandomness, layoutFor, cellProof,
};
