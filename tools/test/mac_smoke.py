#!/usr/bin/env python3
"""
mac_smoke.py — does the INSTALLED product work on this computer, the way a
customer uses it? Made for GitHub's macOS machines (we have no Mac tester),
also runs on Windows.

Run it after the real installer (Install.command silent / Install.cmd):

  1. the bundled Python can load the window library (pywebview + pyobjc)
  2. "Make Amharic Captions" — the real launcher, with a video dropped on it —
     opens the app window, the page loads, main.js and the app layer run and
     the dropped video is selected (the app reports "ready")
  3. the engine makes real Amharic captions through the app's own bridge
  4. (optional) the SRT maker end-to-end tests with the installed Python

  python3 tools/test/mac_smoke.py [--ext DIR] [--app-from DIR] [--standalone]

--app-from DIR  copy app/*.py|js|css from DIR over the installed app first
                (test this branch's app code with a published runtime)
--standalone    also run tools/test/test_standalone.py with the installed Python

Uses only the standard library. Failures print GitHub "::error::" lines, so
they show up as annotations on the run.
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
IS_WIN = sys.platform == "win32"
WAV = os.path.join(REPO, "tools", "test", "fixtures_real", "abu.mp4.wav")
FAILED = []


def note(kind, title, msg):
    msg = str(msg).strip()
    print("::%s title=%s::%s" % (kind, title, msg.replace("%", "%25").replace("\r", "").replace("\n", "%0A")), flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("- %s **%s** — %s\n" % ("✅" if kind == "notice" else "❌", title, msg.splitlines()[0][:300] if msg else ""))


def ok(title, msg=""):
    print("[OK] %s %s" % (title, msg), flush=True)
    note("notice", title, msg or "ok")


def fail(title, msg):
    print("[FAIL] %s\n%s" % (title, msg), flush=True)
    FAILED.append(title)
    note("error", title, msg)


def default_ext():
    if IS_WIN:
        return os.path.join(os.environ["APPDATA"], "Adobe", "CEP", "extensions", "com.amharic.captions")
    return os.path.expanduser("~/Library/Application Support/Adobe/CEP/extensions/com.amharic.captions")


def http(port, method, path, body=None, token=None):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path), method=method,
                                 data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Host", "127.0.0.1:%d" % port)
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("X-Amh-Token", token)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8")


def stop_app(port):
    """Stop only the app instance on this port (a customer's own app may run)."""
    try:
        if IS_WIN:
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            "Get-NetTCPConnection -LocalPort %d -State Listen -ErrorAction SilentlyContinue | "
                            "ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }" % port], timeout=30)
        else:
            pids = subprocess.run(["lsof", "-ti", "tcp:%d" % port, "-sTCP:LISTEN"], capture_output=True, text=True).stdout.split()
            for p in pids:
                subprocess.run(["kill", p])
    except Exception as e:
        print("could not stop the app on port %d: %s" % (port, e))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ext", default=default_ext())
    ap.add_argument("--app-from", default=None)
    ap.add_argument("--standalone", action="store_true")
    a = ap.parse_args()
    ext = a.ext
    py = os.path.join(ext, "runtime", "python", "python.exe" if IS_WIN else os.path.join("bin", "python3"))
    if not os.path.isfile(py):
        fail("installed", "no bundled Python at " + py)
        return 1
    try:
        with open(os.path.join(ext, "CSXS", "manifest.xml"), encoding="utf-8") as f:
            import re
            ver = re.search(r'ExtensionBundleVersion="([^"]+)"', f.read()).group(1)
        ok("installed", "v%s at %s" % (ver, ext))
    except Exception as e:
        fail("installed", "manifest unreadable: %s" % e)

    if a.app_from:
        for f in glob.glob(os.path.join(a.app_from, "*")):
            if f.endswith((".py", ".js", ".css")):
                shutil.copy(f, os.path.join(ext, "app", os.path.basename(f)))
        print("app files copied from", a.app_from)

    # 1. window library
    r = subprocess.run([py, "-E", "-s", "-c",
                        "import webview, sys; print(webview.__version__ if hasattr(webview,'__version__') else 'ok');"
                        + ("" if IS_WIN else "import objc, AppKit, WebKit; print('pyobjc', objc.__version__)")],
                       capture_output=True, text=True, timeout=120)
    if r.returncode == 0:
        ok("window library loads", " ".join(r.stdout.split()))
        if r.stderr.strip():
            # Harmless warnings are fine, but the launcher must not mistake
            # them for a failure (it judges by exit code since 1.9.5).
            note("notice", "window library printed warnings (harmless)", r.stderr.strip()[-1500:])
    else:
        fail("window library loads", (r.stderr or r.stdout)[-2000:])

    # 2. the real launcher with a dropped video
    work = tempfile.mkdtemp(prefix="amh_smoke_")
    video = os.path.join(work, "smoke clip(2).wav")
    shutil.copy(WAV, video)
    ready = os.path.join(work, "ready.json")
    env = dict(os.environ, AMH_APP_READY_FILE=ready)
    launcher = os.path.join(ext, "Make Amharic Captions.cmd" if IS_WIN else "Make Amharic Captions.command")
    t0 = time.time()
    # The launcher's output goes to a FILE: the app it starts can inherit a
    # pipe and keep it open, and reading a pipe would then wait for the app.
    lfile = os.path.join(work, "launcher.txt")
    with open(lfile, "w") as lf:
        cmd = [launcher, video] if IS_WIN else ["bash", launcher, video]
        lp = subprocess.Popen(cmd, env=env, stdin=subprocess.DEVNULL, stdout=lf, stderr=subprocess.STDOUT)
        try:
            lp.wait(timeout=60)
            stuck = ""
        except subprocess.TimeoutExpired:
            lp.kill()
            stuck = "\n(launcher still running after 60 s — it fell back to the console SRT maker?)"
    lout = open(lfile, encoding="utf-8", errors="replace").read() + stuck
    print("---- launcher output ----\n" + (lout or "(nothing)") + "\n-------------------------")
    info = None
    while time.time() - t0 < 120:
        if os.path.isfile(ready):
            try:
                with open(ready, encoding="utf-8") as f:
                    info = json.load(f)
                break
            except ValueError:
                pass
        time.sleep(1)
    applog = os.path.join(os.environ.get("TMPDIR", "/tmp"), "amharic-captions-app.log")
    if info:
        ok("app window opens and the page is ready",
           "%.0f s · v%s · selected: %s · %s" % (time.time() - t0, info.get("version"), info.get("chosen"), info.get("userAgent", "")[:90]))
        if info.get("chosen") != os.path.basename(video):
            fail("dropped video is selected", "expected %r, got %r" % (os.path.basename(video), info.get("chosen")))
        else:
            ok("dropped video is selected", info.get("chosen"))
        if not info.get("runtime"):
            fail("panel finds the runtime", "RUNTIME is empty in the app")
        if info.get("previewUi") and info.get("h264") in ("probably", "maybe"):
            ok("review video preview can play H.264", "canPlayType = %s" % info.get("h264"))
        else:
            fail("review video preview can play H.264", "previewUi=%r canPlayType=%r" % (info.get("previewUi"), info.get("h264")))
    else:
        extra = ""
        if not IS_WIN and os.path.isfile(applog):
            extra = "\napp log:\n" + open(applog, encoding="utf-8", errors="replace").read()[-3000:]
        fail("app window opens and the page is ready", "no ready signal within 120 s.\nlauncher said:\n" + (lout or "")[-1500:] + extra)
        return finish()

    # 3. real captions through the app's own bridge (what Make captions runs)
    port = info["port"]
    try:
        boot = http(port, "GET", "/__app/boot.js")
        token = json.loads(boot[boot.index("=") + 1:].rstrip(";"))["token"]
        out_srt = os.path.join(work, "smoke.srt")
        engine = os.path.join(ext, "runtime", "ethio_srt.py")
        res = json.loads(http(port, "POST", "/__api/sync", {"op": "spawn", "args": [
            py, ["-E", "-s", "-X", "utf8", engine, video, out_srt, "--group", "3"], None, None, 600000]}, token))
        cid = res["result"]
        since, code, t1, err = 0, None, time.time(), []
        while time.time() - t1 < 600 and code is None:
            r = json.loads(http(port, "GET", "/__api/poll?id=%s&since=%d" % (cid, since), token=token))
            for ev in r["events"]:
                since += 1
                if ev["t"] == "stderr":
                    err.append(ev["d"])
                if ev["t"] == "exit":
                    code = ev["code"]
            if r["done"] and code is None:
                code = -1
        text = open(out_srt, encoding="utf-8").read() if os.path.isfile(out_srt) else ""
        ethiopic = sum(1 for ch in text if "ሀ" <= ch <= "፿")
        if code == 0 and ethiopic > 20:
            first = [l for l in text.splitlines() if any("ሀ" <= c <= "፿" for c in l)][:2]
            ok("engine makes Amharic captions via the app", "%.0f s · %d Ethiopic letters · %s" % (time.time() - t1, ethiopic, " / ".join(first)))
        else:
            fail("engine makes Amharic captions via the app", "exit %s, %d Ethiopic letters\n%s" % (code, ethiopic, "".join(err)[-2500:]))
    except Exception as e:
        fail("engine makes Amharic captions via the app", repr(e))
    finally:
        stop_app(port)

    # 4. SRT maker (CapCut / DaVinci console fallback) with the installed Python
    if a.standalone:
        env2 = dict(os.environ, AMH_MODEL_DIR=os.path.join(ext, "runtime", "model"),
                    PATH=os.path.join(ext, "runtime", "bin") + os.pathsep + os.environ.get("PATH", ""),
                    PYTHONIOENCODING="utf-8")
        r = subprocess.run([py, os.path.join(REPO, "tools", "test", "test_standalone.py")], env=env2,
                           capture_output=True, text=True, timeout=1800)
        tail = (r.stdout + r.stderr)[-2500:]
        print(tail)
        (ok if r.returncode == 0 else fail)("SRT maker end-to-end (installed Python)", tail.strip().splitlines()[-1] if r.returncode == 0 else tail)
    return finish()


def finish():
    print("\n" + ("ALL PASS" if not FAILED else "FAILURES: " + ", ".join(FAILED)))
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
