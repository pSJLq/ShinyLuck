/* ============================================================================
 * privy-signer.js
 *
 * An ethers v6 AbstractSigner that routes every tx / signMessage call through
 * `window.ShinyLuckAuth.sendTransaction` (set up by the React shell in
 * `frontend/vendor/privy.bundle.js` — see `lib/privy-entry.jsx`).
 *
 * Lets the existing `ShinyLuck` SDK (frontend/lib/shinyluck-sdk.js) work
 * unchanged: it just needs an ethers Signer, doesn't care which backend.
 * ========================================================================= */

import { ethers } from "https://esm.sh/ethers@6.13.2";

export class PrivySigner extends ethers.AbstractSigner {
  constructor(address, provider) {
    super(provider);
    this._address = address;
  }

  async getAddress() {
    return this._address;
  }

  connect(provider) {
    return new PrivySigner(this._address, provider);
  }

  async sendTransaction(tx) {
    if (!window.ShinyLuckAuth || !window.ShinyLuckAuth.ready) {
      throw new Error("Privy not ready — call login first");
    }
    // Populate `from`, `nonce`, `gasLimit`, `gasPrice` etc. via the parent
    // provider before handing to Privy. Privy handles signing + relay.
    const populated = await this.populateTransaction(tx);
    // Privy expects: { to, value, data, chainId } — strip everything else.
    const result = await window.ShinyLuckAuth.sendTransaction({
      to: populated.to,
      value: populated.value ?? 0n,
      data: populated.data ?? "0x",
      chainId: populated.chainId == null ? undefined : Number(populated.chainId),
    });
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
      throw new Error("Privy not ready — call login first");
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
