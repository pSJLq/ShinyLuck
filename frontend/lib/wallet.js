// Wallet wiring — supports two backends:
//   1) Sequence WaaS (primary): email / social / guest login. The signer is
//      created via getSequenceSigner() and uses Sequence's relayer under the
//      hood — no MetaMask popup, no gas dance, no chain-switching prompts.
//   2) MetaMask injected EIP-1193 (fallback): the original flow, kept for
//      developers and power-users who already have a wallet.
//
// On every page load we first ask Sequence "are you signed in?" — if yes,
// we silently restore the session and dispatch `shinyluck:connected`. If
// no Sequence session, and the user previously chose MetaMask (flag in
// localStorage), we attempt MetaMask auto-connect.
//
// Connect modal (this file injects it on demand): three buttons —
//   • Continue with email → OTP popup
//   • Continue as guest   → instant ephemeral wallet
//   • Connect MetaMask    → original injected flow

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { ShinyLuck, CHAINS } from "./shinyluck-sdk.js";
import { CONFIG } from "./config.js";
import {
  initSequence,
  isSequenceSession,
  signInGuest,
  signInEmail,
  getSequenceSigner,
  signOutSequence,
} from "./sequence-waas.js";

const network = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;

export const SL = new ShinyLuck({
  casino:   CONFIG.casino,
  registry: CONFIG.registry,
  network,
});

let connected = false;
let backend = null;          // "sequence" | "metamask"
let lastConnectedAddr = null; // remembered for late chrome injection (nav loads after autoConnect)
const STORAGE_KEY = "shinyluck.autoConnect"; // "metamask" or "sequence"

export function shortAddr(a) {
  if (!a) return "";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function markButtonsConnected(addr) {
  document.querySelectorAll("[data-wallet-btn]").forEach((btn) => {
    btn.textContent = shortAddr(addr);
    btn.classList.add("connected");
  });
}

function dispatchConnected(addr, backendName) {
  connected = true;
  backend = backendName;
  lastConnectedAddr = addr;
  try { localStorage.setItem(STORAGE_KEY, backendName); } catch (_) {}
  document.dispatchEvent(new CustomEvent("shinyluck:connected", { detail: { address: addr, backend: backendName } }));
  markButtonsConnected(addr);
}

// If autoConnect resolved before partials.js mounted the nav, the wallet
// button was never updated. Re-paint when partials signals it's done.
document.addEventListener("shinyluck:chrome-ready", () => {
  if (connected && lastConnectedAddr) markButtonsConnected(lastConnectedAddr);
});

// ---------------------------------------------------------------------------
// MetaMask path
// ---------------------------------------------------------------------------

async function connectMetaMask() {
  if (!window.ethereum) throw new Error("No injected wallet detected. Install MetaMask or use the email / guest options.");
  await SL.connect();           // SL.connect() handles switchToSomnia + signer + contract rebuild
  dispatchConnected(SL.address, "metamask");

  window.ethereum.on?.("accountsChanged", (accs) => {
    if (!accs || accs.length === 0) {
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    }
    location.reload();
  });
  window.ethereum.on?.("chainChanged", () => location.reload());
  return SL.address;
}

// ---------------------------------------------------------------------------
// Sequence path
// ---------------------------------------------------------------------------

async function attachSequenceSigner() {
  // Use a read-only JsonRpcProvider as the network anchor for the Sequence
  // signer (waas relays the actual tx, but ethers needs a Provider it can
  // poll for receipts and reads).
  const ro = new ethers.JsonRpcProvider(network.rpcUrls[0]);
  const signer = await getSequenceSigner(ro);
  if (!signer) throw new Error("Sequence session not found");
  SL.provider = ro;
  SL.signer = signer;
  SL.address = await signer.getAddress();
  SL._rebuildContracts();
}

async function connectSequenceGuest() {
  await initSequence();
  await signInGuest();
  await attachSequenceSigner();
  dispatchConnected(SL.address, "sequence");
  return SL.address;
}

async function connectSequenceEmail(email, onCode) {
  await initSequence();
  await signInEmail(email, onCode);
  await attachSequenceSigner();
  dispatchConnected(SL.address, "sequence");
  return SL.address;
}

// ---------------------------------------------------------------------------
// Auto-connect on page load
// ---------------------------------------------------------------------------

async function tryAutoConnect() {
  // First, see if Sequence has a persistent session.
  if (await isSequenceSession()) {
    try {
      await attachSequenceSigner();
      dispatchConnected(SL.address, "sequence");
      return;
    } catch (e) { console.warn("[wallet] sequence auto-restore failed:", e.message); }
  }
  // Otherwise, was the user previously on MetaMask?
  let pref = null;
  try { pref = localStorage.getItem(STORAGE_KEY); } catch (_) {}
  if (pref !== "metamask" || !window.ethereum) return;
  try {
    const accs = await window.ethereum.request({ method: "eth_accounts" });
    if (accs && accs.length > 0) {
      await connectMetaMask();
    }
  } catch (e) {
    console.warn("[wallet] mm auto-connect failed:", e.message);
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Public connect()
// ---------------------------------------------------------------------------

export async function connect() {
  if (connected) return SL.address;
  // Already have a Sequence session? Re-attach silently.
  if (await isSequenceSession()) {
    await attachSequenceSigner();
    dispatchConnected(SL.address, "sequence");
    return SL.address;
  }
  // Otherwise, show the connect modal and let the user pick.
  const addr = await showConnectModal();
  return addr;
}

export async function ensureConnected() {
  if (connected) return;
  await connect();
}

// ---------------------------------------------------------------------------
// Connect modal (injected on first call)
// ---------------------------------------------------------------------------

function injectModalCSSOnce() {
  if (document.getElementById("sl-connect-modal-style")) return;
  const s = document.createElement("style");
  s.id = "sl-connect-modal-style";
  s.textContent = `
    .sl-conn-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.78); backdrop-filter: blur(8px); z-index: 9000; display: flex; align-items: center; justify-content: center; padding: 24px; font-family: "JetBrains Mono", monospace; }
    .sl-conn-box  { background: var(--bg-1, #0f0f12); border: 1px solid var(--line, #1f1f23); max-width: 420px; width: 100%; padding: 28px; color: var(--fg, #fafafa); }
    .sl-conn-box h3 { margin: 0 0 8px; font-size: 18px; letter-spacing: -0.5px; }
    .sl-conn-box p  { margin: 0 0 18px; font-size: 12px; color: var(--fg-mute, #6b6b75); line-height: 1.5; }
    .sl-conn-btn  { display: block; width: 100%; padding: 12px; margin-bottom: 8px; background: transparent; color: var(--fg, #fafafa); border: 1px solid var(--line, #1f1f23); cursor: pointer; font-family: inherit; font-size: 13px; letter-spacing: 1px; text-align: left; }
    .sl-conn-btn:hover { border-color: var(--cyan, #22D3EE); color: var(--cyan, #22D3EE); }
    .sl-conn-btn.primary { background: var(--cyan, #22D3EE); color: #000; }
    .sl-conn-input { width: 100%; padding: 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--line, #1f1f23); color: var(--fg, #fafafa); font-family: inherit; font-size: 13px; margin-bottom: 8px; box-sizing: border-box; }
    .sl-conn-close { float: right; background: transparent; border: 1px solid var(--line); color: var(--fg-mute); padding: 4px 10px; cursor: pointer; }
    .sl-conn-err { color: #dc2626; font-size: 11px; margin-top: 8px; }
    .sl-conn-foot { font-size: 10px; color: var(--fg-mute); margin-top: 16px; letter-spacing: 1px; text-transform: uppercase; }
  `;
  document.head.appendChild(s);
}

function showConnectModal() {
  injectModalCSSOnce();
  return new Promise((resolve, reject) => {
    const mask = document.createElement("div");
    mask.className = "sl-conn-mask";
    mask.innerHTML = `
      <div class="sl-conn-box">
        <button class="sl-conn-close" data-close>close ✕</button>
        <h3>Connect to ShinyLuck</h3>
        <p>Pick a sign-in method. Email gives you a fully-managed wallet
           (no MetaMask required). Guest mode is instant but the wallet is
           lost when you clear your browser. Power users can plug in MetaMask.</p>
        <div data-stage="root">
          <button class="sl-conn-btn primary" data-action="email">📧 Continue with email</button>
          <button class="sl-conn-btn" data-action="guest">👤 Continue as guest</button>
          <button class="sl-conn-btn" data-action="metamask">🦊 Connect MetaMask</button>
          <div class="sl-conn-foot">Powered by Sequence WaaS · network: ${network.chainName}</div>
        </div>
        <div data-stage="email" style="display:none;">
          <p>Enter your email — Sequence will send a one-time code.</p>
          <input class="sl-conn-input" type="email" data-email placeholder="you@example.com" autofocus />
          <button class="sl-conn-btn primary" data-action="email-submit">Send code →</button>
          <button class="sl-conn-btn" data-action="back">← back</button>
          <div class="sl-conn-err" data-err></div>
        </div>
        <div data-stage="otp" style="display:none;">
          <p>We sent a 6-digit code to <b data-email-disp></b>. Enter it below.</p>
          <input class="sl-conn-input" type="text" data-otp placeholder="123456" maxlength="6" autofocus />
          <button class="sl-conn-btn primary" data-action="otp-submit">Verify →</button>
          <div class="sl-conn-err" data-err></div>
        </div>
        <div data-stage="loading" style="display:none;">
          <p data-loading-msg>Connecting…</p>
        </div>
      </div>
    `;
    document.body.appendChild(mask);

    const showStage = (name) => {
      mask.querySelectorAll("[data-stage]").forEach((el) => {
        el.style.display = el.dataset.stage === name ? "block" : "none";
      });
    };
    const setErr = (txt) => { mask.querySelector("[data-err]").textContent = txt || ""; };
    const setLoading = (msg) => { mask.querySelector("[data-loading-msg]").textContent = msg; showStage("loading"); };

    const close = (err, addr) => {
      mask.remove();
      if (err) reject(err);
      else resolve(addr);
    };

    let otpResolver = null;

    mask.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.dataset.close !== undefined) return close(new Error("user cancelled"));
      const action = t.dataset.action;
      if (!action) return;
      if (action === "guest") {
        setLoading("Creating guest wallet…");
        try { const addr = await connectSequenceGuest(); close(null, addr); }
        catch (err) { console.error(err); setErr(err.message); showStage("root"); }
      } else if (action === "email") {
        showStage("email");
      } else if (action === "back") {
        showStage("root");
      } else if (action === "email-submit") {
        const email = mask.querySelector("[data-email]").value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setErr("Invalid email"); return; }
        mask.querySelector("[data-email-disp]").textContent = email;
        showStage("otp");
        try {
          await connectSequenceEmail(email, () => new Promise((r) => { otpResolver = r; }));
          close(null, SL.address);
        } catch (err) { console.error(err); setErr(err.message); showStage("email"); }
      } else if (action === "otp-submit") {
        const code = mask.querySelector("[data-otp]").value.trim();
        if (!/^\d{6}$/.test(code)) { setErr("Enter a 6-digit code"); return; }
        setLoading("Verifying…");
        if (otpResolver) otpResolver(code);
      } else if (action === "metamask") {
        setLoading("Opening MetaMask…");
        try { const addr = await connectMetaMask(); close(null, addr); }
        catch (err) { console.error(err); setErr(err.message); showStage("root"); }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Click handlers
// ---------------------------------------------------------------------------

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-wallet-btn]");
  if (!btn) return;
  e.preventDefault();
  if (btn.classList.contains("connected")) {
    const { confirmDialog, toast } = await import("./ui.js");
    const ok = await confirmDialog("This will sign out of your Sequence session.", {
      title: "Disconnect wallet",
      yes: "Disconnect",
      no:  "Stay connected",
      danger: true,
    });
    if (ok) {
      try { await signOutSequence(); } catch (_) {}
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      toast("Wallet disconnected", { kind: "info" });
      setTimeout(() => location.reload(), 600);
    }
    return;
  }
  try {
    btn.textContent = "Connecting…";
    const addr = await connect();
    btn.textContent = shortAddr(addr);
    btn.classList.add("connected");
  } catch (err) {
    btn.textContent = "Connect Wallet";
    if (err.message !== "user cancelled") {
      const { toast } = await import("./ui.js");
      toast("Connect failed: " + (err.message || err), { kind: "error", ttl: 5000 });
    }
  }
});

/// "Account" nav link → own profile when connected (canonical query form).
document.addEventListener("click", (e) => {
  const a = e.target.closest('a[data-page="account"]');
  if (!a) return;
  if (!connected || !SL.address) return;
  e.preventDefault();
  e.stopPropagation();
  const inGames = location.pathname.includes("/games/");
  const prefix = inGames ? "../" : "";
  window.location.href = `${prefix}account.html?address=${SL.address.toLowerCase()}`;
}, true);

document.addEventListener("DOMContentLoaded", () => {
  tryAutoConnect().catch(() => {});
});

export { backend };
