/* ============================================================================
   Unified profile (casino + poker) for the v2 shell.
   - Connect button: label shows live STT balance when connected; click opens
     the profile drawer (or the Privy connect modal when signed out).
   - Drawer: wallet balance / deposit address / STT withdraw, poker bankroll
     (PokerRoom.deposit / .withdraw), on-chain nickname (PlayerProfile) and
     on-chain avatar (AvatarStore) · the same contracts ShinyPoker uses, so
     the profile is one and the same across both products.
   ========================================================================== */

import { ethers } from "/vendor/ethers.bundle.js";
import { SL, connect, signOut, shortAddr } from "/lib/wallet.js";
import { POKER_CONFIG } from "/poker/poker-config.js";
import { CONFIG } from "/lib/config.js";
import { invalidateProfile } from "/lib/profiles.js";

// Casino wins are pull-payment: the contract credits pendingWithdrawals and the
// player pulls with claim(). Roulette auto-claims after a spin, the rest don't ·
// so without this the money just sits there looking like it vanished.
const CASINO_ABI = [
  "function pendingWithdrawals(address) view returns (uint256)",
  "function claim()",
];

const ROOM_ABI = [
  "function balance(address) view returns (uint256)",
  "function deposit() payable",
  "function withdraw(uint256 amount)",
];
const PP_ABI = [
  "function setProfile(string handle,uint16 avatar)",
  "function profileOf(address) view returns (string handle,uint16 avatar,uint64 since)",
  "function handleAvailable(string) view returns (bool)",
];
const AV_ABI = [
  "function setAvatar(bytes data)",
  "function avatarOf(address) view returns (bytes)",
];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let connected = false;
let myProfile = { handle: "", avatar: 0 };
let avatarUrl = null;
let pollTimer = null;

const fmtBal = (wei) => {
  const n = Number(ethers.formatEther(wei));
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 1 }) : n.toFixed(n >= 1 ? 2 : 4).replace(/\.?0+$/, "") || "0";
};

function contracts(write) {
  const runner = write ? SL.signer : SL.provider;
  return {
    casino: new ethers.Contract(CONFIG.casino, CASINO_ABI, runner),
    room: new ethers.Contract(POKER_CONFIG.pokerRoom, ROOM_ABI, runner),
    pp: POKER_CONFIG.playerProfile ? new ethers.Contract(POKER_CONFIG.playerProfile, PP_ABI, runner) : null,
    av: POKER_CONFIG.avatarStore ? new ethers.Contract(POKER_CONFIG.avatarStore, AV_ABI, runner) : null,
  };
}

function setMsg(sel, text, ok) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("ok", !!ok);
  el.classList.toggle("err", !ok && !!text);
  if (text) setTimeout(() => { if (el.textContent === text) { el.textContent = ""; el.classList.remove("ok", "err"); } }, 6000);
}

/* ---------------- paint ---------------- */

async function refreshBalances() {
  if (!connected || !SL.address || !SL.provider) return;
  try {
    const [bal, pbal] = await Promise.all([
      SL.provider.getBalance(SL.address),
      contracts(false).room.balance(SL.address).catch(() => 0n),
    ]);
    const w = fmtBal(bal);
    const el = $("[data-wallet-bal]"); if (el) el.textContent = w;
    const pl = $("[data-poker-bal]"); if (pl) pl.textContent = fmtBal(pbal);
    $$("[data-stt-balance]").forEach((n) => { n.textContent = w; });
    const lbl = $("[data-connect-label]");
    if (lbl) lbl.textContent = `${w} STT`;
  } catch (e) { /* transient RPC */ }
  refreshClaimable().catch(() => {});
}

async function refreshClaimable() {
  const box = $("[data-claim-box]");
  if (!box || !connected || !SL.address || !SL.provider) return;
  try {
    const owed = await contracts(false).casino.pendingWithdrawals(SL.address);
    if (owed > 0n) {
      box.style.display = "";
      const el = $("[data-claim-amt]");
      if (el) el.textContent = fmtBal(owed);
    } else {
      box.style.display = "none";
    }
  } catch (_) {}
}

async function refreshProfile() {
  if (!connected || !SL.address) return;
  const { pp, av } = contracts(false);
  try {
    if (pp) {
      const p = await pp.profileOf(SL.address);
      myProfile = { handle: p.handle || "", avatar: Number(p.avatar) || 0 };
    }
  } catch (_) {}
  const nickEl = $("[data-nick-label]");
  if (nickEl) nickEl.textContent = myProfile.handle || shortAddr(SL.address);
  try {
    if (av) {
      const raw = ethers.getBytes(await av.avatarOf(SL.address));
      if (raw && raw.length > 8) {
        let mime = "image/jpeg";
        if (raw[0] === 0x89 && raw[1] === 0x50) mime = "image/png";
        if (raw[0] === 0x47 && raw[1] === 0x49) mime = "image/gif";
        let bin = "";
        for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
        avatarUrl = `data:${mime};base64,${btoa(bin)}`;
      }
    }
  } catch (_) {}
  if (avatarUrl) $$("[data-avatar-img]").forEach((el) => { el.style.backgroundImage = `url('${avatarUrl}')`; });
}

function paintConnected() {
  $$(".nav2-avatar").forEach((el) => el.classList.add("on"));
  const addrEl = $("[data-deposit-addr]");
  if (addrEl) addrEl.textContent = SL.address;
  refreshBalances();
  refreshProfile();
  if (!pollTimer) pollTimer = setInterval(refreshBalances, 12000);
}

document.addEventListener("shinyluck:connected", () => { connected = true; paintConnected(); });
if (SL.address) { connected = true; paintConnected(); }

/* ---------------- drawer open/close ---------------- */

function openDrawer() {
  $("[data-pdrawer-mask]")?.classList.add("on");
  refreshBalances();
  refreshProfile();
}

document.addEventListener("click", async (e) => {
  const t = e.target;

  if (t.closest("[data-connect-btn]")) {
    if (connected) openDrawer();
    else {
      const lbl = $("[data-connect-label]");
      if (lbl) lbl.textContent = "Connecting…";
      try { await connect(); }
      catch (_) { if (lbl) lbl.textContent = "Connect Wallet"; }
    }
    return;
  }
  if (t.closest("[data-avatar-btn]") || t.closest("[data-avatar-btn-mob]")) {
    if (connected) openDrawer();
    else { try { await connect(); } catch (_) {} }
    return;
  }

  if (t.closest("[data-copy-addr]")) {
    try { await navigator.clipboard.writeText(SL.address || ""); } catch (_) {}
    const b = t.closest("[data-copy-addr]");
    const old = b.textContent; b.textContent = "Copied";
    setTimeout(() => { b.textContent = old; }, 1500);
    return;
  }

  /* ---- STT withdraw (wallet → external address) ---- */
  if (t.closest("[data-wdr-go]")) {
    if (!connected) return;
    const dest = ($("[data-wdr-dest]")?.value || "").trim();
    const amt = parseFloat($("[data-wdr-amt]")?.value || "0");
    if (!ethers.isAddress(dest)) return setMsg("[data-wallet-msg]", "Enter a valid 0x address", false);
    if (!(amt > 0)) return setMsg("[data-wallet-msg]", "Enter an amount", false);
    const btn = t.closest("[data-wdr-go]");
    btn.disabled = true;
    try {
      setMsg("[data-wallet-msg]", "Sending…", true);
      const tx = await SL.signer.sendTransaction({ to: dest, value: ethers.parseEther(String(amt)) });
      await tx.wait();
      setMsg("[data-wallet-msg]", "Sent ✓", true);
      $("[data-wdr-amt]").value = ""; $("[data-wdr-dest]").value = "";
      refreshBalances();
    } catch (err) {
      setMsg("[data-wallet-msg]", err.shortMessage || err.message || "failed", false);
    } finally { btn.disabled = false; }
    return;
  }

  /* ---- claim casino winnings (pull-payment) ---- */
  if (t.closest("[data-claim-go]")) {
    if (!connected) return;
    const btn = t.closest("[data-claim-go]");
    btn.disabled = true;
    try {
      setMsg("[data-claim-msg]", "Claiming…", true);
      const tx = await contracts(true).casino.claim();
      await tx.wait();
      setMsg("[data-claim-msg]", "Claimed ✓", true);
      refreshBalances();
    } catch (err) {
      setMsg("[data-claim-msg]", err.shortMessage || err.message || "nothing to claim", false);
    } finally { btn.disabled = false; }
    return;
  }

  /* ---- poker bankroll top-up / withdraw ---- */
  if (t.closest("[data-poker-dep]") || t.closest("[data-poker-wdr]")) {
    if (!connected) return;
    const dep = !!t.closest("[data-poker-dep]");
    const amt = parseFloat($("[data-poker-amt]")?.value || "0");
    if (!(amt > 0)) return setMsg("[data-poker-msg]", "Enter an amount", false);
    const btn = t.closest(dep ? "[data-poker-dep]" : "[data-poker-wdr]");
    btn.disabled = true;
    try {
      setMsg("[data-poker-msg]", dep ? "Depositing…" : "Withdrawing…", true);
      const room = contracts(true).room;
      const tx = dep
        ? await room.deposit({ value: ethers.parseEther(String(amt)) })
        : await room.withdraw(ethers.parseEther(String(amt)));
      await tx.wait();
      setMsg("[data-poker-msg]", dep ? "Topped up ✓" : "Moved to wallet ✓", true);
      $("[data-poker-amt]").value = "";
      refreshBalances();
    } catch (err) {
      setMsg("[data-poker-msg]", err.shortMessage || err.message || "failed", false);
    } finally { btn.disabled = false; }
    return;
  }

  /* ---- nickname ---- */
  if (t.closest("[data-nick-edit]")) {
    $("[data-nick-view]").style.display = "none";
    const f = $("[data-nick-form]"); f.style.display = "flex";
    const inp = $("[data-nick-input]"); inp.value = myProfile.handle || ""; inp.focus();
    return;
  }
  if (t.closest("[data-nick-cancel]")) {
    $("[data-nick-form]").style.display = "none";
    $("[data-nick-view]").style.display = "flex";
    return;
  }
  if (t.closest("[data-nick-save]")) {
    if (!connected) return;
    const v = ($("[data-nick-input]")?.value || "").trim().slice(0, 20);
    if (!v) return setMsg("[data-nick-msg]", "Enter a nickname", false);
    const btn = t.closest("[data-nick-save]");
    btn.disabled = true;
    try {
      setMsg("[data-nick-msg]", "Saving on-chain…", true);
      const pp = contracts(true).pp;
      const tx = await pp.setProfile(v, myProfile.avatar || 0);
      await tx.wait();
      myProfile.handle = v;
      invalidateProfile(SL.address);
      $("[data-nick-label]").textContent = v;
      $("[data-nick-form]").style.display = "none";
      $("[data-nick-view]").style.display = "flex";
      setMsg("[data-nick-msg]", "Saved ✓", true);
    } catch (err) {
      setMsg("[data-nick-msg]", err.shortMessage || err.message || "failed (taken?)", false);
    } finally { btn.disabled = false; }
    return;
  }

  /* ---- avatar upload ---- */
  if (t.closest("[data-avatar-upload]")) {
    if (!connected) { try { await connect(); } catch (_) { return; } }
    $("[data-avatar-file]")?.click();
    return;
  }

  /* ---- disconnect ---- */
  if (t.closest("[data-disconnect]")) {
    await signOut();
    setTimeout(() => location.reload(), 300);
    return;
  }
});

/* avatar file → square crop → JPEG ≤ 8KB → AvatarStore.setAvatar */
document.addEventListener("change", async (e) => {
  const inp = e.target.closest && e.target.closest("[data-avatar-file]");
  if (!inp) return;
  const file = inp.files && inp.files[0];
  inp.value = "";
  if (!file || !connected) return;
  try {
    setMsg("[data-nick-msg]", "Compressing…", true);
    const img = await new Promise((res, rej) => {
      const rd = new FileReader();
      rd.onload = () => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = String(rd.result); };
      rd.onerror = rej;
      rd.readAsDataURL(file);
    });
    const S = 128;
    const cv = document.createElement("canvas");
    cv.width = S; cv.height = S;
    const cx = cv.getContext("2d");
    const m = Math.min(img.width, img.height);
    cx.drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
    let bytes = null;
    for (let q = 0.82; q >= 0.3; q -= 0.13) {
      const url = cv.toDataURL("image/jpeg", q);
      const bin = atob(url.split(",")[1]);
      if (bin.length <= 8000) {
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        break;
      }
    }
    if (!bytes) return setMsg("[data-nick-msg]", "Image too complex · try a simpler one", false);
    setMsg("[data-nick-msg]", "Uploading on-chain…", true);
    const av = contracts(true).av;
    const tx = await av.setAvatar(bytes);
    await tx.wait();
    let bin2 = "";
    for (let i = 0; i < bytes.length; i++) bin2 += String.fromCharCode(bytes[i]);
    avatarUrl = `data:image/jpeg;base64,${btoa(bin2)}`;
    invalidateProfile(SL.address); // feeds cache profiles for 30 min · drop mine now
    $$("[data-avatar-img]").forEach((el) => { el.style.backgroundImage = `url('${avatarUrl}')`; });
    setMsg("[data-nick-msg]", "Avatar saved ✓", true);
  } catch (err) {
    setMsg("[data-nick-msg]", err.shortMessage || err.message || "upload failed", false);
  }
});
