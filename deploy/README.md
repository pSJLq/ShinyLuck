# Rebuilding the box from zero

Runbook for standing up **shinyluck.win** (casino + poker + predictions) on a
fresh Ubuntu VPS.

Written on **2026-07-26**, the day the original VPS died with no warning and no
snapshot. Everything it held that was not in git had to be reconstructed from
memory and scratch files. The `Caddyfile`, the hardhat shim and the pm2 process
list now live here so that never costs a day again.

> **Rule:** if a file only exists on the server, it does not exist.

---

## 0. What runs where

| pm2 app | dir | port | what |
|---|---|---|---|
| `poker-web` | `/root/poker-web` | 80/443 | Caddy: static site, TLS, `/dealer` + `/rpc` routing |
| `poker` | `/root/shinyluck` | 3002 | poker dealer bot + `/dealer` API |
| `rpc-proxy` | `/root/shinyluck` | 3003 | chain proxy for players (retry + upstream failover) |
| `casino-reveal-v15` | `/root/casino-bot` | — | casino v15 settlement, one cashier lane per game |
| `pred-keeper` | `/root/predictions` | — | resolves / voids prediction markets |
| `pred-oracle` | `/root/predictions` | — | measures X metrics, publishes JSON |

Static site: `/root/poker-web/frontend` (mirror of the repo's `frontend/`).

---

## 1. Provision

```bash
# from the repo
python scripts/_vps.py --put deploy/bootstrap.sh /root/bootstrap.sh
python scripts/_vps.py "bash /root/bootstrap.sh"
```

Installs node v20.20.2 (nvm), pm2 + boot service, Caddy, swap, ufw, and the
directory skeleton. Idempotent.

Non-interactive shells do not read `.bashrc`, so **every** remote node command
needs the PATH prefix:

```bash
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH PM2_HOME=/root/.pm2
```

## 2. Code

```bash
python scripts/_vps.py "git clone https://github.com/pSJLq/ShinyLuck /root/shinyluck"
```

Then overlay anything not yet committed — check `git status` first. The working
tree has historically carried real deployed fixes that were never pushed; a
clean clone would silently roll them back.

Site files:

```bash
# tar the tree locally, stream it up, extract (142 files; one-by-one is 20 min)
tar -czf frontend.tgz -C frontend .
python scripts/_vps.py --put frontend.tgz /root/frontend.tgz
python scripts/_vps.py "mkdir -p /root/poker-web/frontend && tar -xzf /root/frontend.tgz -C /root/poker-web/frontend && rm /root/frontend.tgz"
```

Caddy config:

```bash
python scripts/_vps.py --put deploy/Caddyfile /root/poker-web/Caddyfile
python scripts/_vps.py --put deploy/ecosystem.config.js /root/ecosystem.config.js
```

## 3. Casino bot

`/root/casino-bot` is deliberately its own tree with its own `node_modules`:
the settlement hot path must not break because someone ran `npm install` in the
repo.

```
/root/casino-bot/
  scripts/reveal-bot-v15.js
  scripts/lib/mines-coordinator.js
  artifacts/contracts/v15/**            (compiled ABIs only, no .dbg.json)
  deployments/somniaTestnet-v15.json
  node_modules/ethers
  node_modules/hardhat/index.js         <- deploy/casino-bot/hardhat-shim.js
  .env                                  <- deploy/env-templates/casino-bot.env.example
```

```bash
python scripts/_vps.py "cd /root/casino-bot && npm init -y >/dev/null && npm i ethers@6"
# npm prunes the shim as an extraneous package — install it AFTER npm i, always
python scripts/_vps.py "mkdir -p /root/casino-bot/node_modules/hardhat"
python scripts/_vps.py --put deploy/casino-bot/hardhat-shim.js /root/casino-bot/node_modules/hardhat/index.js
python scripts/_vps.py --put deploy/casino-bot/package.json /root/casino-bot/node_modules/hardhat/package.json
```

## 4. Predictions

```
/root/predictions/
  scripts/keeper.js
  oracle/xoracle.py, accounts.db, accounts.secret.txt, requirements.txt
  oracle/.venv/                         python3 -m venv + pip install -r
  x-oracle/*.json
  .env
```

```bash
python scripts/_vps.py "cd /root/predictions && npm i ethers@6 dotenv && \
  python3 -m venv oracle/.venv && oracle/.venv/bin/pip install -q -r oracle/requirements.txt"
```

Cron (InfoFi daily roll-up):

```
17 4 * * * /root/predictions/infofi-daily.sh
```

⚠️ The X scraper account was previously trusted on the old datacenter IP. A new
IP can trigger a login challenge — check `pred-oracle` logs after the move and
re-add cookies if it complains.

## 5. Secrets

Three `.env` files, none of them in git. Templates in `deploy/env-templates/`.

| file | from |
|---|---|
| `/root/casino-bot/.env` | `v15-keys.json` (deployerPk, SEED_MASTER_KEY, CASHIER_MASTER_KEY) |
| `/root/shinyluck/.env` | repo `.env` (POKER_DEPLOYER_KEY, POKER_SEED_MASTER_KEY) |
| `/root/predictions/.env` | predictions repo `.env` |

**Keep `v15-keys.json` somewhere durable.** It holds the owner of the casino
Vault; losing it means losing the bankroll and the ability to settle. It has
been living in a temp scratchpad, which is exactly the kind of place that
disappears.

## 6. Start

```bash
export PATH=/root/.nvm/versions/node/v20.20.2/bin:$PATH PM2_HOME=/root/.pm2
caddy validate --config /root/poker-web/Caddyfile     # before anything binds :443
pm2 start /root/ecosystem.config.js
pm2 save
```

## 7. DNS cutover

`A` and `AAAA` for **shinyluck.win**, **www.shinyluck.win**, **shinia.mom** to
the new box. Caddy issues Let's Encrypt certs on first request once DNS
resolves and 80/443 are reachable — nothing to copy from the old server.

Certs land in `/root/.local/share/caddy`. Watch the first issuance:

```bash
pm2 logs poker-web --lines 50
```

## 8. Verify

```bash
curl -sS https://shinyluck.win/                       | head -5
curl -sS https://shinyluck.win/dealer/health          # dealer: ok + table count
curl -sS -X POST https://shinyluck.win/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
curl -sSI https://shinia.mom/poker                    # expect 301 -> shinyluck.win/poker
```

Then in a browser (hard refresh — config files cache):
all seven games place and settle, poker lobby lists tables, `/predictions`
loads, wins feed populates, `/admin` unlocks for the owner wallet.

## 9. Gotchas that cost real time on 2026-07-26

- **Caddy is not in apt on Ubuntu 26.04.** The cloudsmith repo is keyed by distro
  codename and "resolute" is not built. `bootstrap.sh` takes the binary straight
  from the GitHub release instead.
- **`@noble/curves` must be the 1.x line.** The poker dealer boots the zk layer
  through `frontend/poker/zk-bn254.js`, which wants `bn254.G1.ProjectivePoint`;
  2.x moved it and the dealer crash-loops with *"Cannot read properties of
  undefined"*. `scripts/lib/zk-verify-worker.js` also opens
  `node_modules/@noble/curves/bn254.js` by path, which only exists in the 1.x
  layout. Note the dependency is reached through an ESM `import`, so grepping
  for `require(` does not find it.
- **The repo manifest is not installable on the box.** It pulls hardhat, react
  and privy and dies on a peer conflict. The dealer needs `ethers`, `dotenv` and
  `@noble/curves` only — they live in `/root/dealer-deps` with a symlink at
  `/root/shinyluck/node_modules`, which keeps `git pull` working.
- **`npm init -y` rewrites an existing package.json.** It did, in the checkout.
  `git checkout -- package.json` undoes it.
- **`_vps.py` exec channel times out at 120s.** Set `VPS_TIMEOUT` for slower
  commands; anything measured in minutes (the InfoFi collector runs 15–25) is
  better launched with `nohup` and polled.
- **Print a generated secret BEFORE using it.** A first-login password rotation
  that fails after `passwd` but before the value is recorded locks you out of
  the box entirely. That happened here and needed a provider-side reset.

## 10. Do not touch

`dreamdex` / `dreamdex-mm` were a third party's processes on the old box. They
are **not** part of this deployment and must not be recreated here.
