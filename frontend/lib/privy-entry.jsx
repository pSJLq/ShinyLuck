/* ============================================================================
 * privy-entry.jsx · bundled into frontend/vendor/privy.bundle.js
 *
 * Mounts a headless React root that hosts the PrivyProvider context, then
 * publishes auth state and send-transaction / sign-message methods onto
 * `window.ShinyLuckAuth` so the rest of our vanilla JS can use them without
 * knowing React is involved.
 *
 * ============================================================================
 * ZERO-POPUP DESIGN · Privy embedded wallet (not cross-app)
 *
 * Rationale: the architect's earlier spec used Privy cross-app login against
 * the Somnia Provider App (cm8d9yzp...). That works for login but every
 * sendTransaction triggers the provider's hosted "Approve" modal (lives at
 * privy.somnia.network/oauth/transact). That modal is the provider's
 * security flow · we can't suppress it from our side. The user explicitly
 * asked for "transactions auto-confirm".
 *
 * Embedded wallets keep the magic-link login UX but Privy creates the wallet
 * inside our app (createOnLogin: 'users-without-wallets'). Combined with
 * `embeddedWallets.showWalletUIs: false` AND the Privy dashboard toggle
 * "Disable confirmation modals", every sendTransaction fires with no UI.
 *
 * Trade-off: the embedded wallet address is app-scoped, not a Somnia Global
 * Wallet. The user does NOT see the same address across other Somnia-partner
 * apps. For this hackathon submission, smooth UX > shared-wallet branding.
 *
 * If you ever want to reintroduce cross-app for Global Wallet branding while
 * keeping zero popups, the path is:
 *   1) Add `'privy:cm8d9yzp...'` back to loginMethods (cross-app option).
 *   2) Resolve address from `user.linkedAccounts.find(cross_app...)`.
 *   3) Use `useCrossAppAccounts().sendTransaction(tx, { address })`.
 *   4) Get Somnia to allowlist our app on their provider side so the per-tx
 *      modal is skipped (only Somnia can do this · not user-configurable).
 * ========================================================================= */

import React, { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets, useSendTransaction, useSignMessage, useCreateWallet } from '@privy-io/react-auth';
import { somniaTestnet, somnia as somniaMainnet } from 'viem/chains';

// ----------------------------------------------------------------------------
// Tiny event emitter so vanilla code can subscribe to auth changes.
// ----------------------------------------------------------------------------
const listeners = new Set();
function emit(api) {
  for (const fn of listeners) { try { fn(api); } catch (e) { console.error('[privy] listener threw:', e); } }
}
function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ----------------------------------------------------------------------------
// Pre-mount stub: window.ShinyLuckAuth is set to this BEFORE React renders so
// vanilla code that loads earlier doesn't NPE on `.ready`, `.login`, etc.
// ----------------------------------------------------------------------------
function makeStub(ready) {
  const rejectNotReady = () => Promise.reject(new Error('Privy not ready yet'));
  return {
    ready, authenticated: false, user: null, address: null,
    backend: ready ? 'privy' : 'privy-stub',
    login: rejectNotReady,
    logout: () => Promise.resolve(),
    sendTransaction: rejectNotReady,
    signMessage: rejectNotReady,
    onChange,
  };
}

// ----------------------------------------------------------------------------
// AuthBridge · runs inside PrivyProvider; publishes auth state to window.
// ----------------------------------------------------------------------------
function AuthBridge() {
  const { ready, authenticated, user, login: doLogin, logout: doLogout } = usePrivy();
  const { wallets } = useWallets();
  const { sendTransaction: privySendTx } = useSendTransaction();
  const { signMessage: privySignMsg } = useSignMessage();
  const { createWallet } = useCreateWallet();

  // Resolve the EMBEDDED wallet (walletClientType==='privy'). NOT any injected
  // (MetaMask) or cross-app wallet. If user authenticated but has no embedded
  // (e.g. previous cross-app session is cached), the next effect below
  // auto-creates one. We deliberately do NOT fall back to a cross-app address
  // here · that would route us back to the per-tx Approve modal we just got rid of.
  const address = useMemo(() => {
    if (!authenticated || !Array.isArray(wallets) || wallets.length === 0) return null;
    const embedded = wallets.find(w => w?.walletClientType === 'privy');
    return embedded?.address || null;
  }, [authenticated, wallets]);

  // Self-heal: if authenticated but no embedded wallet exists (typical after
  // migrating from a cross-app session), provision one. Privy will fire
  // useWallets() with the new wallet on the next render → `address` populates.
  const creatingWalletRef = useRef(false);
  useEffect(() => {
    if (!ready || !authenticated) return;
    if (address) return;
    const hasEmbedded = Array.isArray(wallets) && wallets.some(w => w?.walletClientType === 'privy');
    if (hasEmbedded) return;
    if (creatingWalletRef.current) return;
    creatingWalletRef.current = true;
    createWallet()
      .then(() => { /* useWallets() will tick · useMemo recomputes `address` */ })
      .catch((e) => {
        // 'already has wallet' = race; ignore. Other errors surface in console.
        if (!/already.*wallet/i.test(e?.message || '')) console.error('[privy] createWallet failed:', e);
      })
      .finally(() => { creatingWalletRef.current = false; });
  }, [ready, authenticated, address, wallets, createWallet]);

  // Stable refs so the api object identity is consistent across re-renders.
  const sendTxRef = useRef(privySendTx);
  const signMsgRef = useRef(privySignMsg);
  const logoutRef = useRef(doLogout);
  const loginRef = useRef(doLogin);
  useEffect(() => {
    sendTxRef.current = privySendTx;
    signMsgRef.current = privySignMsg;
    logoutRef.current = doLogout;
    loginRef.current = doLogin;
  });

  useEffect(() => {
    if (!ready) {
      const stub = makeStub(false);
      window.ShinyLuckAuth = stub;
      emit(stub);
      document.dispatchEvent(new CustomEvent('shinyluck:auth-state', {
        detail: { ready: false, authenticated: false, address: null },
      }));
      return;
    }

    // Resolve the embedded wallet object (not just its address) so we can
    // call its EIP-1193 getEthereumProvider() · the FAST path. The Privy
    // React hook `useSendTransaction()` adds ~1-2s of overhead doing its
    // own gas estimation, nonce management, and policy checks. The
    // EIP-1193 provider returned from `wallet.getEthereumProvider()`
    // signs in the Privy iframe and broadcasts directly to the
    // configured chain RPC, skipping all of that · measured ~2-3s
    // faster end-to-end on Somnia testnet.
    const embeddedWallet = (Array.isArray(wallets)
      && wallets.find((w) => w?.walletClientType === 'privy')) || null;

    // Cache the EIP-1193 provider across sendTransaction calls. The first
    // `getEthereumProvider()` may lazily initialise iframe channels -
    // subsequent calls should reuse the same object. We re-fetch on demand
    // if the cache is stale (wallet remount, address rotation).
    let cachedEip1193 = null;
    let cachedEip1193ForAddr = null;

    const api = {
      ready: true,
      authenticated,
      user,
      address,
      backend: 'privy',
      onChange,

      login: () => loginRef.current(),
      logout: () => logoutRef.current(),

      // FASTEST PATH: sign in Privy iframe via eth_signTransaction (returns
      // raw signed tx hex), then caller broadcasts via our own RPC. Skips
      // Privy's backend broadcast which adds 300-500ms.
      //
      // IMPORTANT: Privy embedded wallet's eth_signTransaction does NOT
      // populate nonce/gas/fees · caller MUST provide them populated.
      // Privy ALSO defaults to EIP-1559 (type-2) tx shape, so `gasPrice`
      // alone gets silently dropped; you must pass `maxFeePerGas` +
      // `maxPriorityFeePerGas`. Confirmed by RLP-decoding the rejected
      // signed tx · gasPrice was zero on the wire.
      signTransaction: async (tx) => {
        if (!address) throw new Error('Privy: not logged in (no embedded wallet)');
        if (!embeddedWallet || typeof embeddedWallet.getEthereumProvider !== 'function') {
          throw new Error('Privy embedded wallet missing getEthereumProvider');
        }
        if (tx.nonce == null || tx.gas == null
            || (tx.maxFeePerGas == null && tx.gasPrice == null)) {
          throw new Error('signTransaction requires populated {nonce, gas, maxFeePerGas (or gasPrice)}');
        }
        let eip1193 = cachedEip1193;
        if (!eip1193 || cachedEip1193ForAddr !== address) {
          eip1193 = await embeddedWallet.getEthereumProvider();
          cachedEip1193 = eip1193;
          cachedEip1193ForAddr = address;
        }
        const params = [{
          from: address,
          to: tx.to,
          value: tx.value != null ? '0x' + BigInt(tx.value).toString(16) : '0x0',
          data: tx.data || '0x',
          nonce: '0x' + BigInt(tx.nonce).toString(16),
          gas: '0x' + BigInt(tx.gas).toString(16),
          ...(tx.maxFeePerGas != null
            ? {
                maxFeePerGas: '0x' + BigInt(tx.maxFeePerGas).toString(16),
                maxPriorityFeePerGas: '0x' + BigInt(tx.maxPriorityFeePerGas ?? tx.maxFeePerGas).toString(16),
              }
            : { gasPrice: '0x' + BigInt(tx.gasPrice).toString(16) }),
        }];
        // Result is the raw signed tx (hex string starting 0x) per EIP-1474.
        const raw = await eip1193.request({ method: 'eth_signTransaction', params });
        return raw;
      },

      // FAST PATH: sign via embedded wallet's EIP-1193 provider, broadcast
      // ourselves. Falls back to the React-hook path on any error.
      sendTransaction: async (tx) => {
        if (!address) throw new Error('Privy: not logged in (no embedded wallet)');
        // Try the fast EIP-1193 path first.
        if (embeddedWallet && typeof embeddedWallet.getEthereumProvider === 'function') {
          try {
            // Reuse the EIP-1193 provider across spins · the first call
            // sometimes pays for iframe-channel setup. Re-fetch only if the
            // user's address rotated (rare; happens on re-login).
            let eip1193 = cachedEip1193;
            if (!eip1193 || cachedEip1193ForAddr !== address) {
              eip1193 = await embeddedWallet.getEthereumProvider();
              cachedEip1193 = eip1193;
              cachedEip1193ForAddr = address;
            }
            const params = [{
              from: address,
              to: tx.to,
              value: tx.value != null ? '0x' + BigInt(tx.value).toString(16) : '0x0',
              data: tx.data || '0x',
            }];
            const hash = await eip1193.request({ method: 'eth_sendTransaction', params });
            return { hash };
          } catch (e) {
            // Drop the cache on any error so the next attempt re-initialises.
            cachedEip1193 = null;
            cachedEip1193ForAddr = null;
            // If the fast path errors (rare · invalid params, gateway issue)
            // fall through to the React hook so we don't lose the user's bet.
            console.warn('[privy] eip1193 fast send failed, falling back:', e?.message || e);
          }
        }
        const result = await sendTxRef.current(
          { to: tx.to, value: tx.value, data: tx.data, chainId: tx.chainId },
          { address, uiOptions: { showWalletUIs: false } },
        );
        return result;
      },
      signMessage: async (message) => {
        if (!address) throw new Error('Privy: not logged in (no embedded wallet)');
        const result = await signMsgRef.current(
          { message },
          { address, uiOptions: { showWalletUIs: false } },
        );
        return result?.signature || result;
      },
    };
    window.ShinyLuckAuth = api;
    emit(api);

    document.dispatchEvent(new CustomEvent('shinyluck:auth-state', {
      detail: { ready: true, authenticated, address },
    }));
    if (authenticated && address) {
      document.dispatchEvent(new CustomEvent('shinyluck:connected', {
        detail: { address, backend: 'privy' },
      }));
    }
  }, [ready, authenticated, user, address]);

  return null;
}

// ----------------------------------------------------------------------------
// App · root component
// ----------------------------------------------------------------------------
function App() {
  const cfg = (typeof window !== 'undefined' && window.SHINYLUCK_CONFIG) || {};
  const isMainnet = cfg.network === 'somniaMainnet';
  const chain = isMainnet ? somniaMainnet : somniaTestnet;

  if (!cfg.privyAppId) {
    console.error('[privy] SHINYLUCK_CONFIG.privyAppId is missing · set it in frontend/lib/config.js');
  }

  return (
    <PrivyProvider
      appId={cfg.privyAppId || ''}
      config={{
        // Email-only login. Drop the cross-app `privy:<somnia>` entry · that
        // path triggers a per-tx provider modal we can't suppress (see header).
        loginMethods: ['email'],
        defaultChain: chain,
        supportedChains: [chain],
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
          // Headless mode · no per-tx modal. Belt+suspenders with the
          // dashboard's "Disable confirmation modals" toggle.
          showWalletUIs: false,
        },
        appearance: {
          theme: 'dark',
          accentColor: '#7c3aed',
          // logo: '/assets/logo.svg',  // removed · file doesn't exist, was 404
        },
      }}
    >
      <AuthBridge />
    </PrivyProvider>
  );
}

// ----------------------------------------------------------------------------
// Auto-mount
// ----------------------------------------------------------------------------
function mount() {
  if (document.getElementById('__privy-root')) return;
  if (!window.ShinyLuckAuth) window.ShinyLuckAuth = makeStub(false);

  const el = document.createElement('div');
  el.id = '__privy-root';
  el.style.cssText = 'position:fixed;top:-99999px;left:-99999px;width:0;height:0;pointer-events:none;';
  document.body.appendChild(el);

  createRoot(el).render(<App />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
