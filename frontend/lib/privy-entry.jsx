/* ============================================================================
 * privy-entry.jsx — bundled into frontend/vendor/privy.bundle.js
 *
 * Mounts a headless React root that hosts the PrivyProvider context, then
 * publishes auth state and the cross-app send-transaction / sign-message
 * methods onto `window.ShinyLuckAuth` so the rest of our vanilla JS can use
 * them without knowing React is involved.
 *
 * CRITICAL — Somnia Global Wallet integration:
 *   - loginMethods is a FLAT array, including the cross-app provider via the
 *     `privy:<provider-app-id>` entry. The Privy 3.x SDK reads it as an array
 *     (it calls `loginMethods.includes(...)` internally and iterates for any
 *     `'privy:'` prefix entries to enable cross-app). Using the older
 *     "object form" `{ primary: [...] }` crashes the SDK with
 *     "t.loginMethods.includes is not a function" — verified live in 3.26.0.
 *   - The address we transact with is the CROSS-APP wallet — resolved from
 *     `user.linkedAccounts` filtered by `type === 'cross_app'` and the Somnia
 *     Provider App ID. NEVER read `useWallets()` or `user.wallet.address` —
 *     those return any locally-injected provider too (e.g. MetaMask) which
 *     defeats the whole "everyone gets a Global Wallet" UX.
 *   - sendTransaction / signMessage come from useCrossAppAccounts and need
 *     `{ address }` as the second arg (CrossAppWalletOptions).
 *
 * Built via `node scripts/build-privy-vendor.js`. Bundle is loaded by every
 * page that needs auth BEFORE the vanilla `lib/wallet.js` module.
 * ========================================================================= */

import React, { useEffect, useMemo, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useCrossAppAccounts } from '@privy-io/react-auth';
import { somniaTestnet, somnia as somniaMainnet } from 'viem/chains';

// Public Somnia Provider App ID per docs.somnia.network — stable identifier,
// not a secret. Hardcoded so it can never drift from the dashboard setting.
const SOMNIA_PROVIDER_APP_ID = 'cm8d9yzp2013kkr612h8ymoq8';

// ----------------------------------------------------------------------------
// Tiny event emitter so vanilla code can subscribe to auth changes via
// window.ShinyLuckAuth.onChange(callback). Each emit calls every listener with
// the current public api object.
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
// AuthBridge — runs inside PrivyProvider; publishes auth state to window.
// ----------------------------------------------------------------------------
function AuthBridge() {
  const { ready, authenticated, user, logout: doLogout } = usePrivy();
  const cross = useCrossAppAccounts();

  // Resolve the CROSS-APP address (NOT useWallets). The cross-app linked
  // account is what the Somnia Provider App returned when the user logged in
  // via loginWithCrossAppAccount — that's the address we want to transact
  // with, and it follows the user across every Somnia-partner dApp.
  const address = useMemo(() => {
    if (!authenticated || !user || !Array.isArray(user.linkedAccounts)) return null;
    const crossApp = user.linkedAccounts.find(
      (a) => a && a.type === 'cross_app' && a.providerApp && a.providerApp.id === SOMNIA_PROVIDER_APP_ID,
    );
    if (!crossApp) return null;
    const embedded = (crossApp.embeddedWallets || [])[0];
    return embedded?.address || null;
  }, [authenticated, user]);

  // Stable refs for the callbacks so the api object identity is consistent
  // across re-renders (otherwise listeners would fire on every render).
  const crossRef = useRef(cross);
  const logoutRef = useRef(doLogout);
  useEffect(() => { crossRef.current = cross; logoutRef.current = doLogout; });

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

    const api = {
      ready: true,
      authenticated,
      user,
      address,
      backend: 'privy',
      onChange,

      login: async () => {
        // Opens Privy's cross-app login flow → Somnia Provider App → email
        // magic link. On success, user.linkedAccounts grows by one cross_app
        // entry and the useMemo above re-resolves `address`.
        return await crossRef.current.loginWithCrossAppAccount({ appId: SOMNIA_PROVIDER_APP_ID });
      },
      logout: () => logoutRef.current(),
      sendTransaction: async (tx) => {
        if (!address) throw new Error('Privy: not logged in (no cross-app address)');
        return await crossRef.current.sendTransaction(tx, { address });
      },
      signMessage: async (message) => {
        if (!address) throw new Error('Privy: not logged in (no cross-app address)');
        // CrossAppMessageOptions expects { message } as the first arg.
        return await crossRef.current.signMessage({ message }, { address });
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
// App — root component
// ----------------------------------------------------------------------------
function App() {
  const cfg = (typeof window !== 'undefined' && window.SHINYLUCK_CONFIG) || {};
  const isMainnet = cfg.network === 'somniaMainnet';
  const chain = isMainnet ? somniaMainnet : somniaTestnet;

  if (!cfg.privyAppId) {
    console.error('[privy] SHINYLUCK_CONFIG.privyAppId is missing — set it in frontend/lib/config.js');
  }

  return (
    <PrivyProvider
      appId={cfg.privyAppId || ''}
      config={{
        // Flat-array loginMethods — Privy 3.x SDK contract. The `privy:<id>`
        // entry tells the SDK to show a "Continue with Somnia" button that
        // triggers cross-app login against the Somnia Provider App. The SDK
        // iterates this array for any 'privy:' prefix entries to wire up
        // cross-app providers (see Privy source: it calls
        // `loginMethods.includes(...)` and `for (let m of loginMethods) if
        // (m.startsWith('privy:')) ...`).
        loginMethods: ['email', `privy:${SOMNIA_PROVIDER_APP_ID}`],
        defaultChain: chain,
        supportedChains: [chain],
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
          // Headless mode — no per-tx modal. Belt+suspenders with the
          // dashboard's "Disable confirmation modals" toggle.
          showWalletUIs: false,
        },
        appearance: {
          theme: 'dark',
          accentColor: '#7c3aed',
          logo: '/assets/logo.svg',
        },
      }}
    >
      <AuthBridge />
    </PrivyProvider>
  );
}

// ----------------------------------------------------------------------------
// Auto-mount: invoked when the bundle loads
// ----------------------------------------------------------------------------
function mount() {
  if (document.getElementById('__privy-root')) return; // already mounted
  // pre-mount stub so vanilla code calling window.ShinyLuckAuth.login won't crash
  if (!window.ShinyLuckAuth) window.ShinyLuckAuth = makeStub(false);

  const el = document.createElement('div');
  el.id = '__privy-root';
  // visually invisible — Privy's hosted UI anchors itself elsewhere via portals
  el.style.cssText = 'position:fixed;top:-99999px;left:-99999px;width:0;height:0;pointer-events:none;';
  document.body.appendChild(el);

  createRoot(el).render(<App />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
