// Tiny JSON-backed store. Sufficient for MVP; swap to SQLite later if needed.
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "strategies.json");

function ensureDir() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    return { strategies: {}, logs: [] };
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}

function save(state) {
  ensureDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
}

let cache = load();

function getStrategy(player) {
  return cache.strategies[player.toLowerCase()];
}

function listStrategies() {
  return Object.values(cache.strategies);
}

function upsertStrategy(player, strategy) {
  cache.strategies[player.toLowerCase()] = {
    player,
    ...strategy,
    updatedAt: Date.now(),
  };
  save(cache);
}

function setActive(player, active) {
  const s = cache.strategies[player.toLowerCase()];
  if (!s) return false;
  s.active = active;
  save(cache);
  return true;
}

function appendLog(entry) {
  cache.logs.push({ ...entry, ts: Date.now() });
  // cap log length
  if (cache.logs.length > 5000) cache.logs = cache.logs.slice(-5000);
  save(cache);
}

function getLogs(player, limit = 100) {
  const lower = player ? player.toLowerCase() : null;
  const arr = lower
    ? cache.logs.filter((l) => l.player && l.player.toLowerCase() === lower)
    : cache.logs;
  return arr.slice(-limit).reverse();
}

module.exports = {
  getStrategy,
  listStrategies,
  upsertStrategy,
  setActive,
  appendLog,
  getLogs,
};
