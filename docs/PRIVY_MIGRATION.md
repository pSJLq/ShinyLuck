# Privy Global Wallet — Migration Plan

This document captures the work to migrate ShinyLuck from **Sequence WaaS** to
**Privy + Somnia Global Wallet**, per `privy_global_wallet_prompt.txt`. It was
**not completed in the math-sync session** because (1) it's a 1–2 day rewrite
on its own, (2) the math/slot work was the blocker on a working demo, and
(3) Privy's React-only SDK requires a vendor-bundle pipeline before any
frontend code can use it.

The current frontend continues to work with **Sequence WaaS + MetaMask
fallback** (`frontend/lib/wallet.js`, `frontend/lib/sequence-waas.js`,
`frontend/vendor/sequence-waas.js`). Slot integration (`frontend/games/sugar`,
`frontend/games/vault7`) plugs into that same `SL` (ShinyLuck SDK) instance.

## Why Privy Global Wallet

- **Cross-dApp wallet**: a user who has a wallet on any Somnia partner app
  logs into ShinyLuck with the same email and gets the same address.
- **No popups**: Privy's "Disable confirmation modals" flag is already ON in
  the user's Privy dashboard (per session notes), so on-chain bets won't
  interrupt the player with a per-tx prompt.
- **Lower friction than Sequence**: no per-app session token, no SDK CDN
  failures (Sequence WaaS has had esm.sh hiccups breaking the Connect button).

## What's already done

- Privy app named "ShinyLuck" exists with `PRIVY_APP_ID` and `PRIVY_APP_SECRET`
  in `.env`.
- Dashboard configured (per session notes):
  - Disable confirmation modals = ON
  - Somnia Provider App enabled (cross-app login)
  - Embedded wallets enabled
  - Email login enabled
- Somnia Provider App ID is the public constant `cm8d9yzp2013kkr612h8ymoq8`.

## What needs to happen

### 1. Install deps (Node side)

```
npm install @privy-io/react-auth @privy-io/cross-app-connect react react-dom
```

These DON'T need React anywhere in production runtime; we just need them as
inputs to the bundler.

### 2. Vendor bundle

Extend `scripts/build-vendor.js` with a second target that bundles
Privy + React into `frontend/vendor/privy.bundle.js`. esbuild config:

```js
await esbuild.build({
  entryPoints: [path.join(__dirname, "..", "frontend", "lib", "privy", "_entry.jsx")],
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "browser",
  loader: { ".jsx": "jsx", ".js": "jsx" },
  jsx: "automatic",
  outfile: path.join(outDir, "privy.bundle.js"),
  minify: true,
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": '"production"' },
});
```

### 3. React shell — `frontend/lib/privy/_entry.jsx`

```jsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets } from '@privy-io/react-auth';
import { useCrossAppAccounts } from '@privy-io/cross-app-connect';
import { somniaTestnet } from 'viem/chains';

const SOMNIA_PROVIDER_APP_ID = 'cm8d9yzp2013kkr612h8ymoq8';

function AuthBridge() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { loginWithCrossAppAccount, sendTransaction, signMessage } = useCrossAppAccounts();

  // Pump state out to window so vanilla JS (wallet.js, dice.js, sugar/api.js,
  // etc.) can subscribe via the same `shinyluck:connected` CustomEvent that
  // the Sequence path uses today.
  React.useEffect(() => {
    if (!ready) return;
    const addr = wallets?.[0]?.address || null;
    window.ShinyLuckAuth = {
      isReady: () => true,
      isAuthenticated: () => authenticated,
      getEmbeddedAddress: () => addr,
      login: () => loginWithCrossAppAccount({ appId: SOMNIA_PROVIDER_APP_ID }),
      logout,
      sendTransaction: (tx) => sendTransaction(tx, { address: addr }),
      signMessage,
    };
    document.dispatchEvent(new CustomEvent('shinyluck:auth-state', {
      detail: { authenticated, address: addr },
    }));
    if (authenticated && addr) {
      document.dispatchEvent(new CustomEvent('shinyluck:connected', {
        detail: { address: addr, backend: 'privy' },
      }));
    }
  }, [ready, authenticated, wallets]);

  return null;
}

const root = document.createElement('div');
root.id = '__privy_root';
document.body.appendChild(root);
createRoot(root).render(
  <PrivyProvider
    appId={window.SHINYLUCK_CONFIG?.privyAppId}
    config={{
      loginMethods: ['email'],
      defaultChain: somniaTestnet,
      supportedChains: [somniaTestnet],
      embeddedWallets: { createOnLogin: 'users-without-wallets' },
      appearance: { theme: 'dark', accentColor: '#7c3aed' },
    }}
  >
    <AuthBridge />
  </PrivyProvider>
);
```

### 4. PrivySigner — `frontend/lib/privy-signer.js`

Wrap `window.ShinyLuckAuth.sendTransaction` as an ethers `AbstractSigner` so
the existing `ShinyLuck` SDK works unchanged:

```js
import { ethers } from 'https://esm.sh/ethers@6.13.2';
export class PrivySigner extends ethers.AbstractSigner {
  constructor(address, provider) { super(provider); this._address = address; }
  async getAddress() { return this._address; }
  async sendTransaction(tx) {
    const populated = await this.populateTransaction(tx);
    const result = await window.ShinyLuckAuth.sendTransaction({
      to:    populated.to,
      value: populated.value ?? 0n,
      data:  populated.data ?? '0x',
      chainId: Number(populated.chainId),
    });
    return {
      hash: result.hash,
      wait: () => this.provider.waitForTransaction(result.hash),
      ...result,
    };
  }
  async signMessage(msg) { return await window.ShinyLuckAuth.signMessage(msg); }
}
```

### 5. Wire into `wallet.js`

Replace the "Continue with email" / "Continue as guest" / "MetaMask" modal
with a single "Continue with Email" Privy button. Keep MetaMask as a
secondary option. The MetaMask path stays the same; the email path goes
through `window.ShinyLuckAuth.login()` and on success constructs a
`PrivySigner` and assigns it to `SL.signer`.

### 6. Delete Sequence

After Privy works end-to-end:

- `rm frontend/lib/sequence-waas.js`
- `rm frontend/vendor/sequence-waas.js{,.map}`
- `npm uninstall @0xsequence/waas`
- Remove the lazy-load block in `wallet.js` that imports Sequence

### 7. Smoke test (manual)

- Open site in incognito → "Continue with Email" button appears
- Login with test email, receive magic link, click link, return to site
- Wallet address visible in top-right
- Refresh → still authenticated
- Place a dice bet under 1 STT → no popup (because dashboard has
  "Disable confirmation modals" on)
- Withdraw 0.1 STT externally → Privy modal appears (different flow, owns
  the modal because it isn't an app-initiated contract call)

## Estimated effort

- Vendor bundle wiring: 2-3 hours (Privy SDK has finicky React peer deps)
- React shell + bridge: 2 hours
- PrivySigner + wallet.js refactor: 3 hours
- Cleanup + manual test: 2 hours
- **Total: ~10 hours of focused work**

This was not feasible alongside the math sync + slot integration + redeploy
in a single session. Math correctness was the priority; the wallet swap is a
clean follow-up that doesn't block hackathon submission as long as Sequence
keeps functioning.
