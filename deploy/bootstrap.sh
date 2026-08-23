#!/usr/bin/env bash
# Provision a bare Ubuntu box to run ShinyLuck + ShinyPoker + Predictions.
# Idempotent: safe to re-run. Run as root.
#
#   bash /root/bootstrap.sh
#
# What it does NOT do: upload app code, write .env files, or start pm2 apps —
# those are separate steps in deploy/README.md so a re-run can never clobber
# live secrets or state.
set -euo pipefail

NODE_VERSION=v20.20.2

echo "=== base packages ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
	curl git ca-certificates gnupg unzip jq \
	build-essential \
	python3 python3-venv python3-pip \
	debian-keyring debian-archive-keyring apt-transport-https

echo "=== swap (the old box ran with none and 2 GB RAM) ==="
if ! swapon --show | grep -q .; then
	fallocate -l 2G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile >/dev/null
	swapon /swapfile
	grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

echo "=== node ${NODE_VERSION} via nvm ==="
export NVM_DIR=/root/.nvm
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
	curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
NODE_BIN="$NVM_DIR/versions/node/$NODE_VERSION/bin"

# Every later step and every runbook command assumes node is on PATH for
# non-interactive shells; paramiko exec channels do not read .bashrc.
grep -q 'nvm/versions/node' /root/.profile 2>/dev/null || \
	echo "export PATH=$NODE_BIN:\$PATH" >>/root/.profile

echo "=== pm2 ==="
"$NODE_BIN/npm" install -g pm2@latest >/dev/null
export PM2_HOME=/root/.pm2
"$NODE_BIN/pm2" startup systemd -u root --hp /root >/dev/null

echo "=== caddy ==="
# Straight from the GitHub release, not the apt repo: the cloudsmith repo is
# keyed by distro codename and lags new releases (Ubuntu 26.04 "resolute" is
# not in it). We run Caddy under pm2 as root anyway — the packaged systemd unit
# and `caddy` user would only get in the way, since the site root is under
# /root (mode 700) and that user cannot read it.
if ! command -v caddy >/dev/null; then
	CADDY_VER=$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest \
		| jq -r .tag_name | sed 's/^v//')
	[ -n "$CADDY_VER" ] && [ "$CADDY_VER" != "null" ] || { echo "cannot resolve caddy version"; exit 1; }
	curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VER}/caddy_${CADDY_VER}_linux_amd64.tar.gz" \
		-o /tmp/caddy.tgz
	tar -xzf /tmp/caddy.tgz -C /tmp caddy
	install -m 0755 /tmp/caddy /usr/local/bin/caddy
	rm -f /tmp/caddy.tgz /tmp/caddy
fi
# Binding :80/:443 needs the capability when not started as root by systemd;
# harmless to set either way.
setcap cap_net_bind_service=+ep "$(command -v caddy)" 2>/dev/null || true

echo "=== directories ==="
mkdir -p /root/poker-web/frontend /root/casino-bot /root/shinyluck /root/predictions /root/backups
ln -sf "$(command -v caddy)" /root/poker-web/caddy

echo "=== firewall ==="
if command -v ufw >/dev/null; then
	ufw allow 22/tcp   >/dev/null 2>&1 || true
	ufw allow 80/tcp   >/dev/null 2>&1 || true
	ufw allow 443/tcp  >/dev/null 2>&1 || true
	# 3002/3003 stay closed: reachable only through Caddy on loopback.
	yes | ufw enable    >/dev/null 2>&1 || true
fi

echo
echo "=== done ==="
"$NODE_BIN/node" --version
"$NODE_BIN/pm2" --version
caddy version
free -m | head -2
