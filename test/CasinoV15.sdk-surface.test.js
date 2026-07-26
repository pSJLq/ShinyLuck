// Every `SL.<member>` the frontend touches must exist on the v15 SDK.
// A missing one is invisible until a page hits it at runtime and dies with
// "SL.x is not a function" — which is exactly how the v15 cutover broke
// production (SL.getNativeBalance). This test makes that a build failure.
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const FRONTEND = path.join(__dirname, "..", "frontend");
const SDK_PATH = path.join(FRONTEND, "lib", "shinyluck-sdk-v15.js");

/** Every file that can reference SL. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "vendor" || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

describe("v15 SDK surface covers every SL.* the frontend calls", () => {
  it("no page references a member the SDK does not define", () => {
    const sdk = fs.readFileSync(SDK_PATH, "utf8");

    // Members the SDK defines: methods, `this.x =` fields, and getters.
    const defined = new Set();
    for (const m of sdk.matchAll(/^\s{2}(?:async\s+)?([a-zA-Z_][\w]*)\s*\(/gm)) defined.add(m[1]);
    for (const m of sdk.matchAll(/this\.([a-zA-Z_][\w]*)\s*=/g)) defined.add(m[1]);
    for (const m of sdk.matchAll(/^\s{2}get\s+([a-zA-Z_][\w]*)\s*\(/gm)) defined.add(m[1]);

    // Members the frontend uses.
    const used = new Map(); // member -> first file that uses it
    for (const f of walk(FRONTEND)) {
      if (f === SDK_PATH) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bSL\.([a-zA-Z_][\w]*)/g)) {
        if (!used.has(m[1])) used.set(m[1], path.relative(FRONTEND, f));
      }
    }

    // `SL` is also a common local alias in JSX (e.g. a React import); ignore
    // members that are obviously not ours.
    const NOT_OURS = new Set(["createElement", "forwardRef", "Fragment", "useState", "useEffect"]);

    const missing = [...used.entries()]
      .filter(([k]) => !defined.has(k) && !NOT_OURS.has(k))
      .map(([k, f]) => `${k}  (used in ${f})`);

    expect(missing, "SDK is missing:\n  " + missing.join("\n  ")).to.deep.equal([]);
  });

  it("every SL.casino.<x> the frontend calls is answered by the Vault or the facade", () => {
    const sdk = fs.readFileSync(SDK_PATH, "utf8");
    // Names the Vault ABI declares...
    const vaultAbi = (sdk.match(/const VAULT_ABI = \[([\s\S]*?)\];/) || [])[1] || "";
    const answered = new Set([...vaultAbi.matchAll(/(?:function|event)\s+(\w+)/g)].map((m) => m[1]));
    // ...plus the v14-era names the facade re-routes to other v15 contracts.
    const facade = (sdk.match(/const extra = \{([\s\S]*?)\n    \};/) || [])[1] || "";
    for (const m of facade.matchAll(/^\s{6}(\w+):/gm)) answered.add(m[1]);
    // ethers.Contract intrinsics the pages legitimately touch.
    for (const k of ["interface", "target", "connect", "filters", "queryFilter", "on", "off"]) answered.add(k);

    const missing = [];
    for (const f of walk(FRONTEND)) {
      if (f === SDK_PATH) continue;
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bSL\.casino\.(\w+)/g)) {
        if (!answered.has(m[1])) missing.push(`${m[1]}  (in ${path.relative(FRONTEND, f)})`);
      }
    }
    const uniq = [...new Set(missing)];
    expect(uniq, "SL.casino has no route for:\n  " + uniq.join("\n  ")).to.deep.equal([]);
  });

  // Existence is not enough: a member can exist and still blow up at the call
  // site. `autoClaim` was a plain method returning undefined while all seven
  // call sites did `SL.autoClaim().catch(...)`, so every settle threw
  // "Cannot read properties of undefined (reading 'catch')" — on the line
  // right after the bet resolved, in all seven games, unnoticed because it
  // shipped without a click-through.
  it("every SL.* the frontend awaits or chains actually returns a promise", () => {
    const sdk = fs.readFileSync(SDK_PATH, "utf8");

    // Method bodies, so we can tell an async method from one that merely
    // schedules something and returns nothing.
    const bodies = new Map();
    const re = /^ {2}(async\s+)?([a-zA-Z_][\w]*)\s*\([^)]*\)\s*\{/gm;
    for (let m; (m = re.exec(sdk)); ) {
      const start = m.index + m[0].length;
      let depth = 1, i = start;
      while (i < sdk.length && depth > 0) {
        const ch = sdk[i++];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      bodies.set(m[2], { isAsync: Boolean(m[1]), body: sdk.slice(start, i) });
    }

    const thenable = (name) => {
      const d = bodies.get(name);
      if (!d) return true;                       // not an SDK method; other test covers that
      if (d.isAsync) return true;
      // Hands back something awaitable: builds/forwards a Promise, delegates to
      // another method on `this`, or chains. `return;` with no value — what
      // autoClaim used to do — matches none of these.
      return /Promise|return\s+this\.|return\s+await\s|\.then\s*\(/.test(d.body);
    };

    const offenders = [];
    for (const f of walk(FRONTEND)) {
      if (f === SDK_PATH) continue;
      const src = fs.readFileSync(f, "utf8");
      // SL.foo(...)  followed by .catch / .then, or preceded by await.
      for (const m of src.matchAll(/\bSL\.([a-zA-Z_][\w]*)\??\.?\([^;]*?\)\s*\.\s*(catch|then)\b/g)) {
        if (!thenable(m[1])) offenders.push(`SL.${m[1]}().${m[2]}()  in ${path.relative(FRONTEND, f)}`);
      }
      for (const m of src.matchAll(/\bawait\s+SL\.([a-zA-Z_][\w]*)\s*\(/g)) {
        if (!thenable(m[1])) offenders.push(`await SL.${m[1]}()  in ${path.relative(FRONTEND, f)}`);
      }
    }

    const uniq = [...new Set(offenders)];
    expect(uniq, "these SDK members do not return a promise:\n  " + uniq.join("\n  ")).to.deep.equal([]);
  });
});
