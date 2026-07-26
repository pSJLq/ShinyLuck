#!/usr/bin/env bash
# Daily Somnia InfoFi snapshot: run the X collector, publish to the live site.
# Deployed to /root/predictions/infofi-daily.sh, driven by cron:
#
#   17 4 * * * /root/predictions/infofi-daily.sh >> /var/log/infofi.log 2>&1
#
# The original of this script existed only on the VPS that died on 2026-07-26.
# It lives in the repo now.
set -uo pipefail

PRED=/root/predictions
SITE=/root/poker-web/frontend
PY="$PRED/oracle/.venv/bin/python"
LOCK=/tmp/infofi-daily.lock

# One run at a time. A collector still walking X when the next day fires would
# have both processes sharing oracle/accounts.db and racing history.json.
exec 9>"$LOCK"
if ! flock -n 9; then
	echo "[$(date -Is)] another run holds the lock, skipping"
	exit 0
fi

echo "[$(date -Is)] collecting"
cd "$PRED" || exit 1

# A throttled run is normal now and takes hours: X hands fresh scraper accounts a
# tiny timeline quota, so the collector spends most of its time waiting out
# 15-minute windows. The cap is generous enough not to kill a legitimately slow
# run, and short enough that a WEDGED one always releases the lock before the
# next nightly fire - otherwise one stuck process silently eats every following
# day's collection.
MAX_RUN_S=${INFOFI_MAX_RUN_S:-36000}   # 10h

if ! timeout -k 30 "$MAX_RUN_S" "$PY" infofi/collect.py --discover; then
	rc=$?
	if [ "$rc" -eq 124 ]; then
		echo "[$(date -Is)] collector hit the ${MAX_RUN_S}s cap and was stopped — previous snapshot stays live"
	else
		echo "[$(date -Is)] collector FAILED (exit $rc) — keeping the previous snapshot live"
	fi
	exit 1
fi

SNAP="$PRED/web/infofi-data.json"

# Publish only a snapshot that parses and carries rows. A truncated write (X
# rate-limited us halfway) must not replace a good file on the site: the page
# would render an empty treemap and look broken rather than stale.
if ! "$PY" - "$SNAP" <<'PY'; then
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
rows = d.get("projects") or []
assert rows, "snapshot has no rows"
assert any(r.get("score", 0) > 0 for r in rows), "every row scored zero"
print(f"  snapshot ok: {len(rows)} rows, generated {d.get('generated')}")
PY
	echo "[$(date -Is)] snapshot failed validation — NOT publishing"
	exit 1
fi

cp -f "$SNAP" "$SITE/infofi-data.json"

# Avatars are fetched by the collector and served from our own domain, so the
# page never hotlinks pbs.twimg.com (which blocks some referrers and leaks the
# visitor to X). Mirror, do not delete: a handle that drops out of today's
# window keeps its file for the history view.
if [ -d "$PRED/web/infofi-avatars" ]; then
	mkdir -p "$SITE/infofi-avatars"
	cp -f "$PRED"/web/infofi-avatars/*.jpg "$SITE/infofi-avatars/" 2>/dev/null
	echo "  avatars: $(find "$SITE/infofi-avatars" -name '*.jpg' | wc -l) on site"
fi

echo "[$(date -Is)] published"
