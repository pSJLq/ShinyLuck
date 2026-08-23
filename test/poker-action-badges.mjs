// THE BADGE THAT LIED, AS A UNIT TEST.
//
// A player bet, the seat flashed BET for a moment, and then went back to
// CHECK — announcing an action that was not the one that happened. The cause
// is not in the poker logic, it is in the shape of a snapshot: `SP.sdk.snapshot`
// reads getHand and every seat as SEPARATE eth_calls, and on Somnia six blocks
// can pass while that batch is in flight (measured: ~190ms for 13 calls at
// 100ms per block). So a read where the seats are newer than the hand — or the
// other way round — is ordinary traffic, and the diff that turns snapshots into
// badges has to survive it.
//
// This drives `actionDiff` (module scope in poker-live-table.jsx) with snapshot
// sequences a live table only produces by accident, which is exactly why the
// browser E2E never caught this one: it plays clean hands on a local chain
// where every read lands in the same block.
//
//   node test/poker-action-badges.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(REPO, "frontend", "poker", "poker-live-table.jsx");

// Pull the pure function out of the page source without a browser: it is
// bounded by its own marker comments, needs only NV, and touches nothing else.
const src = fs.readFileSync(SRC, "utf8");
const from = src.indexOf("const ACT_AGGRO");
const to = src.indexOf("if (typeof window !== \"undefined\") window.SPActionDiff");
if (from < 0 || to < 0) { console.error("✗ actionDiff not found in poker-live-table.jsx"); process.exit(1); }
const NV = (v) => Number(v); // chip units · the table's own NV in tournament mode
const actionDiff = new Function("NV", src.slice(from, to) + "\nreturn actionDiff;")(NV);

let failures = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) return console.log(`  ✓ ${name}`);
  failures++;
  console.log(`  ✗ ${name}\n      got  ${g}\n      want ${w}`);
};

// ---- snapshot builders -------------------------------------------------
// seats: [{cs, stack, folded, allIn, inHand}] indexed by seat
const snapOf = (hand, seats) => ({
  hand: { inProgress: true, dealId: 7n, ...hand },
  seats: seats.map((s, i) => ({
    index: i, empty: false, committedStreet: s.cs, stack: s.stack,
    folded: !!s.folded, allIn: !!s.allIn, inHand: s.inHand !== false,
  })),
});
// the shape poker-live-table keeps in prevRef
const prevOf = (cur) => ({
  handId: cur.hand.handId, street: cur.hand.street, curBet: cur.hand.currentBet,
  actingSeat: cur.hand.actingSeat,
  stacks: Object.fromEntries(cur.seats.map((s) => [s.index, s.stack])),
  sh: Object.fromEntries(cur.seats.map((s) => [s.index, { cs: s.committedStreet, folded: s.folded, allIn: s.allIn }])),
});
// feed a chain of snapshots through the diff the way the component does
const run = (snaps) => {
  let acc = {};
  for (let i = 1; i < snaps.length; i++) {
    acc = { ...acc, ...actionDiff(prevOf(snaps[i - 1]), snaps[i], acc, 1000 + i) };
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, v.amt != null ? `${v.kind}:${v.amt}` : v.kind]));
};

console.log("\naction badges · torn and whole snapshots\n");

// ---- 1. THE REPORTED BUG ----------------------------------------------
// Flop, seat 0 checks, seat 1 bets 250. The read that carries the bet is torn:
// the seats are a block ahead of the hand, so it still says actingSeat = 1 and
// currentBet = 0. The next read is whole. Before the fix that second read was
// indistinguishable from "seat 1's turn passed and they put nothing in".
check("bet after a check survives a torn read",
  run([
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 0 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),   // seat 0 checked
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 9000n }, { cs: 250n, stack: 8750n }]), // TORN: seats ahead
    snapOf({ handId: 5, street: 1, currentBet: 250n, actingSeat: 0 }, [{ cs: 0n, stack: 9000n }, { cs: 250n, stack: 8750n }]), // whole
  ]),
  { 0: "check", 1: "bet:250" });

// ...and the same for a raise over an existing bet.
check("raise survives a torn read",
  run([
    snapOf({ handId: 5, street: 2, currentBet: 200n, actingSeat: 1 }, [{ cs: 200n, stack: 8800n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 2, currentBet: 200n, actingSeat: 1 }, [{ cs: 200n, stack: 8800n }, { cs: 600n, stack: 8400n }]), // TORN
    snapOf({ handId: 5, street: 2, currentBet: 600n, actingSeat: 0 }, [{ cs: 200n, stack: 8800n }, { cs: 600n, stack: 8400n }]),
  ]),
  { 1: "raise:600" });

// ---- 2. WHAT MUST STILL WORK ------------------------------------------
check("a real check still reads as a check",
  run([
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 0 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),
  ]),
  { 0: "check" });

// A new street wipes committedStreet, so the seat that CLOSED the old one is
// read from what left its stack. Checking closes it having paid nothing.
check("the check that closed a street",
  run([
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 2, currentBet: 0n, actingSeat: 0 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),
  ]),
  { 1: "check" });

check("the call that closed a street",
  run([
    snapOf({ handId: 5, street: 1, currentBet: 250n, actingSeat: 1 }, [{ cs: 250n, stack: 8750n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 2, currentBet: 0n, actingSeat: 0 }, [{ cs: 0n, stack: 8750n }, { cs: 0n, stack: 8750n }]),
  ]),
  { 1: "call:250" });

// THE ONE THE OLD CODE GOT WRONG EVEN WITHOUT TEARING: a bet can close a
// street when everyone else is already all-in. committedStreet is back to zero
// by the next read, and "owed nothing" made it look like a check — but 400
// chips left the stack, and chips only leave a stack by being committed.
check("a bet that closed a street is not a check",
  run([
    snapOf({ handId: 5, street: 2, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 4000n, allIn: true }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 3, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 4000n, allIn: true }, { cs: 0n, stack: 8600n }]),
  ]),
  { 1: "bet:400" });

// §29.3(2), kept as a regression: raise the flop, check the turn, and the seat
// must stop saying RAISE.
check("a raise does not outlive its street",
  run([
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 0 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 1, currentBet: 300n, actingSeat: 1 }, [{ cs: 300n, stack: 8700n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 2, currentBet: 0n, actingSeat: 0 }, [{ cs: 0n, stack: 8700n }, { cs: 0n, stack: 8700n }]),
    snapOf({ handId: 5, street: 2, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 8700n }, { cs: 0n, stack: 8700n }]),
  ]),
  { 0: "check", 1: "call:300" });

// A fold and the street it ended can arrive in the same poll gap: the closing
// branch then speaks for a seat that is out of the hand. It must not.
check("a fold is not rewritten by the street it closed",
  run([
    snapOf({ handId: 5, street: 1, currentBet: 200n, actingSeat: 0 }, [{ cs: 0n, stack: 9000n }, { cs: 200n, stack: 8800n }, { cs: 200n, stack: 8800n }]),
    snapOf({ handId: 5, street: 2, currentBet: 0n, actingSeat: 1 }, [{ cs: 0n, stack: 9000n, folded: true, inHand: false }, { cs: 0n, stack: 8800n }, { cs: 0n, stack: 8800n }]),
  ]),
  { 0: "fold" });

// A badge belongs to one hand: the next deal starts silent.
check("badges do not cross hands",
  run([
    snapOf({ handId: 5, street: 1, currentBet: 0n, actingSeat: 0 }, [{ cs: 0n, stack: 9000n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 5, street: 1, currentBet: 250n, actingSeat: 1 }, [{ cs: 250n, stack: 8750n }, { cs: 0n, stack: 9000n }]),
    snapOf({ handId: 6, street: 0, currentBet: 200n, actingSeat: 0 }, [{ cs: 100n, stack: 8900n }, { cs: 200n, stack: 8800n }]),
  ]),
  { 0: "bet:250" }); // stamped with hand 5 · actFor() drops it because deal ≠ current

console.log(failures ? `\n${failures} FAILED\n` : "\nall badge cases pass\n");
process.exit(failures ? 1 : 0);
