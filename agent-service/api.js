// HTTP API for the agent-service. Frontend posts NL strategy text + signed
// proof from the player; the server stores it and the scheduler executes.

const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");
const db = require("./db");
const { parseStrategy } = require("./strategies/parser");

function build(ctx) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // POST /quote { raw } → { priceSTT, complexity, reasoning }
  //
  // Routes the strategy text to the Somnia LLM Inference Agent (when
  // SOMNIA_LLM_URL is set) and asks it to rate complexity 1-5 + suggest a
  // setup price + write a one-line justification. Falls back to a heuristic
  // when the LLM endpoint is unreachable so the UI keeps working.
  app.post("/quote", async (req, res) => {
    try {
      const raw = (req.body && req.body.raw) || "";
      if (!raw || raw.length > 4000) return res.status(400).json({ error: "bad raw" });
      const url = process.env.SOMNIA_LLM_URL;
      let quote = null;
      if (url) {
        const prompt =
          "Evaluate this trading strategy for an on-chain casino. Rate complexity 1-5 and " +
          "estimate a fair one-time setup fee in STT (between 0 and 1). Reply ONLY with JSON " +
          `{"complexity": N, "priceSTT": "X", "reasoning": "..."}.\nSTRATEGY:\n${raw}`;
        try {
          const r = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt, max_tokens: 220 }),
          });
          if (r.ok) {
            const j = await r.json();
            const txt = j.text || j.response || j.completion || "";
            const m = txt.match(/\{[\s\S]*\}/);
            if (m) quote = JSON.parse(m[0]);
          }
        } catch (_) {}
      }
      if (!quote) {
        // Heuristic fallback: words → complexity, fixed 0.1 STT base + 0.05/comp.
        const words = raw.split(/\s+/).length;
        const complexity = Math.max(1, Math.min(5, Math.ceil(words / 8)));
        const price = (0.1 + 0.05 * complexity).toFixed(3);
        quote = {
          complexity,
          priceSTT: price,
          reasoning: `Local heuristic: ${words} words → complexity ${complexity}. ` +
                     `Setup fee 0.1 + 0.05 × complexity = ${price} STT. ` +
                     `Configure SOMNIA_LLM_URL for richer agent quotes.`,
        };
      }
      // Clamp price to a sane range.
      const p = parseFloat(quote.priceSTT);
      quote.priceSTT = (isFinite(p) ? Math.max(0, Math.min(1, p)) : 0.15).toFixed(3);
      res.json(quote);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/strategies", (_req, res) => {
    res.json(db.listStrategies().map(stripPrivate));
  });

  app.get("/strategies/:player", (req, res) => {
    const s = db.getStrategy(req.params.player);
    if (!s) return res.status(404).json({ error: "not found" });
    res.json(stripPrivate(s));
  });

  app.get("/logs/:player", (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json(db.getLogs(req.params.player, limit));
  });

  // Player POSTs: { player, vault, raw, signature }
  // signature = personalSign(player, JSON.stringify({ raw, vault })) so we know
  // the player approved the strategy. Vault must be the address registered
  // on-chain (registry.permissions[player].vault).
  app.post("/strategies", async (req, res) => {
    try {
      const { player, vault, raw, signature } = req.body;
      if (!player || !vault || !raw || !signature) {
        return res.status(400).json({ error: "missing fields" });
      }
      const message = JSON.stringify({ raw, vault });
      const recovered = ethers.verifyMessage(message, signature);
      if (recovered.toLowerCase() !== player.toLowerCase()) {
        return res.status(401).json({ error: "bad signature" });
      }
      // Cross-check vault ownership against registry.
      const perm = await ctx.registry.getPermission(player);
      if (perm.vault.toLowerCase() !== vault.toLowerCase()) {
        return res.status(400).json({ error: "vault mismatch" });
      }
      if (!perm.active) {
        return res.status(400).json({ error: "registry permission inactive" });
      }
      const parsed = parseStrategy(raw);
      const strategy = {
        player,
        vault,
        ...parsed,
        // Per-user agent cadence (seconds). User chooses how often their agent
        // plays and funds every tick. From the NL strategy ("every 30s") or an
        // explicit body field; default 30s, floored at 3s. No upper cap.
        cadenceSec: Math.max(3, Number(parsed.cadenceSec ?? req.body.cadenceSec) || 30),
        active: true,
        consecutiveWins: 0,
        lossesTodaySTT: 0,
        registeredAt: Date.now(),
      };
      db.upsertStrategy(player, strategy);
      db.appendLog({ player, kind: "strategy-saved", game: strategy.game });
      res.json(stripPrivate(strategy));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/strategies/:player/pause", (req, res) => {
    const ok = db.setActive(req.params.player, false);
    if (!ok) return res.status(404).json({ error: "not found" });
    db.appendLog({ player: req.params.player, kind: "paused" });
    res.json({ ok: true });
  });

  app.post("/strategies/:player/resume", (req, res) => {
    const ok = db.setActive(req.params.player, true);
    if (!ok) return res.status(404).json({ error: "not found" });
    db.appendLog({ player: req.params.player, kind: "resumed" });
    res.json({ ok: true });
  });

  return app;
}

function stripPrivate(s) {
  // No secrets in strategy currently, but keep this hook in case keys are added.
  return s;
}

module.exports = { build };
