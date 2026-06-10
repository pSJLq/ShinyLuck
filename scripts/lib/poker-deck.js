// Shared deck logic for the ShinyPoker off-chain dealer bot.
//
// deriveDeck() MUST reproduce CommitRevealDealer._deriveDeck() byte-for-byte —
// if it drifts, players are told the wrong hole cards. The parity test
// (test/PokerDeckParity.test.js) pins it against the contract's recomputeDeck().
//
// Card encoding (shared with IPokerDealer / PokerHandEval): a card is 0..51 with
//   rank = card / 4   (0 = deuce … 12 = ace)
//   suit = card % 4   (0=♣ 1=♦ 2=♥ 3=♠)

const { ethers } = require("ethers");

const CODER = ethers.AbiCoder.defaultAbiCoder();
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUITS = ["c", "d", "h", "s"];

/// Deterministic Fisher-Yates shuffle, identical to the Solidity dealer.
function deriveDeck(serverSeed, entropy, handId, tableId) {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  let r = ethers.keccak256(
    CODER.encode(["bytes32", "bytes32", "uint64", "uint64"], [serverSeed, entropy, BigInt(handId), BigInt(tableId)]),
  );
  for (let i = 51; i > 0; i--) {
    r = ethers.keccak256(CODER.encode(["bytes32", "uint256"], [r, BigInt(i)]));
    const j = Number(BigInt(r) % BigInt(i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

/// Map a shuffled deck onto a hand. `seats` is the dealt-in seat order.
/// Returns { holesBySeat: {seat:[c0,c1]}, board: [5 cards] } — matching the
/// dealer contract's convention (seat i gets deck[i] & deck[k+i]; board follows).
function dealHand(deck, seats) {
  const k = seats.length;
  const holesBySeat = {};
  for (let i = 0; i < k; i++) {
    holesBySeat[seats[i]] = [deck[i], deck[k + i]];
  }
  const board = deck.slice(2 * k, 2 * k + 5);
  return { holesBySeat, board };
}

const cardRank = (c) => Math.floor(c / 4);
const cardSuit = (c) => c % 4;
const cardStr = (c) => (c === 255 ? "??" : RANKS[cardRank(c)] + SUITS[cardSuit(c)]);

/// keccak256(abi.encode(bytes32 seed)) — the on-chain seed commitment.
function hashSeed(seed) {
  return ethers.keccak256(CODER.encode(["bytes32"], [seed]));
}

/// Deterministic seed supply keyed by a master secret (same scheme the casino
/// reveal-bot uses), so the dealer survives restarts without a seeds file.
function deriveSeed(masterKey, idx) {
  return ethers.keccak256(ethers.solidityPacked(["bytes32", "uint256"], [masterKey, BigInt(idx)]));
}

module.exports = { deriveDeck, dealHand, cardRank, cardSuit, cardStr, hashSeed, deriveSeed, RANKS, SUITS };
