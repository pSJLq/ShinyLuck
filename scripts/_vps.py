# SSH/deploy helper for the ShinyPoker VPS (non-interactive, one connection).
# Usage:
#   python scripts/_vps.py "<remote command>"        — run a command, print output
#   python scripts/_vps.py --put <local> <remote>    — upload a file (md5-verified)
# Creds come from .env (IP / LOGIN / PASS). The sshd's SFTP subsystem is not
# usable, so uploads stream through an exec channel (cat > file).
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

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(creds["IP"], username=creds["LOGIN"], password=creds["PASS"], timeout=25)

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
        stdin, stdout, stderr = cli.exec_command(sys.argv[1], timeout=120)
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
