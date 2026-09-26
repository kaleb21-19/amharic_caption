#!/usr/bin/env python3
"""
test_model_download.py — amh_model.py (lite packages: resumable, verified
one-time model download) against a local, deliberately unreliable server.

  python tools/test/test_model_download.py
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
import amh_model  # noqa: E402

amh_model.time.sleep = lambda s: None          # no real back-off waits in tests

WORK = tempfile.mkdtemp(prefix="amh_dl_")
SRC = os.path.join(WORK, "src")               # files the "server" hosts
RT = os.path.join(WORK, "runtime")            # a lite runtime (manifest only)
HOME = os.path.join(WORK, "models")           # shared per-user model root
os.makedirs(SRC)
os.makedirs(RT)
os.environ["AMH_MODEL_HOME"] = HOME
os.environ.pop("AMH_MODEL_DIR", None)

FILES = {"model.bin": os.urandom(3 * 1024 * 1024 + 123),
         "model_meta.json": b'{"k": 1}', "vocab.json": b'{"a": 0}'}
for n, b in FILES.items():
    open(os.path.join(SRC, n), "wb").write(b)

# Server behaviour switches
MODE = {"drop_after": None, "ignore_range": False, "down": False, "corrupt": False}
LOG = []


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        name = self.path.rsplit("/", 1)[-1]
        LOG.append((self.path, self.headers.get("Range")))
        if MODE["down"] or name not in FILES:
            self.send_response(503 if MODE["down"] else 404)
            self.end_headers()
            return
        data = FILES[name]
        if MODE["corrupt"] and name == "model.bin":
            data = data[:-1] + bytes([data[-1] ^ 1])
        start = 0
        rng = self.headers.get("Range")
        if rng and not MODE["ignore_range"]:
            start = int(rng.split("=")[1].split("-")[0])
            self.send_response(206)
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, len(data) - 1, len(data)))
        else:
            self.send_response(200)
        body = data[start:]
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if MODE["drop_after"] is not None and name == "model.bin":
            cut = MODE["drop_after"]
            MODE["drop_after"] = None             # only the first request drops
            self.wfile.write(body[:cut])
            self.wfile.flush()
            self.connection.shutdown(2)           # connection lost mid-file
            return
        self.wfile.write(body)


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = "http://127.0.0.1:%d/m" % srv.server_address[1]
DEAD = "http://127.0.0.1:9/m"                 # nothing listens here

subprocess.check_call([sys.executable, os.path.join(REPO, "tools", "make_model_manifest.py"),
                       SRC, "--source", URL, "--out", os.path.join(RT, "model_manifest.json")],
                      stdout=subprocess.DEVNULL)
MAN = amh_model.load_manifest(os.path.join(RT, "model_manifest.json"))
TOTAL = sum(len(b) for b in FILES.values())


def reset():
    shutil.rmtree(HOME, ignore_errors=True)
    shutil.rmtree(os.path.join(RT, "model"), ignore_errors=True)
    LOG.clear()
    MODE.update(drop_after=None, ignore_range=False, down=False, corrupt=False)


passed = failed = 0


def t(name, fn):
    global passed, failed
    reset()
    try:
        fn()
        passed += 1
        print("  [OK] " + name)
    except AssertionError as e:
        failed += 1
        print("  [FAIL] %s\n         %s" % (name, e))


def same_files(d):
    return all(open(os.path.join(d, n), "rb").read() == b for n, b in FILES.items())


def t1():
    assert amh_model.resolve(RT) is None, "nothing yet"
    seen = []
    d = amh_model.download(MAN, lambda done, total: seen.append((done, total)))
    assert same_files(d), "files identical"
    assert amh_model.resolve(RT) == d, "resolves to the shared folder"
    assert d == os.path.join(HOME, MAN["id"])
    assert seen[-1] == (TOTAL, TOTAL), seen[-1]
    assert not os.path.exists(os.path.join(d, ".partial"))


def t2():
    MODE["drop_after"] = 1024 * 1024 + 7
    d = amh_model.download(MAN)
    assert same_files(d)
    ranges = [r for p, r in LOG if p.endswith("model.bin")]
    assert ranges[0] == "bytes=0-" and ranges[1] == "bytes=%d-" % (1024 * 1024 + 7), ranges


def t3():
    # A previous run died with a partial file on disk: resume, don't restart.
    part_dir = os.path.join(HOME, MAN["id"], ".partial")
    os.makedirs(part_dir)
    open(os.path.join(part_dir, "model.bin.part"), "wb").write(FILES["model.bin"][:2000000])
    seen = []
    amh_model.download(MAN, lambda done, total: seen.append(done))
    assert seen[0] >= 2000000, "progress starts from the saved bytes: %r" % seen[:2]
    assert [r for p, r in LOG if p.endswith("model.bin")] == ["bytes=2000000-"]


def t4():
    MODE["drop_after"] = 500000
    MODE["ignore_range"] = True
    d = amh_model.download(MAN)
    assert same_files(d), "server without Range support: restarts cleanly"


def t5():
    MODE["corrupt"] = True
    try:
        amh_model.download(MAN)
        raise AssertionError("corrupt file accepted")
    except IOError as e:
        assert "integrity" in str(e), e
    assert not os.path.exists(os.path.join(HOME, MAN["id"], ".partial", "model.bin.part")), "bad part deleted"
    assert amh_model.resolve(RT) is None
    MODE["corrupt"] = False
    assert same_files(amh_model.download(MAN)), "next attempt succeeds"


def t6():
    d = amh_model.download(MAN, sources=[DEAD, URL])
    assert same_files(d), "falls back to the second source"


def t7():
    MODE["down"] = True
    try:
        amh_model.download(MAN)
        raise AssertionError("should fail")
    except IOError as e:
        assert "could not download" in str(e)
    assert amh_model.resolve(RT) is None, "no complete.json -> not usable"


def t8():
    # Bundled model (full zip / carried forward): used when it matches...
    shutil.copytree(SRC, os.path.join(RT, "model"))
    assert amh_model.resolve(RT) == os.path.join(RT, "model")
    # ...and ignored when it is a different (stale) model.
    open(os.path.join(RT, "model", "model.bin"), "ab").write(b"x")
    assert amh_model.resolve(RT) is None, "stale bundled model rejected"


def t9():
    amh_model.download(MAN)
    os.remove(os.path.join(HOME, MAN["id"], "vocab.json"))
    assert amh_model.resolve(RT) is None, "a deleted file is noticed"
    LOG.clear()
    amh_model.download(MAN)
    assert [p.rsplit("/", 1)[-1] for p, r in LOG] == ["vocab.json"], "only the missing file is fetched: %r" % LOG


def t10():
    env = dict(os.environ)
    shutil.copy(os.path.join(REPO, "amh_model.py"), RT)
    out = subprocess.run([sys.executable, os.path.join(RT, "amh_model.py"), "status"],
                         capture_output=True, text=True, env=env).stdout
    st = json.loads(out)
    assert st["needDownload"] is True and st["total"] == TOTAL, st
    out = subprocess.run([sys.executable, os.path.join(RT, "amh_model.py"), "download"],
                         capture_output=True, text=True, env=env).stdout.strip().splitlines()
    assert out[0].startswith("[dl] ") and json.loads(out[-1])["ok"] is True, out[-3:]
    got = subprocess.run([sys.executable, os.path.join(RT, "amh_model.py"), "path"],
                         capture_output=True, text=True, env=env).stdout.strip()
    assert got == os.path.join(HOME, MAN["id"]), got
    os.remove(os.path.join(RT, "amh_model.py"))


print("model download (local server %s)" % URL)
t("1. fresh download: verified, marked complete, resolves", t1)
t("2. connection drops mid-file: resumes with a Range request", t2)
t("3. leftover partial from an earlier run: continues from it", t3)
t("4. server ignores Range: restarts that file cleanly", t4)
t("5. corrupt file: rejected, deleted, next attempt succeeds", t5)
t("6. first source dead: falls back to the mirror", t6)
t("7. all sources down: clear error, nothing marked usable", t7)
t("8. bundled model used when it matches, ignored when stale", t8)
t("9. a deleted file is detected and only it is fetched again", t9)
t("10. CLI: status / download / path for the panel", t10)
srv.shutdown()
shutil.rmtree(WORK, ignore_errors=True)
print("\n" + ("ALL PASS" if failed == 0 else "FAILURES: %d" % failed) +
      "  (%d passed, %d failed)" % (passed, failed))
sys.exit(0 if failed == 0 else 1)
