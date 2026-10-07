#!/usr/bin/env python3
"""
test_engine_license.py — the transcription engine refuses to work without
permission for THIS computer (1.10.3).

Before 1.10.3 running ethio_srt.py directly, or a panel edited to skip its
license check, gave free captions. Now every job needs the license lease
(server-signed, bound to the Machine ID) or a server-signed trial ticket for
one free caption. Checked here with a throwaway signing key and a throwaway
home folder (the real license / machine files are never touched):

  * no permission -> refused (server request, command line exits 3)
  * a lease for this computer, passed or stored -> allowed
  * a lease for another computer, or with a broken signature -> refused
  * a trial ticket for this computer and run, not expired -> allowed
  * expired / other computer / tampered / lease-shaped tickets -> refused

No model needed (permission is checked before any audio is read).

  python tools/test/test_engine_license.py
"""
import json
import os
import subprocess
import sys
import tempfile
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
HOME = tempfile.mkdtemp(prefix="amh_gate_home_")
os.environ["AMH_MACHINE_HOME"] = HOME
MID = "a1b2c3d4e5f60718"
OTHER = "0f1e2d3c4b5a6978"
with open(os.path.join(HOME, ".amharic_captions_machine.json"), "w", encoding="utf-8") as f:
    json.dump({"id": MID, "host": None, "hv": 2}, f)

NOW = int(time.time())
keys = json.loads(subprocess.check_output(["node", "-e", r"""
const c=require('crypto');
const {publicKey,privateKey}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});
const sign=(m)=>c.sign('sha256',Buffer.from(m),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('hex');
const [mid, other, now] = process.argv.slice(1);
const later = Number(now) + 7200, past = Number(now) - 60;
console.log(JSON.stringify({
  pem: publicKey.export({type:'spki',format:'pem'}),
  lease: 'v1.' + mid + '00000000.' + sign(mid + '|00000000'),
  leaseOther: 'v1.' + other + '00000000.' + sign(other + '|00000000'),
  ticket: 't1.' + mid + '.run-1234.' + later + '.' + sign('trial|' + mid + '|run-1234|' + later),
  ticketDotRun: 't1.' + mid + '.run.with.dots.' + later + '.' + sign('trial|' + mid + '|run.with.dots|' + later),
  expired: 't1.' + mid + '.run-1234.' + past + '.' + sign('trial|' + mid + '|run-1234|' + past),
  ticketOther: 't1.' + other + '.run-1234.' + later + '.' + sign('trial|' + other + '|run-1234|' + later),
  leaseAsTicket: 't1.' + mid + '.run-1234.' + later + '.' + sign(mid + '|00000000'),
}));
""", MID, OTHER, str(NOW)]).decode())

import amh_license as lic  # noqa: E402
import ethio_srt as E  # noqa: E402

lic.verify_token.__defaults__ = (keys["pem"],)          # test key, this process only
lic.verify_ticket.__defaults__ = (keys["pem"], None)

fails = 0


def check(name, cond):
    global fails
    print(("  [OK] " if cond else "  [FAIL] ") + name)
    if not cond:
        fails += 1


def allowed(lease=None, ticket=None):
    try:
        E.require_license(lease, ticket)
        return True
    except E.LicenseRequired:
        return False


def tamper(tok):
    return tok[:-2] + ("00" if tok[-2:] != "00" else "11")


print("engine permission (ethio_srt.require_license)")
check("no license, no ticket -> refused", not allowed())
check("lease for this computer -> allowed", allowed(lease=keys["lease"]))
check("lease for another computer -> refused", not allowed(lease=keys["leaseOther"]))
check("lease with a broken signature -> refused", not allowed(lease=tamper(keys["lease"])))
check("trial ticket for this computer -> allowed", allowed(ticket=keys["ticket"]))
check("trial ticket whose run id has dots -> allowed", allowed(ticket=keys["ticketDotRun"]))
check("expired trial ticket -> refused", not allowed(ticket=keys["expired"]))
check("trial ticket for another computer -> refused", not allowed(ticket=keys["ticketOther"]))
check("tampered trial ticket -> refused", not allowed(ticket=tamper(keys["ticket"])))
check("a lease signature dressed as a ticket -> refused", not allowed(ticket=keys["leaseAsTicket"]))
check("a ticket passed as a lease -> refused", not allowed(lease=keys["ticket"]))

lic_path = os.path.join(HOME, ".amharic_captions_license.json")
with open(lic_path, "w", encoding="utf-8") as f:
    json.dump({"key": "x", "valid": True, "token": keys["lease"]}, f)
check("license stored on this computer -> allowed without passing it", allowed())
with open(lic_path, "w", encoding="utf-8") as f:
    json.dump({"key": "x", "valid": True, "token": keys["leaseOther"]}, f)
check("a license file copied from another computer -> refused", not allowed())
os.remove(lic_path)

# the warm worker refuses the job before touching the audio
try:
    E.handle_server_one(None, {"wav": "nope.wav"}, 1, sys.stdout)
    refused = False
except E.LicenseRequired as e:
    refused = "license required" in str(e)
check("server request without permission -> refused before reading audio", refused)

# the command line (real public key, empty home): "python ethio_srt.py x.wav"
r = subprocess.run([sys.executable, os.path.join(REPO, "ethio_srt.py"), "x.wav", "x.srt"],
                   capture_output=True, text=True, env=dict(os.environ, AMH_MACHINE_HOME=HOME))
check("running the engine directly without a license -> exit 3, 'license required'",
      r.returncode == 3 and "license required" in r.stderr)
r = subprocess.run([sys.executable, os.path.join(REPO, "ethio_srt.py"), "x.wav", "x.srt", "--lease", keys["lease"]],
                   capture_output=True, text=True, env=dict(os.environ, AMH_MACHINE_HOME=HOME))
check("a lease signed by anyone but the real server -> refused on the command line", r.returncode == 3)

import shutil  # noqa: E402
shutil.rmtree(HOME, ignore_errors=True)
print("\nALL PASS" if fails == 0 else "\n%d FAILED" % fails)
sys.exit(1 if fails else 0)
