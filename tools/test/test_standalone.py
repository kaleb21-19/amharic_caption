#!/usr/bin/env python3
"""
test_standalone.py — end-to-end tests for the standalone SRT maker
(amh_standalone.py + amh_license.py) against a local MOCK license server.

Nothing here talks to the production Worker. A throwaway ECDSA P-256 keypair
(made with Node's crypto) stands in for the server's signing key, and the
tool's embedded public key is swapped for the test key in-process only.

Needs: node on PATH, ffmpeg (tools/stage/win-x64 or PATH), the CT2 model
(tools/stage/model-ct2-int8, or AMH_MODEL_DIR).

  python tools/test/test_standalone.py
"""
import builtins
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
FIXTURE = os.path.join(REPO, "tools", "test", "fixtures", "short1.wav")
MID = "a1b2c3d4e5f60718"
KEY = "AMH-" + "-".join((MID + "00000000" + "0123456789abcdef")[i:i + 4] for i in range(0, 40, 4))

os.environ.setdefault("AMH_MODEL_DIR", os.path.join(REPO, "tools", "stage", "model-ct2-int8"))
stage_ff = os.path.join(REPO, "tools", "stage", "win-x64")
if os.path.isdir(stage_ff):
    os.environ["PATH"] = stage_ff + os.pathsep + os.environ.get("PATH", "")

# ── test signing key + lease token for MID (Node crypto) ────────────────────
vec = json.loads(subprocess.check_output(["node", "-e", r"""
const c=require('crypto');
const {publicKey,privateKey}=c.generateKeyPairSync('ec',{namedCurve:'P-256'});
const msg=process.argv[1]+'|00000000';
const sig=c.sign('sha256',Buffer.from(msg),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('hex');
console.log(JSON.stringify({pem:publicKey.export({type:'spki',format:'pem'}),
  token:'v1.'+process.argv[1]+'00000000.'+sig}));
""", MID]).decode())

# ── mock license server ─────────────────────────────────────────────────────
STATE = {"used": 0, "max": 2, "online": True, "charges": 0, "validates": 0}


class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _gate(self):
        if not STATE["online"]:
            self.send_response(503)
            self.end_headers()
            return False
        return True

    def do_GET(self):
        if not self._gate():
            return
        if self.path.startswith("/api/trial?mid="):
            self._send({"used": STATE["used"], "max": STATE["max"],
                        "remaining": max(0, STATE["max"] - STATE["used"])})
        elif self.path == "/api/latest":
            self._send({"version": "9.9.9", "url": "https://amharic-caption-pro.vercel.app/install/"})
        else:
            self._send({"error": "nf"}, 404)

    def do_POST(self):
        if not self._gate():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path == "/api/trial/use":
            STATE["charges"] += 1
            charged = STATE["used"] < STATE["max"]
            if charged:
                STATE["used"] += 1
            self._send({"used": STATE["used"], "max": STATE["max"],
                        "remaining": max(0, STATE["max"] - STATE["used"]), "charged": charged})
        elif self.path == "/api/validate":
            STATE["validates"] += 1
            if body.get("mid") == MID and body.get("key") == KEY:
                self._send({"valid": True, "expiry": "00000000", "token": vec["token"]})
            else:
                self._send({"valid": False})
        else:
            self._send({"error": "nf"}, 404)


srv = ThreadingHTTPServer(("127.0.0.1", 0), Mock)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["AMH_API_URL"] = "http://127.0.0.1:%d" % srv.server_address[1]

import amh_license as lic  # noqa: E402  (reads AMH_API_URL at import)
import amh_standalone as tool  # noqa: E402

lic.verify_token.__defaults__ = (vec["pem"],)   # test key, this process only

HOME = tempfile.mkdtemp(prefix="amh_sa_home_")
WORK = tempfile.mkdtemp(prefix="amh_sa_work_")
os.environ["AMH_MACHINE_HOME"] = HOME
with open(os.path.join(HOME, ".amharic_captions_machine.json"), "w") as f:
    json.dump({"id": MID, "host": lic.host_fingerprint(), "hv": 2}, f)


def run(files, answers=()):
    """Run the tool in-process; feed input() answers; capture output."""
    it = iter(answers)
    orig = builtins.input
    builtins.input = lambda prompt="": next(it, "")
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            rc = tool.main(list(files))
    finally:
        builtins.input = orig
    return rc, buf.getvalue()


def clip(name):
    p = os.path.join(WORK, name)
    shutil.copy(FIXTURE, p)
    return p


passed = failed = 0


def t(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print("  [OK] " + name)
    except AssertionError as e:
        failed += 1
        print("  [FAIL] %s\n         %s" % (name, e))


def srts():
    return sorted(f for f in os.listdir(WORK) if f.endswith(".srt"))


def t1():
    rc, out = run([clip("a.wav")])
    assert rc == 0, out
    assert srts() == ["a.srt"], srts()
    txt = open(os.path.join(WORK, "a.srt"), encoding="utf-8").read()
    assert "-->" in txt and any("ሀ" <= ch <= "፿" for ch in txt), "srt has Amharic cues"
    assert STATE["used"] == 1 and STATE["charges"] == 1, STATE
    assert not any(f.endswith(".pending") for f in os.listdir(WORK))


def t2():
    rc, out = run([clip("b.wav")])
    assert rc == 0 and "b.srt" in srts(), out
    assert STATE["used"] == 2, STATE
    assert not os.path.exists(os.path.join(WORK, "a (2).srt"))


def t3():
    before = srts()
    rc, out = run([clip("c.wav")], answers=[""])   # no key -> quit
    assert rc == 1, out
    assert srts() == before, "no srt without trial or license"
    assert MID in out and "KALEB TEGEGEN" in out, "shows Machine ID + payment"


def t4():
    STATE["online"] = False
    before = srts()
    rc, out = run([clip("d.wav")], answers=[""])
    STATE["online"] = True
    assert rc == 1 and srts() == before, out
    assert "Internet needed" in out, out


def t5():
    rc, out = run([clip("e.wav")], answers=["AMH-0000-bad"])
    assert rc == 1 and "Invalid key format" in out, out
    rc, out = run([clip("e.wav")], answers=[KEY])
    assert rc == 0, out
    assert "e.srt" in srts(), srts()
    stored = json.load(open(os.path.join(HOME, ".amharic_captions_license.json")))
    assert stored["token"] == vec["token"] and stored["valid"] is True
    assert set(stored) == {"key", "valid", "expiry", "activated", "serverValidated", "token"}


def t6():
    charges = STATE["charges"]
    STATE["online"] = False                       # licensed works fully offline
    rc, out = run([clip("f.wav"), os.path.join(WORK, "f.wav")])
    STATE["online"] = True
    assert rc == 0, out
    assert "f.srt" in srts() and "f (2).srt" in srts(), "second run never overwrites"
    assert STATE["charges"] == charges, "licensed runs are never charged"


def t7():
    rc, out = run([os.path.join(WORK, "notes.txt")])
    assert rc == 1 and "Not a supported" in out, out


def t6b():
    orig = lic.installed_version
    try:
        lic.installed_version = lambda rt: "1.0.0"
        rc, out = run([clip("g.wav")])
        assert rc == 0 and "New version 9.9.9 is available" in out, out[-400:]
        lic.installed_version = lambda rt: "99.0.0"
        rc, out = run([clip("h.wav")])
        assert rc == 0 and "New version" not in out, "up to date: no notice"
        STATE["online"] = False
        lic.installed_version = lambda rt: "1.0.0"
        rc, out = run([clip("i.wav")])
        assert rc == 0 and "New version" not in out, "offline: silent, run still succeeds"
    finally:
        STATE["online"] = True
        lic.installed_version = orig


def t8():
    # a tampered stored lease is refused
    p = os.path.join(HOME, ".amharic_captions_license.json")
    stored = json.load(open(p))
    stored["token"] = stored["token"][:-2] + ("00" if stored["token"][-2:] != "00" else "11")
    json.dump(stored, open(p, "w"))
    assert lic.licensed(MID)[0] is False


print("standalone SRT maker (mock server %s)" % os.environ["AMH_API_URL"])
t("1. trial: first file transcribes, is charged once, srt delivered", t1)
t("2. trial: second file uses the last free transcription", t2)
t("3. trial used up: no srt, shows Machine ID + how to pay", t3)
t("4. offline + unlicensed: refuses, says internet is needed", t4)
t("5. activation: bad key rejected; good key stores the panel-format lease", t5)
t("6. licensed: works offline, never charged, never overwrites", t6)
t("6b. update notice after the run: newer shows, up to date / offline silent", t6b)
t("7. unsupported file type is refused", t7)
t("8. a tampered lease is not accepted", t8)
srv.shutdown()
shutil.rmtree(HOME, ignore_errors=True)
shutil.rmtree(WORK, ignore_errors=True)
print("\n" + ("ALL PASS" if failed == 0 else "FAILURES: %d" % failed) +
      "  (%d passed, %d failed)" % (passed, failed))
sys.exit(0 if failed == 0 else 1)
