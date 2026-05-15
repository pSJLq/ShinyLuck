// Toast + confirm + prompt — replaces window.alert / confirm / prompt with
// a styled, on-brand dialog. Lazy-injects its own CSS once on first use.
//
// API:
//   import { toast, confirmDialog, promptDialog } from "./ui.js";
//   toast("Wallet disconnected", { kind: "info", ttl: 3500 });
//   const ok = await confirmDialog("Disconnect wallet?", { yes: "Disconnect", no: "Stay" });
//   const v = await promptDialog("Send amount (STT):", { initial: "0.5", placeholder: "0.0" });

export function injectStylesOnce() {
  if (document.getElementById("sl-ui-style")) return;
  const s = document.createElement("style");
  s.id = "sl-ui-style";
  s.textContent = `
    /* ---- toast ------------------------------------------------------ */
    .sl-toast-wrap {
      position: fixed; right: 24px; bottom: 24px; z-index: 9500;
      display: flex; flex-direction: column-reverse; gap: 8px; pointer-events: none;
    }
    .sl-toast {
      pointer-events: auto;
      background: var(--bg-1, #0f0f12);
      border: 1px solid var(--line, #1f1f23);
      border-left-width: 3px;
      padding: 12px 16px;
      min-width: 240px; max-width: 380px;
      font-family: "JetBrains Mono", monospace; font-size: 12px;
      color: var(--fg, #fafafa); letter-spacing: 0.5px; line-height: 1.5;
      box-shadow: 0 8px 32px rgba(0,0,0,0.45);
      animation: sl-toast-in 0.32s cubic-bezier(.22,.61,.36,1);
    }
    .sl-toast.info    { border-left-color: var(--cyan,   #22D3EE); }
    .sl-toast.success { border-left-color: var(--green,  #16a34a); }
    .sl-toast.warn    { border-left-color: var(--amber,  #facc15); }
    .sl-toast.error   { border-left-color: var(--red,    #dc2626); }
    .sl-toast.leaving { animation: sl-toast-out 0.28s ease forwards; }
    @keyframes sl-toast-in  { from { transform: translateX(40px); opacity: 0; } to { transform: none; opacity: 1; } }
    @keyframes sl-toast-out { to   { transform: translateX(40px); opacity: 0; } }

    /* ---- modal ------------------------------------------------------ */
    .sl-modal-mask {
      position: fixed; inset: 0; z-index: 9600;
      background: rgba(0,0,0,0.78); backdrop-filter: blur(8px);
      display: flex; align-items: center; justify-content: center;
      padding: 24px; animation: sl-mask-in 0.22s ease;
    }
    @keyframes sl-mask-in { from { opacity: 0; } to { opacity: 1; } }
    .sl-modal {
      background: var(--bg-1, #0f0f12);
      border: 1px solid var(--line, #1f1f23);
      max-width: 420px; width: 100%; padding: 28px;
      font-family: "JetBrains Mono", monospace; color: var(--fg, #fafafa);
      box-shadow: 0 24px 64px rgba(0,0,0,0.6);
      animation: sl-modal-in 0.28s cubic-bezier(.22,.61,.36,1);
    }
    @keyframes sl-modal-in { from { transform: translateY(20px); opacity: 0; } to { transform: none; opacity: 1; } }
    .sl-modal h3 { margin: 0 0 8px; font-size: 14px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--cyan, #22D3EE); font-weight: 500; }
    .sl-modal p  { margin: 0 0 18px; font-size: 13px; color: var(--fg-mute, #6b6b75); line-height: 1.5; }
    .sl-modal .sl-modal-input {
      width: 100%; box-sizing: border-box;
      padding: 10px 12px; margin-bottom: 16px;
      background: rgba(0,0,0,0.35);
      border: 1px solid var(--line, #1f1f23);
      color: var(--fg, #fafafa); font: inherit; font-size: 13px;
      letter-spacing: 0.5px; outline: none;
    }
    .sl-modal .sl-modal-input:focus { border-color: var(--cyan, #22D3EE); }
    .sl-modal-row { display: flex; gap: 8px; }
    .sl-modal-row button { flex: 1; padding: 11px 14px; border: 1px solid var(--line); background: transparent; color: var(--fg); font: inherit; font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; cursor: pointer; transition: all 0.18s; }
    .sl-modal-row button:hover { border-color: var(--cyan, #22D3EE); color: var(--cyan, #22D3EE); }
    .sl-modal-row button.primary  { background: var(--cyan, #22D3EE); color: #000; border-color: var(--cyan, #22D3EE); font-weight: 600; }
    .sl-modal-row button.danger   { border-color: var(--red, #dc2626); color: var(--red, #dc2626); }
    .sl-modal-row button.danger:hover { background: var(--red, #dc2626); color: #000; }

    /* Inputs in panels — share the look (used by account.html send-stt form) */
    .sl-styled-input {
      width: 100%; box-sizing: border-box;
      padding: 9px 12px;
      background: rgba(0,0,0,0.35) !important;
      border: 1px solid var(--line, #1f1f23) !important;
      color: var(--fg, #fafafa) !important;
      font: inherit; font-family: "JetBrains Mono", monospace !important;
      font-size: 12px; letter-spacing: 0.5px; outline: none;
    }
    .sl-styled-input:focus { border-color: var(--cyan, #22D3EE) !important; }
    .sl-styled-input::placeholder { color: var(--fg-mute, #6b6b75); }
  `;
  document.head.appendChild(s);
}

function ensureToastWrap() {
  let wrap = document.querySelector(".sl-toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "sl-toast-wrap";
    document.body.appendChild(wrap);
  }
  return wrap;
}

// Auto-inject when loaded — keeps `.sl-styled-input` etc. styles available
// even before the first toast/confirm fires (used by account.html send-stt).
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectStylesOnce, { once: true });
  } else {
    injectStylesOnce();
  }
}

export function toast(message, { kind = "info", ttl = 3500 } = {}) {
  injectStylesOnce();
  const wrap = ensureToastWrap();
  const el = document.createElement("div");
  el.className = "sl-toast " + kind;
  el.textContent = message;
  wrap.appendChild(el);
  const remove = () => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 280);
  };
  el.addEventListener("click", remove);
  if (ttl > 0) setTimeout(remove, ttl);
  return remove;
}

export function confirmDialog(message, { title = "Confirm", yes = "Confirm", no = "Cancel", danger = false } = {}) {
  injectStylesOnce();
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "sl-modal-mask";
    mask.innerHTML = `
      <div class="sl-modal">
        <h3>${title}</h3>
        <p>${message}</p>
        <div class="sl-modal-row">
          <button data-act="no">${no}</button>
          <button class="${danger ? "danger" : "primary"}" data-act="yes">${yes}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = (v) => { mask.remove(); resolve(v); };
    mask.addEventListener("click", (e) => {
      const t = e.target;
      if (t.dataset.act === "yes") close(true);
      else if (t.dataset.act === "no" || t === mask) close(false);
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", onKey); close(false); }
      if (e.key === "Enter")  { document.removeEventListener("keydown", onKey); close(true); }
    });
  });
}

export function promptDialog(message, { title = "Input", initial = "", placeholder = "", okLabel = "Confirm", cancelLabel = "Cancel" } = {}) {
  injectStylesOnce();
  return new Promise((resolve) => {
    const mask = document.createElement("div");
    mask.className = "sl-modal-mask";
    mask.innerHTML = `
      <div class="sl-modal">
        <h3>${title}</h3>
        <p>${message}</p>
        <input class="sl-modal-input" data-inp type="text" value="${initial}" placeholder="${placeholder}" />
        <div class="sl-modal-row">
          <button data-act="cancel">${cancelLabel}</button>
          <button class="primary" data-act="ok">${okLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector("[data-inp]");
    setTimeout(() => input.focus(), 50);
    const close = (v) => { mask.remove(); resolve(v); };
    mask.addEventListener("click", (e) => {
      const t = e.target;
      if (t.dataset.act === "ok") close(input.value);
      else if (t.dataset.act === "cancel" || t === mask) close(null);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter")  close(input.value);
      if (e.key === "Escape") close(null);
    });
  });
}
