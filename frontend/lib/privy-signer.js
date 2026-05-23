/* ============================================================================
 * privy-signer.js
 *
 * An ethers v6 AbstractSigner that routes every tx / signMessage call through
 * `window.ShinyLuckAuth.sendTransaction` (set up by the React shell in
 * `frontend/vendor/privy.bundle.js` - see `lib/privy-entry.jsx`).
 *
 * Lets the existing `ShinyLuck` SDK (frontend/lib/shinyluck-sdk.js) work
 * unchanged: it just needs an ethers Signer, doesn't care which backend.
 * ========================================================================= */

import { ethers } from "/vendor/ethers.bundle.js";

export class PrivySigner extends ethers.AbstractSigner {
  constructor(address, provider) {
    super(provider);
    this._address = address;

    // Hybrid nonce strategy:
    //   1. Mutex around `_populateFor` so concurrent callers (e.g. auto-claim
    //      after settle racing the next-spin pre-sign) serialise their nonce
    //      reads - pure chain-count reads gave collisions because they ran in
    //      the same async tick before either tx hit mempool.
    //   2. Local increment-after-read: under the mutex, fetch chain count
    //      once, then bump locally per populate. Next populate inside the
    //      mutex uses the bumped value without another RPC.
    //   3. Periodic resync (every 30 s) and on any broadcast failure
    //      (sendTransaction's catch sets `_lastChainSyncAt = 0`) so a tx
    //      that never made it to mempool doesn't leave us with a permanent
    //      nonce gap.
    //
    // Fee cache is unchanged - TTL 5 s, 2× base-fee headroom.
    this._populateMutex = Promise.resolve();
    this._localNonce = null;     // bigint or null when needs resync
    this._lastChainSyncAt = 0;
    this._NONCE_SYNC_MS = 30_000;
    this._feeData = null;
    this._feeFetchedAt = 0;
    this._FEE_TTL_MS = 5_000;
  }

  /// Background-refresh fee data. Called after each successful spin (no
  /// need to await - let it race the next click). Nonce is always live.
  async prewarm() {
    try { await this._refreshFees(); } catch (_) {}
  }

  async _refreshFees() {
    // ethers getFeeData → uses eth_feeHistory + eth_maxPriorityFeePerGas
    // under the hood. Returns gasPrice, maxFeePerGas, maxPriorityFeePerGas
    // bigints, baseFee included in maxFeePerGas calc.
    const fd = await this.provider.getFeeData();
    // Apply a 2× headroom on maxFeePerGas vs what ethers calculated, so
    // a base fee bump between the populate-step and the inclusion block
    // doesn't bounce us with "gas price below base fee". The tip
    // (priority fee) stays as-returned so we don't overpay validators.
    const tip = fd.maxPriorityFeePerGas != null ? BigInt(fd.maxPriorityFeePerGas) : 1_000_000n;
    const max = fd.maxFeePerGas != null ? BigInt(fd.maxFeePerGas) * 2n
              : (fd.gasPrice != null ? BigInt(fd.gasPrice) * 2n : tip * 2n + 2_000_000n);
    this._feeData = { maxPriorityFeePerGas: tip, maxFeePerGas: max };
    this._feeFetchedAt = Date.now();
  }

  async _populateFor(tx) {
    // Mutex with two timeouts:
    //   - Predecessor-wait timeout (5 s): if the previous populate hangs
    //     forever (broken Privy iframe, RPC dead), we force-acquire rather
    //     than deadlocking every subsequent spin. Worst case is one nonce
    //     collision the next chain re-sync corrects in 30 s.
    //   - RPC-batch timeout (12 s): each populate's RPCs must complete or
    //     reject. Otherwise we'd hold the mutex forever waiting on a hung
    //     network call.
    const prev = this._populateMutex;
    let release;
    this._populateMutex = new Promise((r) => { release = r; });
    try {
      await Promise.race([
        prev,
        new Promise((r) => setTimeout(r, 5000)),
      ]);

      const now = Date.now();
      const needNonceSync = this._localNonce == null
        || (now - this._lastChainSyncAt) > this._NONCE_SYNC_MS;
      const needFees = !this._feeData
        || (now - this._feeFetchedAt) > this._FEE_TTL_MS;

      const reqs = [];
      // Gas estimate is always fresh (call data differs per spin).
      reqs.push(
        this.provider.send("eth_estimateGas", [{
          from: this._address,
          to: tx.to,
          value: tx.value != null ? "0x" + BigInt(tx.value).toString(16) : "0x0",
          data: tx.data ?? "0x",
        }]).then((est) => { tx.__gasEstimate = BigInt(est); }),
      );
      if (needNonceSync) {
        reqs.push(
          this.provider.send("eth_getTransactionCount", [this._address, "pending"])
            .then((n) => {
              this._localNonce = BigInt(n);
              this._lastChainSyncAt = Date.now();
            }),
        );
      }
      if (needFees) reqs.push(this._refreshFees());

      await Promise.race([
        Promise.all(reqs),
        new Promise((_, rej) => setTimeout(
          () => rej(new Error("populate RPC timeout (12s)")),
          12_000,
        )),
      ]);

      // Reserve the nonce synchronously under the mutex.
      const nonce = this._localNonce;
      this._localNonce = nonce + 1n;

      const gas = (tx.__gasEstimate * 125n) / 100n;
      return {
        nonce,
        gas,
        maxFeePerGas: this._feeData.maxFeePerGas,
        maxPriorityFeePerGas: this._feeData.maxPriorityFeePerGas,
      };
    } finally {
      release();
    }
  }

  async getAddress() {
    return this._address;
  }

  connect(provider) {
    return new PrivySigner(this._address, provider);
  }

  async sendTransaction(tx) {
    if (!window.ShinyLuckAuth || !window.ShinyLuckAuth.ready) {
      throw new Error("Privy not ready - call login first");
    }
    // FASTEST PATH: populate gas/nonce/fees ourselves (parallel RPC), sign
    // in Privy iframe via eth_signTransaction (returns raw hex), broadcast
    // via our own RPC.
    //
    // Caveat we learned the hard way: Privy embedded wallet's
    // eth_signTransaction does NOT fill in tx fields - unlike sendTransaction
    // which populates inside the iframe. If we pass {nonce:0, gas:0,
    // gasPrice:0} the signed tx is rejected with `-32000 invalid transaction`.
    // So we pre-populate (3 RPCs in parallel ~ one round-trip).
    //
    // Net result: ~3-4 RPC ms-budget vs Privy's internal broadcast latency
    // (~300-500ms saved per place tx).
    const t0 = performance.now();
    const stamp = (label) => console.log(`[privy-signer] ${label} +${(performance.now() - t0).toFixed(0)}ms`);

    let signed = null;
    let populated = null;
    if (typeof window.ShinyLuckAuth.signTransaction === "function") {
      try {
        populated = await this._populateFor(tx);
        stamp(`populate done (nonce=${populated.nonce}, gas=${populated.gas})`);
        signed = await Promise.race([
          window.ShinyLuckAuth.signTransaction({
            to: tx.to,
            value: tx.value != null ? BigInt(tx.value) : 0n,
            data: tx.data ?? "0x",
            chainId: tx.chainId != null ? Number(tx.chainId) : undefined,
            nonce: populated.nonce,
            gas: populated.gas,
            maxFeePerGas: populated.maxFeePerGas,
            maxPriorityFeePerGas: populated.maxPriorityFeePerGas,
          }),
          new Promise((_, rej) => setTimeout(
            () => rej(new Error("iframe sign timeout (6s)")),
            6_000,
          )),
        ]);
        stamp(`iframe sign OK (${signed.slice(0, 12)}…)`);
      } catch (e) {
        stamp(`SIGN FAIL: ${e?.message || e}`);
        signed = null;
        // Force chain re-sync since our reserved nonce never made it into
        // a broadcast - without this the next populate keeps incrementing
        // local nonce and the gap grows.
        this._lastChainSyncAt = 0;
      }
    }

    if (signed && typeof signed === "string" && signed.startsWith("0x")) {
      try {
        const txResp = await this.provider.broadcastTransaction(signed);
        stamp(`broadcast OK (hash=${txResp.hash?.slice(0, 12)}…)`);
        // Refresh fee data in the background so the next spin sees current
        // base fee without paying the round-trip on the critical path.
        this._refreshFees().catch(() => {});
        return txResp;
      } catch (e) {
        stamp(`BROADCAST FAIL: ${e?.message || e}`);
        this._lastChainSyncAt = 0;
      }
    }

    // Legacy fallback path: Privy signs AND broadcasts inside its iframe.
    // Bound by 10 s. 6 s sign-timeout + 10 s legacy timeout = 16 s, well
    // under the 25 s _raceForBetId outer deadline so both attempts get a
    // real chance before the spin is given up on.
    stamp(`legacy sendTransaction starting`);
    const result = await Promise.race([
      window.ShinyLuckAuth.sendTransaction({
        to: tx.to,
        value: tx.value != null ? BigInt(tx.value) : 0n,
        data: tx.data ?? "0x",
        chainId: tx.chainId != null ? Number(tx.chainId) : undefined,
      }),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error("Privy sendTransaction timeout (10s)")),
        10_000,
      )),
    ]);
    stamp(`legacy sendTransaction OK (hash=${result?.hash?.slice(0, 12)}…)`);
    if (!result || !result.hash) {
      throw new Error("Privy.sendTransaction returned no hash");
    }
    // Return an ethers-shaped TransactionResponse-ish object. The frontend
    // primarily uses .hash and .wait(); we cover both.
    return {
      hash: result.hash,
      wait: async (confirmations = 1) => this.provider.waitForTransaction(result.hash, confirmations),
      // Pass through anything else Privy provided so debug tooling sees it.
      ...result,
    };
  }

  async signMessage(message) {
    if (!window.ShinyLuckAuth || !window.ShinyLuckAuth.ready) {
      throw new Error("Privy not ready - call login first");
    }
    return await window.ShinyLuckAuth.signMessage(message);
  }

  async signTypedData(_domain, _types, _value) {
    throw new Error("PrivySigner.signTypedData not implemented");
  }
}

/**
 * Build a PrivySigner against the given JSON-RPC provider, using the address
 * Privy has assigned to the current session. Returns null if not authed.
 */
export function tryMakePrivySigner(provider) {
  const auth = window.ShinyLuckAuth;
  if (!auth || !auth.ready || !auth.authenticated || !auth.address) return null;
  return new PrivySigner(auth.address, provider);
}
