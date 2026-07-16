// Button press feedback for every poker screen.
//
// The problem this solves: an on-chain button (Join, Start, Unregister, Take
// seat…) does nothing visible for the second or two the tx is in flight, so it
// reads as "my click missed" and the player clicks again — firing a second tx.
//
// Two layers, both driven from here so no button has to opt in:
//   1. PRESS  — a capture-phase listener taps every <button> the instant it is
//      clicked, before any handler runs. Purely visual, works on plain buttons
//      too (Copy link, tabs, modal opens).
//   2. BUSY   — screens whose async helper calls SPPress.claim() get a spinner
//      on the exact button that owns the pending work, and further clicks on it
//      are swallowed until it settles.
//
// State lives on data-* attributes, NOT on className: React rewrites className
// whenever a re-render changes it and would wipe a class we added behind its
// back, but it never touches attributes that were absent from its vdom.

(() => {
  if (window.SPPress) return;

  let last = null;      // the most recently clicked button
  let lastAt = 0;       // …and when · a stale one must not adopt a later spinner

  const PRESS_MS = 140;
  const CLAIM_WINDOW_MS = 1500;

  document.addEventListener("click", (e) => {
    const b = e.target && e.target.closest ? e.target.closest("button") : null;
    if (!b) { last = null; return; }

    // Already working → swallow the click before React's handler can see it.
    // pointer-events:none in CSS covers this too; this is the belt to that
    // brace, since a button style could always override pointer-events.
    if (b.hasAttribute("data-sp-busy")) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return;
    }
    if (b.disabled) return;

    last = b;
    lastAt = Date.now();
    b.setAttribute("data-sp-press", "");
    setTimeout(() => b.removeAttribute("data-sp-press"), PRESS_MS);
  }, true); // capture · must beat React's root listener

  window.SPPress = {
    /// Take ownership of the button that is mid-click and mark it busy.
    /// Call this synchronously from the click handler (before any await),
    /// then call the returned release fn when the work settles.
    claim() {
      const b = last;
      last = null;
      if (!b || Date.now() - lastAt > CLAIM_WINDOW_MS || !b.isConnected) return () => {};
      b.setAttribute("data-sp-busy", "");
      let released = false;
      return () => {
        if (released) return;
        released = true;
        b.removeAttribute("data-sp-busy");
      };
    },
  };
})();
