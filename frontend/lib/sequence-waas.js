// Sequence WaaS (Wallet-as-a-Service) integration — LAZY-LOAD edition.
//
// The Sequence SDK is fetched dynamically from esm.sh ONLY when the user
// explicitly clicks "email" / "guest" in the connect modal. Top-level
// imports from esm.sh sometimes fail (CDN hiccups, package version drift,
// CORS in certain dev setups) and historically those failures cascaded into
// wallet.js → shinyluck-sdk.js, breaking the whole frontend (Connect Wallet
// button stops responding, game modules don't run). Lazy-loading isolates
// any Sequence import failure to the connect flow itself.

import { ethers } from "https://esm.sh/ethers@6.13.2";
import { CONFIG } from "./config.js";
import { CHAINS } from "./shinyluck-sdk.js";

const PROJECT_ACCESS_KEY =
  (typeof window !== "undefined" && window.SL_SEQUENCE_CONFIG?.projectAccessKey) ||
  "AQAAAAAAAL_u2xC8rhJ9sUErkLRu6z95r7g";
const WAAS_CONFIG_KEY =
  (typeof window !== "undefined" && window.SL_SEQUENCE_CONFIG?.waasConfigKey) ||
  "eyJwcm9qZWN0SWQiOjQ5MTM0LCJycGNTZXJ2ZXIiOiJodHRwczovL3dhYXMuc2VxdWVuY2UuYXBwIn0=";

const CHAIN = CHAINS[CONFIG.network] || CHAINS.somniaTestnet;
const CHAIN_ID = CHAIN.chainId;

let _waas = null;
let _waasModulePromise = null;
let _waasInitErr = null;

/// Lazy-load the @0xsequence/waas package from esm.sh. Each call returns the
/// same promise so we don't re-fetch on every interaction.
async function loadSequenceModule() {
  if (_waasModulePromise) return _waasModulePromise;
  _waasModulePromise = (async () => {
    try {
      const mod = await import("https://esm.sh/@0xsequence/waas@1.13.4");
      return mod;
    } catch (e) {
      _waasInitErr = e;
      console.error("[sequence] dynamic import failed:", e);
      throw e;
    }
  })();
  return _waasModulePromise;
}

export async function initSequence() {
  if (_waas) return _waas;
  const mod = await loadSequenceModule();
  const { SequenceWaaS } = mod;
  try {
    _waas = new SequenceWaaS({
      projectAccessKey: PROJECT_ACCESS_KEY,
      waasConfigKey:    WAAS_CONFIG_KEY,
      network:          CHAIN_ID,
    });
    return _waas;
  } catch (e) {
    _waasInitErr = e;
    console.error("[sequence] init failed:", e);
    throw e;
  }
}

/// Best-effort session check — quietly returns false if Sequence isn't even
/// loadable (offline / CDN down / package missing). The auto-connect path
/// in wallet.js calls this on every page load, so failure must be silent.
export async function isSequenceSession() {
  try {
    const w = await initSequence();
    return await w.isSignedIn();
  } catch (_) {
    return false;
  }
}

export async function signInGuest() {
  const w = await initSequence();
  await w.signIn({ guest: true }, "ShinyLuck guest");
  return await w.getAddress();
}

export async function signInEmail(email, onCode) {
  const w = await initSequence();
  w.onEmailAuthCodeRequired(async (respondWithCode) => {
    const code = await onCode();
    await respondWithCode(code);
  });
  await w.signIn({ email }, "ShinyLuck email");
  return await w.getAddress();
}

export async function signInOAuthIdToken(idToken, sessionName = "ShinyLuck OAuth") {
  const w = await initSequence();
  await w.signIn({ idToken }, sessionName);
  return await w.getAddress();
}

export async function signOutSequence() {
  if (!_waas) return;
  try { await _waas.dropSession(); } catch (_) {}
  _waas = null;
}

export async function sequenceAddress() {
  try {
    const w = await initSequence();
    return await w.getAddress();
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// ethers Signer adapter — wraps SequenceWaaS so existing Contract code works.
// ---------------------------------------------------------------------------

class SequenceSigner extends ethers.AbstractSigner {
  constructor(waas, provider, address) {
    super(provider);
    this._waas = waas;
    this._address = address;
  }
  connect(provider) {
    return new SequenceSigner(this._waas, provider, this._address);
  }
  async getAddress() { return this._address; }
  async getNonce()   { return await this.provider.getTransactionCount(this._address); }
  async signMessage(message) {
    const msg = typeof message === "string" ? message : ethers.hexlify(message);
    const r = await this._waas.signMessage({ chainId: CHAIN_ID, message: msg });
    return r.signature || r;
  }
  async signTypedData() {
    throw new Error("SequenceSigner.signTypedData not implemented");
  }
  async signTransaction() {
    throw new Error("Sequence relays transactions — use sendTransaction()");
  }
  async sendTransaction(tx) {
    const value = tx.value != null ? tx.value.toString() : "0";
    const result = await this._waas.sendTransaction({
      chainId: CHAIN_ID,
      transactions: [{ to: tx.to, value, data: tx.data || "0x" }],
    });
    const txHash = result.txHash || result.transactionHash || result.hash || result.receipt?.txnHash;
    if (!txHash) throw new Error("Sequence returned no txHash: " + JSON.stringify(result));
    const txResponse = await this.provider.getTransaction(txHash);
    if (txResponse) return txResponse;
    return {
      hash: txHash,
      from: this._address,
      to: tx.to,
      wait: async (confirms = 1) => this.provider.waitForTransaction(txHash, confirms, 60_000),
    };
  }
}

export async function getSequenceSigner(provider) {
  let w;
  try { w = await initSequence(); } catch (_) { return null; }
  try {
    if (!(await w.isSignedIn())) return null;
  } catch (_) { return null; }
  const addr = await w.getAddress();
  if (!provider) provider = new ethers.JsonRpcProvider(CHAIN.rpcUrls[0]);
  return new SequenceSigner(w, provider, addr);
}

export async function sendNative(to, valueWei) {
  const w = await initSequence();
  const r = await w.sendTransaction({
    chainId: CHAIN_ID,
    transactions: [{ to, value: valueWei.toString(), data: "0x" }],
  });
  return r.txHash || r.transactionHash || r.hash;
}
