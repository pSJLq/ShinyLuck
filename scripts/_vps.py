# SSH/deploy helper for the ShinyPoker VPS (non-interactive, one connection).
# Usage:
#   python scripts/_vps.py "<remote command>"        — run a command, print output
#   python scripts/_vps.py --put <local> <remote>    — upload a file (md5-verified)
# Creds come from .env: IPv4New / UserNew / PasswordNew when present, else the
# legacy IP / LOGIN / PASS. (The original box died 2026-07-26; the New* names
# are what the replacement was handed over as.) Set VPS=old to force the legacy
# triple. The sshd's SFTP subsystem is not usable, so uploads stream through an
# exec channel (cat > file).
# Git-Bash mangles absolute POSIX args ("/root/x" -> "C:/Program Files/Git/root/x");
# we repair that here so callers don't need MSYS_NO_PATHCONV.
import sys, os, io, hashlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

def unmangle(p):
    for pref in ("C:/Program Files/Git", "C:\\Program Files\\Git"):
        if p.startswith(pref + "/root") or p.startswith(pref + "\\root"):
            return p[len(pref):].replace("\\", "/")
    return p

ENV = os.path.join(os.path.dirname(__file__), "..", ".env")
creds = {}
with open(ENV, encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("=")
            creds[k.strip()] = v.strip().strip('"').strip("'")

import paramiko

if os.environ.get("VPS") == "old" or "IPv4New" not in creds:
    host, user, pw = creds["IP"], creds["LOGIN"], creds["PASS"]
else:
    # The handover listed the address with a CIDR mask ("1.2.3.4/32").
    host = creds["IPv4New"].split("/")[0]
    user, pw = creds["UserNew"], creds["PasswordNew"]

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())

# Key first, password only as a fallback. A generated password once got changed
# on the box before it was ever recorded, which locked us out entirely and cost
# a provider-side reset; the key removes that single point of failure.
KEY = os.path.join(os.path.expanduser("~"), ".ssh", "shinyluck_vps")
try:
    if not os.path.exists(KEY):
        raise FileNotFoundError(KEY)
    cli.connect(host, username=user, key_filename=KEY, timeout=25,
                look_for_keys=False, allow_agent=False)
except Exception:
    cli.connect(host, username=user, password=pw, timeout=25,
                look_for_keys=False, allow_agent=False)

try:
    if sys.argv[1] == "--put":
        local, remote = sys.argv[2], unmangle(sys.argv[3])
        data = open(local, "rb").read()
        stdin, stdout, stderr = cli.exec_command(f"cat > '{remote}' && md5sum '{remote}'")
        stdin.write(data)
        stdin.channel.shutdown_write()
        out = stdout.read().decode()
        err = stderr.read().decode()
        code = stdout.channel.recv_exit_status()
        if code != 0:
            print("upload failed:", err, file=sys.stderr)
            sys.exit(code)
        if out.split()[0] != hashlib.md5(data).hexdigest():
            print(f"MD5 MISMATCH for {local}", file=sys.stderr)
            sys.exit(1)
        print(f"uploaded {local} -> {remote} ({len(data)} B, md5 ok)")
    else:
        # VPS_TIMEOUT for the slow ones (the InfoFi collector walks X for
        # minutes). Long jobs are still better off detached with nohup.
        stdin, stdout, stderr = cli.exec_command(
            sys.argv[1], timeout=float(os.environ.get("VPS_TIMEOUT", "120")))
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        code = stdout.channel.recv_exit_status()
        if out:
            print(out)
        if err:
            print("[stderr]", err, file=sys.stderr)
        sys.exit(code)
finally:
    cli.close()
