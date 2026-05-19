// Wallet wiring — Privy is the DEFAULT and only path shown to normal users.
// MetaMask is hidden behind the URL flag `?devWallet=metamask` (dev only) so
// production demo users see exactly one option: email login → Somnia Global
// Wallet. This is what makes the hackathon UX "no extension required" — and
// it's the path docs.somnia.network recommends for partner apps.
//
//   1) Privy (default): cross-app login to the Somnia Provider App via email
//      magic link, then headless on-chain txs (no per-tx popup). The Privy
//      React shell lives in `frontend/vendor/privy.bundle.js` and publishes
//      auth state + sendTransaction onto `window.ShinyLuckAuth`. This file
//      wraps that with an ethers Signer (PrivySigner) so the existing
//      ShinyLuck SDK works unchanged.
//   2) MetaMask (dev only, opt-in via `?devWallet=metamask`): preserved for
//      contract debugging. NOT auto-attached. NOT visible in modal unless the
//      query flag is present. Never used as a silent fallback.
//
// On every page load we:
//   - wait for `shinyluck:auth-state` from the Privy bundle (ready=true)
//   - if Privy reports authenticated → silently attach a PrivySigner
//   - else if devWallet=metamask AND user previously chose MetaMask → auto-MM
//   - else → wait for an explicit "Connect Wallet" click

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { ShinyLuck, CHAINS } from "./shinyluck-sdk.js";
import { CONFIG } from "./config.js";
import { PrivySigner } from "./privy-signer.js";

// MetaMask path is opt-in via URL. Use a function so it's re-evaluated on
// each `connect()` call — easier to flip during dev without a reload.
function devWalletEnabled() {
  try {
    const p = new URLSearchParams(window.location.search);
    return p.get("devWallet") === "metamask";
  } catch (_) { return false; }
}

const network = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;

export const SL = new ShinyLuck({
  casino:   CONFIG.casino,
  registry: CONFIG.registry,
  network,
});

let connected = false;
let backend = null;          // "privy" | "metamask"
let lastConnectedAddr = null; // remembered for late chrome injection (nav loads after autoConnect)
const STORAGE_KEY = "shinyluck.autoConnect"; // "metamask" — Privy persists its own session

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
  try { if (backendName === "metamask") localStorage.setItem(STORAGE_KEY, backendName); } catch (_) {}
  document.dispatchEvent(new CustomEvent("shinyluck:connected", { detail: { address: addr, backend: backendName } }));
  markButtonsConnected(addr);
}

// If autoConnect resolved before partials.js mounted the nav, the wallet
// button was never updated. Re-paint when partials signals it's done.
document.addEventListener("shinyluck:chrome-ready", () => {
  if (connected && lastConnectedAddr) markButtonsConnected(lastConnectedAddr);
});

// Safety net: any open connect modal should close as soon as we are
// connected, even if the modal's own click-handler didn't resolve in time
// (e.g. user dismissed before async login completed; or `shinyluck:connected`
// fires from a different path than the modal's await).
document.addEventListener("shinyluck:connected", () => {
  document.querySelectorAll(".sl-conn-mask").forEach((m) => m.remove());
});

// ---------------------------------------------------------------------------
// Privy path
// ---------------------------------------------------------------------------

function attachPrivySigner() {
  const auth = window.ShinyLuckAuth;
  if (!auth || !auth.ready || !auth.authenticated || !auth.address) {
    throw new Error("Privy not authenticated");
  }
  const ro = new ethers.JsonRpcProvider(network.rpcUrls[0]);
  // Lower polling from ethers' 4000ms default to 1000ms so casino.on(
  // "BetSettled") fires within ~1s of the event landing on chain (instead of
  // ~4s). Trade-off: 4× more eth_getLogs calls, but acceptable on Somnia
  // testnet RPS budget and *required* for the "click → result" loop to feel
  // instant.
  ro.pollingInterval = 1000;
  SL.provider = ro;
  SL.signer = new PrivySigner(auth.address, ro);
  SL.address = auth.address;
  SL._rebuildContracts();
}

// Show the deposit modal automatically when a freshly-connected Privy wallet
// has zero STT — guides the user through funding the embedded wallet.
async function maybePromptDeposit() {
  if (backend !== "privy") return;
  if (!SL.address || !SL.provider) return;
  try {
    const bal = await SL.provider.getBalance(SL.address);
    if (bal > 0n) return;
    const { showDepositModal } = await import("./deposit-modal.js");
    const minBet = ethers.parseEther("0.001"); // smallest sensible game bet
    await showDepositModal({
      address: SL.address,
      provider: SL.provider,
      minBalance: minBet,
      network,
    });
  } catch (e) { console.warn("[wallet] deposit modal failed:", e.message); }
}

document.addEventListener("shinyluck:connected", (ev) => {
  if (ev.detail?.backend === "privy") {
    // Defer to next tick so the connection event listeners run first
    setTimeout(maybePromptDeposit, 50);
  }
});

async function connectPrivy() {
  const auth = window.ShinyLuckAuth;
  if (!auth) throw new Error("Privy bundle not loaded — check that /vendor/privy.bundle.js is served");
  if (!auth.ready) {
    // Wait for the bundle to bootstrap (max 8s) — first paint can race auth.
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { document.removeEventListener("shinyluck:auth-state", on); reject(new Error("Privy bootstrap timeout")); }, 8000);
      function on() {
        if (window.ShinyLuckAuth?.ready) {
          clearTimeout(t);
          document.removeEventListener("shinyluck:auth-state", on);
          resolve();
        }
      }
      document.addEventListener("shinyluck:auth-state", on);
    });
  }
  if (!window.ShinyLuckAuth.authenticated) {
    // Triggers Privy's hosted email magic-link UI.
    await window.ShinyLuckAuth.login();
  }
  // Wait for authenticated AND a resolved embedded address. The address may
  // populate AFTER authenticated=true (Privy creates the embedded wallet
  // asynchronously, especially when migrating from a cached cross-app session).
  // AuthBridge in privy-entry.jsx self-heals via useCreateWallet() — we just
  // wait for the auth-state event with both fields set.
  if (!window.ShinyLuckAuth.authenticated || !window.ShinyLuckAuth.address) {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => { document.removeEventListener("shinyluck:auth-state", on); reject(new Error("Privy auth timeout (no embedded address after 120s)")); }, 120_000);
      function on(ev) {
        if (ev.detail?.authenticated && ev.detail.address) {
          clearTimeout(t);
          document.removeEventListener("shinyluck:auth-state", on);
          resolve();
        }
      }
      document.addEventListener("shinyluck:auth-state", on);
      // Fast-path: if state already correct (event fired before we attached), resolve now.
      if (window.ShinyLuckAuth?.authenticated && window.ShinyLuckAuth?.address) {
        clearTimeout(t);
        document.removeEventListener("shinyluck:auth-state", on);
        resolve();
      }
    });
  }
  attachPrivySigner();
  dispatchConnected(SL.address, "privy");
  return SL.address;
}

// ---------------------------------------------------------------------------
// MetaMask path
// ---------------------------------------------------------------------------

async function connectMetaMask() {
  if (!window.ethereum) throw new Error("No injected wallet detected. Install MetaMask or use the email option.");
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
// Auto-connect on page load
// ---------------------------------------------------------------------------

async function tryAutoConnect() {
  // 1. Wait briefly for Privy bundle to publish auth state, then check session.
  let privyReady = window.ShinyLuckAuth?.ready === true;
  if (!privyReady) {
    privyReady = await new Promise((resolve) => {
      const t = setTimeout(() => { document.removeEventListener("shinyluck:auth-state", on); resolve(false); }, 3000);
      function on() {
        if (window.ShinyLuckAuth?.ready) {
          clearTimeout(t);
          document.removeEventListener("shinyluck:auth-state", on);
          resolve(true);
        }
      }
      document.addEventListener("shinyluck:auth-state", on);
    });
  }
  if (privyReady && window.ShinyLuckAuth?.authenticated && window.ShinyLuckAuth?.address) {
    try {
      attachPrivySigner();
      dispatchConnected(SL.address, "privy");
      return;
    } catch (e) { console.warn("[wallet] privy auto-restore failed:", e.message); }
  }

  // 2. MetaMask auto-restore — only if the dev opted in via `?devWallet=metamask`
  //    AND a prior session stored the preference. Otherwise we never touch
  //    window.ethereum (no silent fallback that would surprise normal users).
  if (!devWalletEnabled()) return;
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

// Also re-attach when Privy finishes login after we've already booted.
document.addEventListener("shinyluck:auth-state", (ev) => {
  if (connected) return;
  if (ev.detail?.authenticated && ev.detail.address) {
    try {
      attachPrivySigner();
      dispatchConnected(SL.address, "privy");
    } catch (e) { /* not fully ready yet */ }
  }
});

// ---------------------------------------------------------------------------
// Public connect()
// ---------------------------------------------------------------------------

export async function connect() {
  if (connected) return SL.address;
  // If Privy already authed, attach silently.
  if (window.ShinyLuckAuth?.ready && window.ShinyLuckAuth.authenticated && window.ShinyLuckAuth.address) {
    attachPrivySigner();
    dispatchConnected(SL.address, "privy");
    return SL.address;
  }
  const addr = await showConnectModal();
  return addr;
}

export async function ensureConnected() {
  if (connected) return;
  await connect();
}

export async function signOut() {
  try { await window.ShinyLuckAuth?.logout(); } catch (_) {}
  try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
  connected = false;
  backend = null;
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
    .sl-conn-close { float: right; background: transparent; border: 1px solid var(--line); color: var(--fg-mute); padding: 4px 10px; cursor: pointer; }
    .sl-conn-err { color: #dc2626; font-size: 11px; margin-top: 8px; }
    .sl-conn-foot { font-size: 10px; color: var(--fg-mute); margin-top: 16px; letter-spacing: 1px; text-transform: uppercase; }
  `;
  document.head.appendChild(s);
}

function showConnectModal() {
  injectModalCSSOnce();
  const showMM = devWalletEnabled();
  return new Promise((resolve, reject) => {
    const mask = document.createElement("div");
    mask.className = "sl-conn-mask";
    mask.innerHTML = `
      <div class="sl-conn-box">
        <button class="sl-conn-close" data-close>close ✕</button>
        <h3>Connect to ShinyLuck</h3>
        <p>Sign in by email to get a Somnia Global Wallet — the same wallet
           works across every Somnia-partner app, no extension required.</p>
        <div data-stage="root">
          <button class="sl-conn-btn primary" data-action="email">📧 Continue with Email (Privy)</button>
          ${showMM ? '<button class="sl-conn-btn" data-action="metamask">🦊 Connect MetaMask (dev)</button>' : ''}
          <div class="sl-conn-foot">Powered by Privy · Somnia Global Wallet · network: ${network.chainName}</div>
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
    const setErr = (txt) => { const el = mask.querySelector("[data-err]"); if (el) el.textContent = txt || ""; };
    const setLoading = (msg) => { mask.querySelector("[data-loading-msg]").textContent = msg; showStage("loading"); };

    const close = (err, addr) => {
      mask.remove();
      if (err) reject(err);
      else resolve(addr);
    };

    mask.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.dataset.close !== undefined) return close(new Error("user cancelled"));
      const action = t.dataset.action;
      if (!action) return;
      if (action === "email") {
        setLoading("Opening Privy login…");
        try { const addr = await connectPrivy(); close(null, addr); }
        catch (err) { console.error(err); setErr(err.message); showStage("root"); }
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
    const ok = await confirmDialog("This will sign out of your Privy session.", {
      title: "Disconnect wallet",
      yes: "Disconnect",
      no:  "Stay connected",
      danger: true,
    });
    if (ok) {
      await signOut();
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
