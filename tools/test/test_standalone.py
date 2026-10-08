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
import time

# The SRT maker opens Explorer/Finder on the result and copies the Machine ID
# to the clipboard; a test run must do neither.
os.environ["AMH_NO_OPEN"] = "1"
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
FIXTURE = os.path.join(REPO, "tools", "test", "fixtures", "short1.wav")
LONGER = os.path.join(REPO, "tools", "test", "fixtures", "interview.wav")      # ~15 s
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
  priv:privateKey.export({type:'pkcs8',format:'pem'}),
  token:'v1.'+process.argv[1]+'00000000.'+sig}));
""", MID]).decode())



def sign_ticket(mid, run, secs):
    """A free-minutes ticket like the Worker's signTicket2 (test key)."""
    until = str(int(time.time()) + 7200)
    sig = subprocess.check_output(["node", "-e", r"""
const c=require('crypto');
process.stdout.write(c.sign('sha256',Buffer.from(process.argv[2]),
  {key:process.env.AMH_TEST_PRIV,dsaEncoding:'ieee-p1363'}).toString('hex'));
""", "sign", "trial2|%s|%s|%s|%d" % (mid, run, until, secs)],
                                  env=dict(os.environ, AMH_TEST_PRIV=vec["priv"])).decode()
    return "t2.%s.%s.%s.%d.%s" % (mid, run, until, secs, sig)


# ── mock license server ─────────────────────────────────────────────────────
# Free minutes (1.10.7): "grant" is None until the person opens the bot link
# (the mock "opens" it as soon as the link is handed out).
STATE = {"online": True, "charges": 0, "validates": 0, "tickets": True, "refunds": 0,
         "grant": None, "links": 0}


def minutes_state():
    g = STATE["grant"]
    if not g:
        return {"mode": "minutes", "status": "none", "minutes": 20, "seconds_total": 0, "seconds_left": 0}
    return {"mode": "minutes", "status": g["status"], "minutes": 20, "seconds_total": g["total"],
            "seconds_left": max(0, g["total"] - g["used"])}


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
        if self.path.startswith("/api/trial?v=2&mid="):
            self._send(minutes_state())
        elif self.path == "/api/latest":
            self._send({"version": "9.9.9", "url": "https://amharic-caption-pro.vercel.app/install/"})
        else:
            self._send({"error": "nf"}, 404)

    def do_POST(self):
        if not self._gate():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])) or b"{}")
        if self.path == "/api/trial/request":
            STATE["links"] += 1
            res = minutes_state()
            if res["status"] == "none":
                res.update(nonce="abcdefghijklmnop", link="https://t.me/AmharicCaptionsBot?start=t_abcdefghijklmnop")
                STATE["grant"] = {"status": "active", "total": 1200, "used": 0}   # the person taps START
            self._send(res)
        elif self.path == "/api/trial/use":
            STATE["charges"] += 1
            g = STATE["grant"]
            left = max(0, g["total"] - g["used"]) if g and g["status"] == "active" else 0
            give = min(int(body["seconds"]), left)
            if give > 0:
                g["used"] += give
            res = dict(minutes_state(), charged=give > 0, seconds=give)
            if give > 0 and STATE["tickets"]:
                res["ticket"] = sign_ticket(body["mid"], body["run_id"], give)
            self._send(res)
        elif self.path == "/api/trial/refund":
            STATE["refunds"] += 1
            self._send(dict(minutes_state(), refunded=False))
        elif self.path == "/api/redeem":
            if body.get("code") == "TKSL-4EYX" and body.get("mid") == MID:
                self._send({"ok": True, "key": KEY})
            else:
                self._send({"ok": False, "reason": "used" if body.get("code") == "USED-2222" else "not_found"})
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
lic.verify_ticket.__defaults__ = (vec["pem"], None)

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


def clip(name, src=FIXTURE):
    p = os.path.join(WORK, name)
    shutil.copy(src, p)
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
    rc, out = run([clip("a.wav")], answers=[""])     # Enter after the Telegram link
    assert rc == 0, out
    assert "t.me/AmharicCaptionsBot?start=t_abcdefghijklmnop" in out, "shows the free-minutes link"
    assert "Try 20 minutes free" in out, out[-600:]
    assert srts() == ["a.srt"], srts()
    txt = open(os.path.join(WORK, "a.srt"), encoding="utf-8").read()
    assert "-->" in txt and any("ሀ" <= ch <= "፿" for ch in txt), "srt has Amharic cues"
    assert STATE["charges"] == 1 and STATE["grant"]["used"] == 2, STATE   # short1.wav ~1.7 s -> 2 s
    assert not any(f.endswith(".pending") for f in os.listdir(WORK))
    left = sorted(f for f in os.listdir(WORK) if not f.endswith((".srt", ".wav")))
    assert not left, "only the .srt beside the video, found: %s" % left
    assert "[info]" not in out and "CTranslate2" not in out, "engine internals stay in the log"
    assert "CapCut" in out and "DaVinci Resolve" in out and "a.srt" in out, "says where the file is and how to import it"


def t1b():
    # 1.10.6: the free transcription is charged BEFORE it is made, and the
    # server's ticket is what lets the engine run. A server that charges but
    # gives no ticket (or an edited one) gets no caption.
    STATE["tickets"] = False
    try:
        rc, out = run([clip("z.wav")])
    finally:
        STATE["tickets"] = True
    assert rc == 1 and "z.srt" not in srts(), out[-400:]
    assert STATE["charges"] == 2 and STATE["grant"]["used"] == 4, STATE


def t2():
    rc, out = run([clip("b.wav")])
    assert rc == 0 and "b.srt" in srts(), out
    assert "minutes left" in out and STATE["links"] == 1, "no new link once the minutes are there"
    assert not os.path.exists(os.path.join(WORK, "a (2).srt"))


def t2b():
    # 5 free seconds left, a 15-second file: captions for the first 5 s only
    STATE["grant"]["used"] = STATE["grant"]["total"] - 5
    rc, out = run([clip("c5.wav", LONGER)])
    assert rc == 0 and "c5.srt" in srts(), out[-600:]
    assert "cover the first 0:05" in out, out[-600:]
    txt = open(os.path.join(WORK, "c5.srt"), encoding="utf-8").read()
    last_end = max(int(l[17:19]) * 3600 + int(l[20:22]) * 60 + int(l[23:25]) + int(l[26:29]) / 1000 for l in txt.splitlines() if " --> " in l)
    assert last_end <= 5.5, "no caption after the free seconds: %s" % last_end
    assert STATE["grant"]["used"] == STATE["grant"]["total"], STATE


def t3():
    before = srts()
    assert STATE["grant"]["used"] >= STATE["grant"]["total"]
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


def t5b():
    os.remove(os.path.join(HOME, ".amharic_captions_license.json"))
    rc, out = run([clip("e2.wav")], answers=["ABCD-2345"])
    assert rc == 1 and "Activation code not found" in out, out[-300:]
    rc, out = run([clip("e2.wav")], answers=["USED-2222"])
    assert rc == 1 and "already used on another computer" in out, out[-300:]
    rc, out = run([clip("e2.wav")], answers=["tksl 4eyx"])   # typed loosely
    assert rc == 0 and "e2.srt" in srts(), out[-400:]
    stored = json.load(open(os.path.join(HOME, ".amharic_captions_license.json")))
    assert stored["key"] == KEY and stored["token"] == vec["token"], "the code's key is stored like a pasted key"


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
t("1. trial: Telegram link -> 20 free minutes; first file charged in seconds, srt delivered", t1)
t("1b. trial: charged first; no server ticket -> no caption", t1b)
t("2. trial: second file uses the free minutes left (no new link)", t2)
t("2b. trial: 5 free seconds left -> captions for the first 5 s, told the rest needs a license", t2b)
t("3. trial used up: no srt, shows Machine ID + how to pay", t3)
t("4. offline + unlicensed: refuses, says internet is needed", t4)
t("5. activation: bad key rejected; good key stores the panel-format lease", t5)
t("5b. activation code (XXXX-XXXX) from the bot redeems and activates; wrong/used codes explained", t5b)
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
