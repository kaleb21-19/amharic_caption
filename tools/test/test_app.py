#!/usr/bin/env python3
"""
test_app.py — the desktop app's local server (app/amh_app.py), without a window.

The app shows the Premiere panel in a web view and stands in for the Node
calls CEP normally provides. This checks that stand-in over real HTTP:

  * security: wrong Host, missing token, cross-site boot.js, CORS preflight
    and path traversal are all refused
  * index.html is served with the app scripts injected around the panel's
    own (and the panel's CSP still forbids inline scripts)
  * fs / hash operations behave like Node's *Sync functions (Amharic text
    round-trips, ENOENT on a missing file)
  * spawn: stdout / stderr / exit code arrive in order, stdin reaches the
    child, kill stops it
  * license-server calls are proxied to the API host only

No model, no network, no pywebview needed.

  python tools/test/test_app.py
"""
import hashlib
import http.client
import json
import os
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


# ── a stand-in license server for the proxy test ─────────────────────────────
class Api(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"path": self.path, "origin": self.headers.get("Origin")}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        got = self.rfile.read(n).decode()
        body = json.dumps({"echo": json.loads(got)}).encode()
        self.send_response(429)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


api = ThreadingHTTPServer(("127.0.0.1", 0), Api)
threading.Thread(target=api.serve_forever, daemon=True).start()
API = "http://127.0.0.1:%d" % api.server_address[1]
os.environ["AMH_API_URL"] = API          # read by amh_app at import

sys.path.insert(0, os.path.join(REPO, "app"))
import amh_app  # noqa: E402

EXT = tempfile.mkdtemp(prefix="amh_app_ext_")
WORK = tempfile.mkdtemp(prefix="amh_app_work_")
srv = amh_app.start_server(os.path.join(REPO, "panel"), EXT, files=[os.path.join(REPO, "README.md")], ports=())
PORT = amh_app.PORT
HOST = "127.0.0.1:%d" % PORT
TOKEN = amh_app.TOKEN

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


def req(method, path, body=None, headers=None, host=HOST, token=True):
    c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=30)
    h = {"Host": host}
    if token:
        h["X-Amh-Token"] = TOKEN
    if body is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    c.request(method, path, body=json.dumps(body) if body is not None else None, headers=h)
    r = c.getresponse()
    data = r.read().decode("utf-8", "replace")
    c.close()
    return r.status, data


def sync(op, *args):
    st, data = req("POST", "/__api/sync", {"op": op, "args": list(args)})
    assert st == 200, (op, st, data)
    return json.loads(data)


def t_security():
    assert req("GET", "/index.html", host="evil.example:%d" % PORT, token=False)[0] == 403, "foreign Host (DNS rebinding)"
    assert req("POST", "/__api/sync", {"op": "existsSync", "args": [EXT]}, token=False)[0] == 403, "no token"
    assert req("POST", "/__api/sync", {"op": "existsSync", "args": [EXT]}, headers={"X-Amh-Token": "x" * 32})[0] == 403, "wrong token"
    assert req("POST", "/__api/sync", {"op": "existsSync", "args": [EXT]}, host="evil.example:%d" % PORT)[0] == 403, "token but foreign Host"
    assert req("GET", "/__api/poll?id=x&since=0", token=False)[0] == 403, "poll needs the token"
    assert req("GET", "/__app/boot.js", headers={"Sec-Fetch-Site": "cross-site"}, token=False)[0] == 403, "cross-site boot.js"
    st, _ = req("OPTIONS", "/__api/sync", headers={"Origin": "https://evil.example",
                                                    "Access-Control-Request-Method": "POST",
                                                    "Access-Control-Request-Headers": "x-amh-token"}, token=False)
    assert st >= 400, "CORS preflight must never be approved (got %d)" % st
    assert req("GET", "/..%2F..%2FREADME.md", token=False)[0] in (403, 404), "path traversal"
    assert req("GET", "/__app/amh_app.py", token=False)[0] == 404, "only the app's web files are served"


def t_index():
    st, html = req("GET", "/index.html", token=False)
    assert st == 200
    i_boot, i_shim = html.find("/__app/boot.js"), html.find("/__app/node_shim.js")
    i_csi, i_main, i_mode = html.find("./js/CSInterface.js"), html.find("./js/main.js"), html.find("/__app/app_mode.js")
    assert 0 < i_boot < i_shim < i_csi < i_main < i_mode, "boot, shim before CSInterface; app_mode after main.js"
    assert "/__app/app.css" in html
    assert "script-src 'self'" in html, "the panel's CSP stays strict (no inline script needed)"
    st, js = req("GET", "/__app/boot.js", token=False)
    boot = json.loads(js[js.index("=") + 1:].rstrip(";"))
    assert st == 200 and boot["token"] == TOKEN and boot["ext"] == os.path.realpath(EXT)
    assert boot["api"] == API and boot["files"] == [os.path.join(REPO, "README.md")]
    assert boot["info"]["platform"] == sys.platform and boot["info"]["tmp"]
    for f in ("node_shim.js", "app_mode.js", "app.css"):
        assert req("GET", "/__app/" + f, token=False)[0] == 200, f


def t_fs():
    p = os.path.join(WORK, "ሙከራ", "a.srt")
    assert sync("mkdirSync", os.path.dirname(p), {"recursive": True}) == {"result": None}
    text = "1\r\n00:00:00,000 --> 00:00:01,000\r\nሰላም ለዓለም\r\n"
    sync("writeFileSync", p, text, {"encoding": "utf8", "mode": 0o600})
    assert sync("readFileSync", p)["result"] == text, "Amharic + CRLF round-trip unchanged"
    assert sync("existsSync", p)["result"] is True
    st = sync("statSync", p)["result"]
    assert st["size"] == len(text.encode("utf-8")) and st["isFile"] and not st["isDirectory"] and st["mtimeMs"] > 0
    q = p + ".bak"
    sync("copyFileSync", p, q)
    sync("renameSync", q, q + "2")
    assert sorted(sync("readdirSync", os.path.dirname(p))["result"]) == ["a.srt", "a.srt.bak2"]
    sync("unlinkSync", q + "2")
    r = sync("readFileSync", q + "2")
    assert r.get("err", {}).get("code") == "ENOENT", r
    assert sync("existsSync", q + "2")["result"] is False
    assert sync("hash", "sha1", "ab:ሀ")["result"] == hashlib.sha1("ab:ሀ".encode()).hexdigest()
    assert sync("hash", "sha256", "x")["result"] == hashlib.sha256(b"x").hexdigest()
    assert "err" in sync("noSuchOp"), "unknown operations are refused"


def poll_all(cid, timeout=20):
    events, since, t0 = [], 0, time.time()
    while time.time() - t0 < timeout:
        st, data = req("GET", "/__api/poll?id=%s&since=%d" % (cid, since))
        if st == 404:
            break
        r = json.loads(data)
        events += r["events"]
        since += len(r["events"])
        if r["done"]:
            break
    return events


def t_spawn():
    code = ("import sys; print('out1', flush=True); sys.stderr.write('err1\\n'); sys.stderr.flush();"
            "line = sys.stdin.readline(); print('got:' + line.strip(), flush=True); sys.exit(3)")
    cid = sync("spawn", sys.executable, ["-c", code], None, None, 0)["result"]
    st, data = req("POST", "/__api/stdin", {"id": cid, "data": "ሰላም\n"})
    assert st == 200 and json.loads(data)["ok"]
    ev = poll_all(cid)
    out = "".join(e["d"] for e in ev if e["t"] == "stdout")
    err = "".join(e["d"] for e in ev if e["t"] == "stderr")
    assert "out1" in out and "got:ሰላም" in out, out
    assert "err1" in err, err
    assert ev[-1] == {"t": "exit", "code": 3}, ev[-1]
    assert req("GET", "/__api/poll?id=%s&since=0" % cid)[0] == 404, "a finished child is forgotten"


def t_kill():
    cid = sync("spawn", sys.executable, ["-c", "import time; time.sleep(60)"], None, None, 0)["result"]
    time.sleep(0.5)
    req("POST", "/__api/kill", {"id": cid})
    t0 = time.time()
    ev = poll_all(cid, timeout=15)
    assert ev and ev[-1]["t"] == "exit" and time.time() - t0 < 10, ev


def t_timeout():
    cid = sync("spawn", sys.executable, ["-c", "import time; time.sleep(60)"], None, None, 800)["result"]
    t0 = time.time()
    ev = poll_all(cid, timeout=15)
    assert ev and ev[-1]["t"] == "exit" and time.time() - t0 < 10, "timeout_ms kills the child"


def t_env():
    cid = sync("spawn", sys.executable, ["-c", "import os; print(os.environ.get('AMH_X'))"],
               dict(os.environ, AMH_X="ok42"), WORK, 0)["result"]
    out = "".join(e["d"] for e in poll_all(cid) if e["t"] == "stdout")
    assert "ok42" in out, out


def t_proxy():
    st, data = req("POST", "/__api/proxy", {"url": "https://evil.example/api/x", "method": "GET"})
    assert st == 403, "only the license server is reachable"
    st, data = req("POST", "/__api/proxy", {"url": API + "/api/trial?mid=abc", "method": "GET"})
    r = json.loads(data)
    assert st == 200 and r["status"] == 200, r
    assert json.loads(r["body"]) == {"path": "/api/trial?mid=abc", "origin": None}, "no Origin header, like the SRT maker"
    st, data = req("POST", "/__api/proxy", {"url": API + "/api/validate", "method": "POST", "body": json.dumps({"mid": "m"})})
    r = json.loads(data)
    assert r["status"] == 429 and json.loads(r["body"]) == {"echo": {"mid": "m"}}, "status and body passed through"
    assert req("POST", "/__api/proxy", {"url": API + "/x"}, token=False)[0] == 403


def t_fixed_port():
    # Settings live in localStorage, which belongs to the page's origin
    # (host + PORT): the app must come back on the same port every launch.
    import socket
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", 0))
    taken = blocker.getsockname()[1]
    free = socket.socket(); free.bind(("127.0.0.1", 0)); want = free.getsockname()[1]; free.close()
    s1 = amh_app.start_server(os.path.join(REPO, "panel"), EXT, ports=(taken, want))
    got = amh_app.PORT
    s1.shutdown(); s1.server_close(); blocker.close()
    amh_app.PORT = PORT
    assert got == want, "first FREE preferred port is used (%d busy, wanted %d, got %d)" % (taken, want, got)
    assert amh_app.APP_PORTS and all(1024 < p < 65536 for p in amh_app.APP_PORTS)


def t_media():
    # The review preview: a <video> cannot send our token, so a file the page
    # asked for gets an unguessable URL; byte ranges make seeking work.
    vid = os.path.join(WORK, "ቪዲዮ clip(2).mp4")
    data = bytes(range(256)) * 40                      # 10240 bytes
    with open(vid, "wb") as f:
        f.write(data)
    url = sync("media", vid)["result"]
    assert url.startswith("/__media/") and len(url.split("/")[2]) == 24, url
    assert sync("media", vid)["result"] == url, "same file, same URL"

    def get(path, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", PORT, timeout=30)
        h = {"Host": HOST}
        h.update(headers or {})
        c.request("GET", path, headers=h)
        r = c.getresponse()
        body = r.read()
        c.close()
        return r.status, dict(r.getheaders()), body

    st, h, body = get(url)                              # no token needed: the URL is the secret
    assert st == 200 and body == data and h["Content-Type"] == "video/mp4" and h["Accept-Ranges"] == "bytes", (st, h)
    st, h, body = get(url, {"Range": "bytes=100-199"})
    assert st == 206 and body == data[100:200] and h["Content-Range"] == "bytes 100-199/10240", (st, h)
    st, h, body = get(url, {"Range": "bytes=10000-"})
    assert st == 206 and body == data[10000:] and h["Content-Range"] == "bytes 10000-10239/10240"
    st, h, body = get(url, {"Range": "bytes=-40"})
    assert st == 206 and body == data[-40:]
    st, h, _ = get(url, {"Range": "bytes=99999-"})
    assert st == 416 and h["Content-Range"] == "bytes */10240"
    assert get(url, {"Sec-Fetch-Site": "cross-site"})[0] == 403, "other websites cannot read it"
    assert get("/__media/" + "0" * 24 + "/x.mp4")[0] == 404, "only files the page asked for"
    assert get(url, {"Host": "evil.example:%d" % PORT})[0] == 403
    assert sync("media", os.path.join(WORK, "missing.mp4")).get("err", {}).get("code") == "ENOENT"
    wav = os.path.join(WORK, "a.wav")
    open(wav, "wb").write(b"RIFF")
    assert get(sync("media", wav)["result"])[1]["Content-Type"] == "audio/wav"


def read_clipboard():
    if sys.platform == "win32":
        import ctypes
        u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
        u32.GetClipboardData.restype = ctypes.c_void_p
        k32.GlobalLock.restype = ctypes.c_wchar_p
        k32.GlobalLock.argtypes = (ctypes.c_void_p,)
        k32.GlobalUnlock.argtypes = (ctypes.c_void_p,)
        for _ in range(20):
            if u32.OpenClipboard(None):
                break
            time.sleep(0.05)
        try:
            h = u32.GetClipboardData(13)
            text = k32.GlobalLock(h) if h else None
            if h:
                k32.GlobalUnlock(h)
            return text
        finally:
            u32.CloseClipboard()
    import subprocess
    if sys.platform == "darwin":
        return subprocess.run(["pbpaste"], capture_output=True,
                              env=dict(os.environ, LANG="en_US.UTF-8")).stdout.decode("utf-8")
    return None


def t_editors():
    # "Open in CapCut / DaVinci Resolve": found where each installer puts it,
    # only those two names can be opened, and the .srt location is copied.
    found = sync("editors")["result"]
    assert set(found) == {"capcut", "davinci"} and all(isinstance(v, bool) for v in found.values()), found
    assert "err" in sync("openEditor", "C:/Windows/System32/calc.exe"), "only known editors, never a path"
    fake = os.path.join(WORK, "fake home ቤት")
    keep = {k: os.environ.get(k) for k in ("LOCALAPPDATA", "PROGRAMFILES", "PROGRAMW6432", "PROGRAMFILES(X86)",
                                           "APPDATA", "PROGRAMDATA", "HOME")}
    try:
        for k in keep:
            os.environ[k] = fake
        if sys.platform == "win32":
            exe = os.path.join(fake, "CapCut", "Apps", "CapCut.exe")
            os.makedirs(os.path.dirname(exe))
            open(exe, "wb").close()
            assert amh_app.find_editor("capcut") == exe
            assert amh_app.find_editor("davinci") is None
            lnk = os.path.join(fake, "Microsoft", "Windows", "Start Menu", "Programs", "Blackmagic Design", "DaVinci Resolve.lnk")
            os.makedirs(os.path.dirname(lnk))
            open(lnk, "wb").close()
            assert amh_app.find_editor("davinci") == lnk, "a Start-menu shortcut counts"
        elif sys.platform == "darwin":
            app = os.path.join(fake, "Applications", "DaVinci Resolve", "DaVinci Resolve.app")
            os.makedirs(app)
            found = amh_app.find_editor("davinci")
            assert found == app or (found or "").startswith("/Applications/"), found
            if not os.path.isdir("/Applications/CapCut.app"):
                cc = os.path.join(fake, "Applications", "CapCut.app")
                os.makedirs(cc)
                assert amh_app.find_editor("capcut") == cc, amh_app.find_editor("capcut")
    finally:
        for k, v in keep.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
    if sys.platform in ("win32", "darwin"):
        before = read_clipboard()
        path = os.path.join(WORK, "ቪዲዮ clip (2).srt")
        try:
            assert sync("copyText", path)["result"] is True
            assert read_clipboard() == path, (read_clipboard(), path)
        finally:
            if before is not None:
                amh_app.copy_text(before)


print("desktop app server (app/amh_app.py) on %s" % HOST)
t("security: foreign Host, no/wrong token, cross-site boot.js, CORS preflight, traversal refused", t_security)
t("index.html: app scripts injected around the panel's own; CSP unchanged; boot.js carries token + dropped file", t_index)
t("fs: Amharic round-trip, stat, copy/rename/readdir/unlink, ENOENT, hashes like Node", t_fs)
t("spawn: stdout, stderr, stdin (Amharic) and exit code arrive in order", t_spawn)
t("spawn: kill stops a running child", t_kill)
t("spawn: timeout kills a hung child", t_timeout)
t("spawn: env and cwd are passed to the child", t_env)
t("proxy: license-server calls only, status + body passed through, token required", t_proxy)
t("fixed port: the first free preferred port, so saved settings survive a restart", t_fixed_port)
t("media: review video served by unguessable URL with byte ranges (seek); cross-site, foreign Host, unknown refused", t_media)
t("editors: CapCut / DaVinci found where installed (or by Start-menu shortcut), no other program can be opened, Amharic .srt path copied", t_editors)
srv.shutdown()
api.shutdown()
shutil.rmtree(EXT, ignore_errors=True)
shutil.rmtree(WORK, ignore_errors=True)
print("\n" + ("ALL PASS" if failed == 0 else "FAILURES: %d" % failed) + "  (%d passed, %d failed)" % (passed, failed))
sys.exit(0 if failed == 0 else 1)
