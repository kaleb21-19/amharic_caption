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
  * (1.10.6) the engine's own functions — what someone calls after loading
    it from Python — refuse until a check passes; permission ends with the job

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
  minutes: 't2.' + mid + '.run-5678.' + later + '.90.' + sign('trial2|' + mid + '|run-5678|' + later + '|90'),
  minutesMore: 't2.' + mid + '.run-5678.' + later + '.900.' + sign('trial2|' + mid + '|run-5678|' + later + '|90'),
  minutesAsT1: 't1.' + mid + '.run-5678.' + later + '.' + sign('trial2|' + mid + '|run-5678|' + later + '|90'),
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

# The model itself (1.10.6): loading the engine from Python and calling its
# functions directly — skipping every front door above — is refused too.
import io  # noqa: E402
import numpy as np  # noqa: E402

print("\nthe model itself refuses without permission (1.10.6)")
eng = object.__new__(E._CT2Engine)            # no model needed: refused first
eng.prefetch, eng.glyphs = None, {}
tch = object.__new__(E._TorchEngine)
wav = np.zeros(16000 * 3, dtype=np.float32)


def refused(fn):
    try:
        fn()
        return False
    except E.LicenseRequired:
        return True
    except Exception as e:
        print("        (raised %s: %s)" % (type(e).__name__, e))
        return False


E.end_permit()
check("the terminal recipe (load engine, call _run_file) -> refused",
      refused(lambda: E._run_file(eng, wav, "grouped", 3, 42, 0.0, None)))
check("engine.transcribe -> refused", refused(lambda: eng.transcribe(wav)))
check("one window (_transcribe_one) -> refused", refused(lambda: eng._transcribe_one(wav)))
check("the model step (_encode) -> refused", refused(lambda: eng._encode(wav)))
check("the text step (_align) -> refused", refused(lambda: eng._align(wav, None)))
check("dev torch engine -> refused", refused(lambda: tch._transcribe_one(wav)))
check("a failed check gives no permission", not allowed(lease=keys["leaseOther"]) and refused(E._need_permit))
check("a lease for this computer gives permission", allowed(lease=keys["lease"]) and not refused(E._need_permit))
check("a failed check after a good one takes it back",
      not allowed(ticket=keys["expired"]) and refused(E._need_permit))
allowed(ticket=keys["ticket"])
E.end_permit()
check("permission ends with the job (end_permit)", refused(E._need_permit))

# the warm worker: permission lasts one request
orig_in, orig_load = sys.stdin, E.load_pipeline
E.load_pipeline = lambda: eng
sys.stdin = io.StringIO(json.dumps({"id": 1, "wav": "nope.wav", "lease": keys["lease"]}) + "\n")
out = io.StringIO()
orig_out, sys.stdout = sys.stdout, out
try:
    E.run_server()
finally:
    sys.stdin, sys.stdout, E.load_pipeline = orig_in, orig_out, orig_load
check("warm worker: a licensed request's permission ends with it",
      '"audio file not found' in out.getvalue() and refused(E._need_permit))

# Free minutes (1.10.7): the ticket says how many seconds this job may hear.
print("\nfree minutes: the ticket's seconds (1.10.7)")
check("a free-minutes ticket (t2) for this computer -> allowed", allowed(ticket=keys["minutes"]))
check("it allows exactly its 90 seconds", E.permit_samples_left() == 90 * 16000)
check("seconds changed after signing -> refused", not allowed(ticket=keys["minutesMore"]))
check("a t2 signature dressed as t1 (no limit) -> refused", not allowed(ticket=keys["minutesAsT1"]))
check("a license has no limit", allowed(lease=keys["lease"]) and E.permit_samples_left() is None)
allowed(ticket=keys["minutes"])
long_wav = np.zeros(16000 * 300, dtype=np.float32)
cut_wav, cut = E._trial_cut(long_wav)
check("a 5-minute clip is cut to the 90 free seconds", len(cut_wav) == 90 * 16000 and cut == 90.0)
check("a short clip is not cut", E._trial_cut(long_wav[:16000 * 30])[1] is None)
try:
    E._count_audio(90 * 16000)
    within = True
except E.LicenseRequired:
    within = False
check("the model may hear the 90 seconds", within)
check("but not a second more (backstop inside the model)", refused(lambda: E._count_audio(3 * 16000)))


class Stub:
    glyphs = {}
    prefetch = None
    heard = 0

    def transcribe(self, w):
        Stub.heard += len(w)
        return "", [], 1.0 / 16000.0


import soundfile as sf  # noqa: E402
wavp = os.path.join(HOME, "five_min.wav")
sf.write(wavp, long_wav, 16000)
allowed(ticket=keys["minutes"])
out = io.StringIO()
E.handle_server_one(Stub(), {"wav": wavp, "ticket": keys["minutes"]}, 7, out)
res = json.loads(out.getvalue().strip().splitlines()[-1])
check("warm worker: a 5-minute clip on 90 free seconds hears 90 s and says where it stopped",
      Stub.heard == 90 * 16000 and res.get("trial_cut") == 90.0)
Stub.heard = 0
allowed(ticket=keys["minutes"])
out = io.StringIO()
E.handle_server_batch(Stub(), {"batch": [{"wav": wavp, "offset": 0}, {"wav": wavp, "offset": 300}], "ticket": keys["minutes"]}, 8, out)
res = json.loads(out.getvalue().strip().splitlines()[-1])
check("warm worker batch: one 90 s budget across the clips", Stub.heard == 90 * 16000 and res.get("trial_cut") == 90.0)
E.end_permit()

import shutil  # noqa: E402
shutil.rmtree(HOME, ignore_errors=True)
print("\nALL PASS" if fails == 0 else "\n%d FAILED" % fails)
sys.exit(1 if fails else 0)
