// Reading a money amount that a HUMAN typed.
//
// Every amount field on this site is a plain text input with
// inputmode="decimal", which is the right keyboard — but the decimal key that
// keyboard shows depends on the phone's locale. In Russian (and French, and
// German, and most of Europe) it is a COMMA, and the comma arrives in `.value`
// exactly as typed. Desktop users type a dot and never see any of this, which
// is why it survived so long.
//
// Two different bugs came from the same character:
//   · the poker cashier and the profile drawer ran parseFloat("0,2") → 0 and
//     answered "Enter an amount" to a player who had just typed one;
//   · the casino's stake reader stripped every non-digit, so "0,2" became "02"
//     and the bet placed was TWO STT instead of 0.2 — ten times the money, no
//     warning, phones only.
//
// So amounts are normalized in ONE place, and both the validation and the
// string handed to ethers go through it.
import { ethers } from "/vendor/ethers.bundle.js";

/// "0,2" · " 1 234,56 " · "1.2.3" → "0.2" · "1234.56" · "1.23".
/// Never throws; anything unusable collapses to "0".
export function normalizeAmount(raw) {
  const s = String(raw == null ? "" : raw)
    .replace(/[\s  ]/g, "")   // spaces, NBSP, narrow NBSP (thousands)
    .replace(/[,،٫]/g, ".")   // decimal separators people actually type
    .replace(/[^\d.]/g, "");
  const i = s.indexOf(".");
  if (i < 0) return s || "0";
  // keep the FIRST separator, drop the rest ("1.2.3" is a typo, not an error)
  return (s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, "")) || "0";
}

/// Same, as a number for validation. NaN never escapes — junk is 0.
export function parseAmount(raw) {
  const n = Number(normalizeAmount(raw));
  return Number.isFinite(n) ? n : 0;
}

/// Human amount → wei, for anything that reaches a contract.
export function toWei(raw) {
  return ethers.parseEther(normalizeAmount(raw));
}
