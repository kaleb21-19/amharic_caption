"""
amh_app.py — Amharic Captions Pro as a desktop app, for editors who do not use
Premiere / After Effects (CapCut, DaVinci Resolve, …).

The app IS the Premiere panel: the same index.html / main.js / review screen,
shown in a native window (pywebview — Edge WebView2 on Windows, WebKit on
macOS). Inside Premiere the panel gets Node.js from CEP; here a tiny local
server stands in for the few Node calls the panel makes (files, temp folder,
running ffmpeg / the engine — see node_shim.js), so every improvement to the
panel reaches these users too. Only the Premiere-only parts differ
(app_mode.js): instead of "Place on timeline" the result is saved as an .srt
next to the video, with import steps for CapCut and DaVinci.

  python app/amh_app.py [VIDEO] [--ui DIR] [--ext DIR] [--debug]

VIDEO  a file dropped on the desktop shortcut: opened ready to caption

--ui   folder with index.html + js/ (default: the extension root, ../)
--ext  extension root that holds runtime/ (default: the same)

Security: the server listens on 127.0.0.1 only, on a random port, and every
API call must carry the per-launch token in a custom header — a web page in
the customer's browser cannot call it (the header forces a CORS preflight,
which this server never approves) and DNS-rebinding is refused by the Host
check.
"""

import argparse
import hashlib
import json
import mimetypes
import os
import secrets
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
for d in (os.path.join(HERE, "deps"), os.path.join(HERE, "..", "runtime", "app_deps")):
    if os.path.isdir(d):
        sys.path.insert(0, d)

IS_WIN = sys.platform == "win32"
API_URL = os.environ.get("AMH_API_URL", "https://amharic-captions-bot.amhcaps.workers.dev")
TOKEN = secrets.token_hex(16)
APP_FILES = {"node_shim.js", "app_mode.js", "app.css"}   # + boot.js (generated)
WINDOW = None          # the pywebview window, set once created
PORT = 0


# ── child processes (ffmpeg, the engine) ─────────────────────────────────────
class Child:
    """One spawned process. Its output is turned into an ordered list of events
    the page collects with /__api/poll (long-poll)."""

    def __init__(self, cmd, args, env, cwd, timeout_ms):
        self.events = []          # [{"t": "stdout"|"stderr"|"exit", ...}]
        self.cond = threading.Condition()
        self.done = False
        flags = 0x08000000 if IS_WIN else 0   # CREATE_NO_WINDOW: no console flashes
        self.p = subprocess.Popen(
            [cmd] + list(args), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, cwd=cwd or None, creationflags=flags)
        self._open = 2
        for name, stream in (("stdout", self.p.stdout), ("stderr", self.p.stderr)):
            threading.Thread(target=self._pump, args=(name, stream), daemon=True).start()
        if timeout_ms:
            t = threading.Timer(timeout_ms / 1000.0, self.kill)
            t.daemon = True
            t.start()

    def _push(self, ev):
        with self.cond:
            self.events.append(ev)
            self.cond.notify_all()

    def _pump(self, name, stream):
        # read1 hands over whatever arrived (a progress line, a JSON reply)
        # without waiting for a full buffer.
        while True:
            chunk = stream.read1(65536) if hasattr(stream, "read1") else stream.read(4096)
            if not chunk:
                break
            self._push({"t": name, "d": chunk.decode("utf-8", "replace")})
        with self.cond:
            self._open -= 1
            last = self._open == 0
        if last:
            code = self.p.wait()
            self._push({"t": "exit", "code": code})
            with self.cond:
                self.done = True
                self.cond.notify_all()

    def write(self, data):
        try:
            self.p.stdin.write(data.encode("utf-8"))
            self.p.stdin.flush()
            return True
        except Exception:
            return False

    def kill(self):
        try:
            self.p.kill()
        except Exception:
            pass

    def poll(self, since, wait_s):
        with self.cond:
            if len(self.events) <= since and not self.done:
                self.cond.wait(wait_s)
            return self.events[since:], self.done and len(self.events) >= since


CHILDREN = {}


# ── synchronous operations (fs / os / crypto / dialogs) ──────────────────────
def _stat(p):
    st = os.stat(p)
    return {"size": st.st_size, "mtimeMs": st.st_mtime * 1000.0,
            "isFile": os.path.isfile(p), "isDirectory": os.path.isdir(p)}


def _write(p, data, opts):
    enc = (opts or {}).get("encoding") or "utf-8"
    with open(p, "w", encoding="utf-8" if enc in ("utf8", "utf-8") else enc, newline="") as f:
        f.write(data if isinstance(data, str) else str(data))
    mode = (opts or {}).get("mode")
    if mode is not None and not IS_WIN:
        os.chmod(p, mode)


def _dialog(kind, title, types):
    import webview
    kinds = {"open": webview.FileDialog.OPEN, "folder": webview.FileDialog.FOLDER}
    r = WINDOW.create_file_dialog(kinds[kind], allow_multiple=False,
                                  file_types=tuple(types or ()))
    if not r:
        return None
    return r[0] if isinstance(r, (list, tuple)) else r


def _reveal(p):
    if IS_WIN:
        subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
    elif sys.platform == "darwin":
        subprocess.Popen(["open", "-R", p])
    else:
        subprocess.Popen(["xdg-open", os.path.dirname(p)])


# ── "Open in CapCut / DaVinci Resolve" on the done card ──────────────────────
# Only these two names can be opened (the page never passes a program path).
# Neither editor can be told to import a file from outside, so the app opens
# the editor, copies the .srt location and shows the folder; the import itself
# is one menu click the done card shows step by step.
def _env_path(var, *parts):
    base = os.environ.get(var)
    return os.path.join(base, *parts) if base else None


EDITORS = {
    "capcut": {
        "win": [("LOCALAPPDATA", "CapCut", "Apps", "CapCut.exe"),
                ("PROGRAMFILES", "CapCut", "Apps", "CapCut.exe"),
                ("PROGRAMFILES(X86)", "CapCut", "Apps", "CapCut.exe")],
        "win_lnk": "CapCut",
        "mac": ["CapCut.app"],
        "mac_id": "com.lemon.lvoverseas",
    },
    "davinci": {
        "win": [("PROGRAMFILES", "Blackmagic Design", "DaVinci Resolve", "Resolve.exe"),
                ("PROGRAMW6432", "Blackmagic Design", "DaVinci Resolve", "Resolve.exe")],
        "win_lnk": "DaVinci Resolve",
        "mac": ["DaVinci Resolve/DaVinci Resolve.app", "DaVinci Resolve.app"],
        "mac_id": "com.blackmagic-design.DaVinciResolve",
    },
}


def _start_menu_lnk(name):
    """A Start-menu shortcut — covers installs in unusual folders."""
    for var in ("APPDATA", "PROGRAMDATA"):
        root = _env_path(var, "Microsoft", "Windows", "Start Menu", "Programs")
        if not root or not os.path.isdir(root):
            continue
        for d, _, files in os.walk(root):
            for f in files:
                if f.lower() == name.lower() + ".lnk":
                    return os.path.join(d, f)
    return None


def find_editor(name):
    e = EDITORS[name]
    if IS_WIN:
        for parts in e["win"]:
            p = _env_path(*parts)
            if p and os.path.isfile(p):
                return p
        return _start_menu_lnk(e["win_lnk"])
    if sys.platform == "darwin":
        for root in ("/Applications", os.path.expanduser("~/Applications")):
            for rel in e["mac"]:
                p = os.path.join(root, rel)
                if os.path.isdir(p):
                    return p
        try:   # installed somewhere else: ask Spotlight by bundle id
            r = subprocess.run(["mdfind", "kMDItemCFBundleIdentifier == '%s'" % e["mac_id"]],
                               capture_output=True, text=True, timeout=5)
            for p in r.stdout.splitlines():
                if p.endswith(".app") and os.path.isdir(p):
                    return p
        except Exception:
            pass
    return None


def editors():
    return {n: bool(find_editor(n)) for n in EDITORS}


def open_editor(name):
    if name not in EDITORS:
        raise ValueError("unknown editor")
    p = find_editor(name)
    if not p:
        return False
    if IS_WIN:
        os.startfile(p)          # .exe or .lnk; an open editor just comes to the front
    else:
        subprocess.Popen(["open", p])
    return True


def copy_text(text):
    """Put text on the clipboard (the .srt location, ready to paste in the
    editor's Open dialog). Unicode-safe: Amharic file names survive."""
    if IS_WIN:
        import ctypes
        from ctypes import wintypes
        k32, u32 = ctypes.windll.kernel32, ctypes.windll.user32
        k32.GlobalAlloc.restype = wintypes.HGLOBAL
        k32.GlobalAlloc.argtypes = (wintypes.UINT, ctypes.c_size_t)
        k32.GlobalLock.restype = ctypes.c_void_p
        k32.GlobalLock.argtypes = (wintypes.HGLOBAL,)
        k32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)
        u32.SetClipboardData.argtypes = (wintypes.UINT, wintypes.HANDLE)
        u32.SetClipboardData.restype = wintypes.HANDLE
        data = (text + "\0").encode("utf-16-le")
        for _ in range(10):                  # another program may hold it a moment
            if u32.OpenClipboard(None):
                break
            time.sleep(0.05)
        else:
            return False
        try:
            u32.EmptyClipboard()
            h = k32.GlobalAlloc(0x0002, len(data))          # GMEM_MOVEABLE
            ctypes.memmove(k32.GlobalLock(h), data, len(data))
            k32.GlobalUnlock(h)
            return bool(u32.SetClipboardData(13, h))       # CF_UNICODETEXT
        finally:
            u32.CloseClipboard()
    cmd = ["pbcopy"] if sys.platform == "darwin" else ["xclip", "-selection", "clipboard"]
    env = dict(os.environ, LANG="en_US.UTF-8", LC_ALL="en_US.UTF-8")
    return subprocess.run(cmd, input=text.encode("utf-8"), env=env, timeout=10).returncode == 0


def sync_op(op, a):
    if op == "existsSync":
        return os.path.exists(a[0])
    if op == "readFileSync":
        with open(a[0], "r", encoding="utf-8", errors="replace", newline="") as f:
            return f.read()
    if op == "writeFileSync":
        return _write(a[0], a[1], a[2] if len(a) > 2 else None)
    if op == "unlinkSync":
        return os.remove(a[0])
    if op == "statSync":
        return _stat(a[0])
    if op == "readdirSync":
        return os.listdir(a[0])
    if op == "mkdirSync":
        if (a[1] or {}).get("recursive"):
            return os.makedirs(a[0], exist_ok=True)
        return os.mkdir(a[0])
    if op == "renameSync":
        return os.replace(a[0], a[1])
    if op == "copyFileSync":
        return shutil.copyfile(a[0], a[1])
    if op == "chmodSync":
        return None if IS_WIN else os.chmod(a[0], a[1])
    if op == "hash":
        return hashlib.new(a[0], a[1].encode("utf-8")).hexdigest()
    if op == "dialog":
        return _dialog(a[0], a[1] if len(a) > 1 else "", a[2] if len(a) > 2 else None)
    if op == "reveal":
        return _reveal(a[0])
    if op == "editors":
        return editors()
    if op == "openEditor":
        return open_editor(a[0])
    if op == "copyText":
        return copy_text(str(a[0]))
    if op == "openURL":
        return webbrowser.open(a[0])
    if op == "appReady":
        # The page reached the end of app_mode.js: window, web engine, panel
        # code and app layer all work. Only recorded for automated checks
        # (tools/test/mac_smoke.py sets AMH_APP_READY_FILE); otherwise a no-op.
        ready = os.environ.get("AMH_APP_READY_FILE")
        if ready:
            info = dict(a[0] if a and isinstance(a[0], dict) else {}, port=PORT)
            with open(ready, "w", encoding="utf-8") as f:
                json.dump(info, f, ensure_ascii=False)
        return None
    if op == "spawn":
        c = Child(a[0], a[1], a[2] or None, a[3], a[4])
        cid = secrets.token_hex(6)
        CHILDREN[cid] = c
        return cid
    if op == "media":
        return media_url(a[0])
    raise ValueError("unknown op " + op)


# ── the video for the review preview ─────────────────────────────────────────
# A <video> element cannot send our token header, so each file the page asks
# for gets an unguessable URL (/__media/<id>/<name>); only those files are
# served, only to our own page, with byte ranges (seeking needs them).
MEDIA = {}
MEDIA_TYPES = {".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4",   # mov: H.264 plays as mp4
               ".webm": "video/webm", ".mkv": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
               ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".opus": "audio/ogg",
               ".flac": "audio/flac"}


def media_url(path):
    path = os.path.realpath(path)
    if not os.path.isfile(path):
        raise FileNotFoundError(path)
    for mid, p in MEDIA.items():
        if p == path:
            break
    else:
        mid = secrets.token_hex(12)
        MEDIA[mid] = path
    return "/__media/%s/%s" % (mid, urllib.parse.quote(os.path.basename(path)))


def env_info():
    """What Node's process / os modules would report (node_shim.js)."""
    import getpass
    import platform
    import tempfile
    try:
        user = getpass.getuser()
    except Exception:
        user = ""
    machine = platform.machine().lower()
    return {"platform": sys.platform,                       # win32 / darwin, as Node
            "arch": "arm64" if machine in ("arm64", "aarch64") else "x64",
            "pid": os.getpid(), "env": dict(os.environ),
            "home": os.path.expanduser("~"),
            "tmp": tempfile.gettempdir().rstrip("\\/"),
            "hostname": platform.node(), "username": user, "sep": os.sep}


# ── HTTP ─────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    ui_dir = ""
    ext_dir = ""
    files = []

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _host_ok(self):
        return self.headers.get("Host", "") in ("127.0.0.1:%d" % PORT, "localhost:%d" % PORT)

    def _api_ok(self):
        return self._host_ok() and self.headers.get("X-Amh-Token") == TOKEN

    def do_GET(self):
        if not self._host_ok():
            return self._send(403, "{}")
        url = urllib.parse.urlparse(self.path)
        if url.path == "/__api/poll":
            if not self._api_ok():
                return self._send(403, "{}")
            q = urllib.parse.parse_qs(url.query)
            c = CHILDREN.get((q.get("id") or [""])[0])
            if not c:
                return self._send(404, "{}")
            evs, finished = c.poll(int((q.get("since") or ["0"])[0]), 20.0)
            if finished:
                CHILDREN.pop((q.get("id") or [""])[0], None)
            return self._send(200, json.dumps({"events": evs, "done": finished}))
        if url.path.startswith("/__media/"):
            return self._media(url.path)
        return self._static(url.path)

    def _media(self, path):
        if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            return self._send(403, "")
        parts = path.split("/")
        full = MEDIA.get(parts[2] if len(parts) > 2 else "")
        if not full or not os.path.isfile(full):
            return self._send(404, "")
        size = os.path.getsize(full)
        start, end = 0, size - 1
        rng = self.headers.get("Range", "")
        if rng.startswith("bytes="):
            a, _, b = rng[6:].split(",")[0].strip().partition("-")
            try:
                if a:
                    start = int(a)
                    end = min(int(b), size - 1) if b else size - 1
                else:                                   # bytes=-N: the last N bytes
                    start, end = max(0, size - int(b)), size - 1
            except ValueError:
                start, end = 0, size - 1
            if start >= size or start > end:
                self.send_response(416)
                self.send_header("Content-Range", "bytes */%d" % size)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", MEDIA_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if rng:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            with open(full, "rb") as f:
                f.seek(start)
                left = end - start + 1
                while left > 0:
                    chunk = f.read(min(1 << 20, left))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    left -= len(chunk)
        except (ConnectionError, OSError):
            pass        # the player moved on (a seek) and closed this request

    def do_POST(self):
        if not self._api_ok():
            return self._send(403, "{}")
        n = int(self.headers.get("Content-Length") or 0)
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except ValueError:
            return self._send(400, "{}")
        path = urllib.parse.urlparse(self.path).path
        if path == "/__api/sync":
            try:
                return self._send(200, json.dumps({"result": sync_op(req.get("op"), req.get("args") or [])}))
            except FileNotFoundError as e:
                return self._send(200, json.dumps({"err": {"code": "ENOENT", "message": str(e)}}))
            except Exception as e:
                return self._send(200, json.dumps({"err": {"code": "EIO", "message": str(e)}}))
        if path == "/__api/proxy":
            return self._proxy(req)
        if path == "/__api/stdin":
            c = CHILDREN.get(req.get("id"))
            return self._send(200, json.dumps({"ok": bool(c and c.write(req.get("data") or ""))}))
        if path == "/__api/kill":
            c = CHILDREN.get(req.get("id"))
            if c:
                c.kill()
            return self._send(200, "{}")
        return self._send(404, "{}")

    def _proxy(self, req):
        """The license server accepts the Premiere panel's origin only; the
        app's page is http://127.0.0.1:<port>, so its calls go through here —
        exactly like the SRT maker's (no Origin header). Our API host only."""
        url = str(req.get("url") or "")
        if not url.startswith(API_URL + "/"):
            return self._send(403, "{}")
        body = req.get("body")
        r = urllib.request.Request(
            url, data=body.encode("utf-8") if isinstance(body, str) else None,
            method=str(req.get("method") or "GET").upper(),
            headers={"Content-Type": "application/json", "User-Agent": "AmharicCaptions-App"})
        try:
            with urllib.request.urlopen(r, timeout=20) as res:
                status, data = res.status, res.read()
        except urllib.error.HTTPError as e:
            status, data = e.code, e.read()
        except Exception:
            status, data = 599, b""
        return self._send(200, json.dumps({"status": status, "body": data.decode("utf-8", "replace")}))

    def _static(self, path):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        if rel == "__app/boot.js":
            # The per-launch token, as a script file (the panel's CSP forbids
            # inline scripts). Only for our own page: a cross-site <script>
            # include is refused.
            if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
                return self._send(403, "")
            js = "window.__AMH_APP__=%s;" % json.dumps(
                {"token": TOKEN, "ext": self.ext_dir, "api": API_URL, "info": env_info(),
                 "files": self.files})
            return self._send(200, js, "text/javascript; charset=utf-8")
        if rel.startswith("__app/"):
            name = rel[len("__app/"):]
            if name not in APP_FILES:
                return self._send(404, "")
            full = os.path.join(HERE, name)
        else:
            full = os.path.realpath(os.path.join(self.ui_dir, rel))
            if not full.startswith(os.path.realpath(self.ui_dir) + os.sep):
                return self._send(403, "")
        if not os.path.isfile(full):
            return self._send(404, "")
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if rel == "index.html":
            html = data.decode("utf-8")
            boot = ('<script src="/__app/boot.js"></script>\n'
                    '  <script src="/__app/node_shim.js"></script>\n  ')
            html = html.replace('<script src="./js/CSInterface.js">', boot + '<script src="./js/CSInterface.js">', 1)
            html = html.replace('</head>', '  <link rel="stylesheet" href="/__app/app.css">\n</head>', 1)
            html = html.replace('<script src="./js/main.js"></script>',
                                '<script src="./js/main.js"></script>\n  <script src="/__app/app_mode.js"></script>', 1)
            data = html.encode("utf-8")
            ctype = "text/html; charset=utf-8"
        elif ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        return self._send(200, data, ctype)


# The page's localStorage (first-run guide seen, language, caption style,
# update snooze, …) belongs to its origin, and the origin includes the port:
# a random port made every launch a brand-new site — the guide came back
# each time and settings were lost. So the app prefers fixed ports; a random
# one only if all are taken (then that one launch starts fresh).
APP_PORTS = (47321, 47322, 47323)


def start_server(ui_dir, ext_dir, files=(), ports=APP_PORTS):
    """Serve the panel on 127.0.0.1 (the first free port of `ports`, else a
    random one). Returns the server (also used by tools/test/test_app.py,
    without a window, with ports=())."""
    global PORT
    Handler.ui_dir = os.path.realpath(ui_dir)
    Handler.ext_dir = os.path.realpath(ext_dir or ui_dir)
    Handler.files = [os.path.abspath(f) for f in files if os.path.isfile(f)]
    srv = None
    for port in tuple(ports) + (0,):
        try:
            srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    srv.daemon_threads = True
    PORT = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def console_fallback(ext_dir, files):
    """No window possible (e.g. an old Windows without the Edge WebView2
    runtime): open the classic console SRT maker instead, so the customer
    still gets their captions."""
    if IS_WIN:
        cmd = os.path.join(ext_dir, "Make Amharic Captions.cmd")
        env = dict(os.environ, AMH_CONSOLE="1")
        subprocess.Popen([cmd] + list(files), env=env, creationflags=0x00000010)  # CREATE_NEW_CONSOLE
    else:
        cmd = os.path.join(ext_dir, "Make Amharic Captions.command")
        subprocess.Popen(["open", "-a", "Terminal", cmd])


def main():
    global WINDOW
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="a video to open (dropped on the shortcut)")
    ap.add_argument("--ui", default=os.path.join(HERE, ".."))
    ap.add_argument("--ext", default=None)
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()
    ext_dir = os.path.realpath(a.ext or a.ui)

    try:
        import webview
        from webview.dom import DOMEventHandler
    except Exception:
        return console_fallback(ext_dir, a.files)

    start_server(a.ui, ext_dir, a.files)
    print("Amharic Captions app: http://127.0.0.1:%d/index.html" % PORT, flush=True)

    def on_drop(e):
        files = (e.get("dataTransfer") or {}).get("files") or []
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if paths:
            WINDOW.evaluate_js("window.__amhDropped && window.__amhDropped(%s)" % json.dumps(paths))

    def on_start(w):
        w.dom.document.events.dragover += DOMEventHandler(lambda e: None, True, True)
        w.dom.document.events.drop += DOMEventHandler(on_drop, True, True)

    WINDOW = webview.create_window(
        "Amharic Captions Pro", "http://127.0.0.1:%d/index.html" % PORT,
        width=520, height=860, min_size=(420, 600), background_color="#1e1f22")
    storage = os.path.join(os.path.expanduser("~"), ".amharic_captions_app")
    try:
        webview.start(on_start, WINDOW, private_mode=False, storage_path=storage, debug=a.debug)
    except Exception:
        console_fallback(ext_dir, a.files)
    for c in list(CHILDREN.values()):
        c.kill()


if __name__ == "__main__":
    main()
