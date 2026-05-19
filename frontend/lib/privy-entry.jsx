/* ============================================================================
 * privy-entry.jsx — bundled into frontend/vendor/privy.bundle.js
 *
 * Mounts a headless React root that hosts the PrivyProvider context, then
 * publishes auth state and the cross-app send-transaction / sign-message
 * methods onto `window.ShinyLuckAuth` so the rest of our vanilla JS can use
 * them without knowing React is involved.
 *
 * Built via `node scripts/build-privy-vendor.js`. Bundle is loaded by every
 * page that needs auth (SomniaLuck.html, the game pages, etc.) BEFORE the
 * vanilla `lib/wallet.js` module that consumes it.
 * ========================================================================= */

import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, usePrivy, useWallets, useCrossAppAccounts } from '@privy-io/react-auth';
import { somniaTestnet, somnia as somniaMainnet } from 'viem/chains';

// Public Somnia Provider App ID per docs.somnia.network — stable, not a secret.
const SOMNIA_PROVIDER_APP_ID = 'cm8d9yzp2013kkr612h8ymoq8';

// ----------------------------------------------------------------------------
// AuthBridge — runs inside PrivyProvider; publishes auth state to window.
// ----------------------------------------------------------------------------
function AuthBridge() {
  const { ready, authenticated, user, logout: doLogout } = usePrivy();
  const { wallets } = useWallets();
  const cross = useCrossAppAccounts();

  useEffect(() => {
    // Even before `ready`, expose a non-ready stub so vanilla code doesn't NPE.
    if (!ready) {
      window.ShinyLuckAuth = makeStub({ ready: false });
      document.dispatchEvent(new CustomEvent('shinyluck:auth-state', {
        detail: { ready: false, authenticated: false, address: null },
      }));
      return;
    }

    // The first Somnia Global Wallet entry is what we transact with.
    const wallet = wallets?.[0] || null;
    const address = wallet?.address || null;

    const api = {
      ready: true,
      authenticated,
      user,
      address,
      backend: 'privy',

      login: async () => {
        return await cross.loginWithCrossAppAccount({ appId: SOMNIA_PROVIDER_APP_ID });
      },
      logout: () => doLogout(),
      sendTransaction: async (tx) => {
        if (!address) throw new Error('not logged in');
        return await cross.sendTransaction(tx, { address });
      },
      signMessage: async (msg) => {
        if (!address) throw new Error('not logged in');
        return await cross.signMessage(msg, { address });
      },
    };
    window.ShinyLuckAuth = api;

    document.dispatchEvent(new CustomEvent('shinyluck:auth-state', {
      detail: { ready: true, authenticated, address },
    }));
    if (authenticated && address) {
      document.dispatchEvent(new CustomEvent('shinyluck:connected', {
        detail: { address, backend: 'privy' },
      }));
    }
  }, [ready, authenticated, user, wallets, cross, doLogout]);

  return null;
}

function makeStub({ ready }) {
  const rejectNotReady = () => Promise.reject(new Error('Privy not ready yet'));
  return {
    ready,
    authenticated: false,
    user: null,
    address: null,
    backend: 'privy-stub',
    login: rejectNotReady,
    logout: () => Promise.resolve(),
    sendTransaction: rejectNotReady,
    signMessage: rejectNotReady,
  };
}

// ----------------------------------------------------------------------------
// App — root component
// ----------------------------------------------------------------------------
function App() {
  const cfg = (typeof window !== 'undefined' && window.SHINYLUCK_CONFIG) || {};
  const isMainnet = cfg.network === 'somniaMainnet';
  const chain = isMainnet ? somniaMainnet : somniaTestnet;

  if (!cfg.privyAppId) {
    // Helpful console error so missing dashboard config surfaces early.
    console.error('[privy] SHINYLUCK_CONFIG.privyAppId is missing — set it in frontend/lib/config.js');
  }

  return (
    <PrivyProvider
      appId={cfg.privyAppId || ''}
      config={{
        // Only email login (per session spec — minimal surface).
        loginMethods: ['email'],
        defaultChain: chain,
        supportedChains: [chain],
        embeddedWallets: {
          createOnLogin: 'users-without-wallets',
          // Headless mode — no Privy modal pops up per transaction. Combined
          // with the dashboard's "Disable confirmation modals" toggle, our
          // game txs go through with zero prompts.
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
  if (!window.ShinyLuckAuth) window.ShinyLuckAuth = makeStub({ ready: false });

  const el = document.createElement('div');
  el.id = '__privy-root';
  // visually invisible — Privy's hosted UI iframes anchor themselves elsewhere
  el.style.cssText = 'position:fixed;top:-99999px;left:-99999px;width:0;height:0;pointer-events:none;';
  document.body.appendChild(el);

  createRoot(el).render(<App />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
} else {
  mount();
}
