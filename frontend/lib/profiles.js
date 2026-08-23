/* ============================================================================
   Shared on-chain profile resolver (nickname + avatar) for feed/lobby UI.
   Same contracts ShinyPoker uses: PlayerProfile (handles) + AvatarStore
   (raw image bytes on-chain). Addresses without a custom avatar get the
   casino's round spark logo; without a handle · the short 0x address.
   Batched + cached (memory & localStorage, 30 min TTL).
   ========================================================================== */

import { ethers } from "/vendor/ethers.bundle.js";
import { provider } from "./rpc.js";

const PP_ADDR = "0x7364E1ED8a07b4659c059fa66D346c42907C3F14";
const AV_ADDR = "0x20c39988b480485aD2a9715c32Ff1866Ea890Ec4";
const PP_ABI = ["function profileOf(address) view returns (string handle,uint16 avatar,uint64 since)"];
const AV_ABI = ["function avatarOf(address) view returns (bytes)"];

export const DEFAULT_AVATAR = "/assets/favicon.png";

const CACHE_KEY = "sl.profiles.v1";
const TTL_MS = 30 * 60 * 1000;

let _pp = null, _av = null;
function pp() { return _pp || (_pp = new ethers.Contract(PP_ADDR, PP_ABI, provider())); }
function av() { return _av || (_av = new ethers.Contract(AV_ADDR, AV_ABI, provider())); }

const mem = new Map(); // addrLower -> { handle, img, t }
let stored = null;
function loadStored() {
  if (stored) return stored;
  try { stored = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch (_) { stored = {}; }
  return stored;
}
function persist() {
  try {
    const o = {};
    for (const [k, v] of mem) o[k] = v;
    localStorage.setItem(CACHE_KEY, JSON.stringify(o));
  } catch (_) {}
}

const BUMP_KEY = "sl.profiles.bump";

/// Drop a cached profile so the next resolve re-reads the chain.
/// The 30-min TTL is right for other players but wrong for yourself: you change
/// your avatar, and every feed keeps serving the old one for half an hour --
/// including wins you have not even played yet.
export function invalidateProfile(addr) {
  if (!addr) return;
  const a = String(addr).toLowerCase();
  mem.delete(a);
  const st = loadStored();
  delete st[a];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(st));
    // The poker table is an iframe on this same origin · a storage write is how
    // an avatar edited in its cashier reaches the casino's feeds outside it.
    localStorage.setItem(BUMP_KEY, a + ":" + Date.now());
  } catch (_) {}
  announce(a);
}

function announce(a) {
  try {
    window.dispatchEvent(new CustomEvent("shinyluck:profile-changed", { detail: { addr: a } }));
  } catch (_) {}
}

// Another frame or tab changed a profile -> forget ours and let the UI repaint.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== BUMP_KEY || !e.newValue) return;
    const a = String(e.newValue).split(":")[0];
    mem.delete(a);
    stored = null;
    // The writer may only have bumped (poker's cashier does) · clear the
    // persisted row too, or loadStored() resurrects the very entry we dropped.
    const st = loadStored();
    if (st[a]) {
      delete st[a];
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(st)); } catch (_) {}
    }
    announce(a);
  });
}

export const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a || "-"));

function bytesToDataUrl(raw) {
  if (!raw || raw.length < 8) return null;
  let mime = "image/jpeg";
  if (raw[0] === 0x89 && raw[1] === 0x50) mime = "image/png";
  if (raw[0] === 0x47 && raw[1] === 0x49) mime = "image/gif";
  let bin = "";
  for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
  return `data:${mime};base64,${btoa(bin)}`;
}

async function fetchOne(addr) {
  const out = { handle: "", img: null, t: Date.now() };
  try {
    const p = await pp().profileOf(addr);
    out.handle = p.handle || "";
  } catch (_) {}
  try {
    const raw = ethers.getBytes(await av().avatarOf(addr));
    out.img = bytesToDataUrl(raw);
  } catch (_) {}
  return out;
}

const inflight = new Map();

/// Resolve profiles for a set of addresses.
/// → Map(addrLower → { handle, img, name, avatar })
///   name   = handle or the short address
///   avatar = data-url or the default round logo
export async function resolveProfiles(addrs) {
  const now = Date.now();
  const uniq = [...new Set((addrs || []).filter(Boolean).map((a) => a.toLowerCase()))];
  const st = loadStored();
  const need = [];
  for (const a of uniq) {
    if (mem.has(a) && now - mem.get(a).t < TTL_MS) continue;
    const s = st[a];
    if (s && now - s.t < TTL_MS) { mem.set(a, s); continue; }
    need.push(a);
  }
  if (need.length) {
    await Promise.all(need.map((a) => {
      if (inflight.has(a)) return inflight.get(a);
      const p = fetchOne(a).then((v) => { mem.set(a, v); inflight.delete(a); }).catch(() => inflight.delete(a));
      inflight.set(a, p);
      return p;
    }));
    persist();
  }
  const res = new Map();
  for (const a of uniq) {
    const v = mem.get(a) || { handle: "", img: null };
    res.set(a, {
      handle: v.handle || "",
      img: v.img || null,
      name: v.handle || shortAddr(a),
      avatar: v.img || DEFAULT_AVATAR,
    });
  }
  return res;
}
