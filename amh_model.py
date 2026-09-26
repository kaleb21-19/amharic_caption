"""
amh_model.py — where the Amharic ASR model lives, and a resumable download.

Packages come in two flavours:
  * full: the CTranslate2 model is bundled in runtime/model/ (as before).
  * lite: no model in the zip; it is downloaded ONCE into a per-user folder
          that survives extension updates, so later updates stay small.

runtime/model_manifest.json (written at build time) describes the exact model
this release expects:
  {"id": "<first 12 hex of model.bin sha256>",
   "files": [{"name": "model.bin", "size": 610314640, "sha256": "..."}, ...],
   "sources": ["https://.../", ...]}          # base URLs, tried in order

Resolution order (resolve()):
  1. AMH_MODEL_DIR, if it holds a model            (dev / tests / panel)
  2. runtime/model/ — bundled (full zip) or carried forward by Install.cmd;
     rejected when model.bin's size differs from the manifest (stale model)
  3. <shared root>/<id>/ with a complete.json marker and matching sizes
Shared root: %LOCALAPPDATA%\\AmharicCaptions\\models (Windows),
~/Library/Application Support/AmharicCaptions/models (macOS),
~/.local/share/AmharicCaptions/models otherwise; AMH_MODEL_HOME overrides.
panel/js/main.js mirrors these rules (resolveModelDir) — keep them in sync.

Download: each file is fetched into <dir>/.partial/<name>.part with HTTP
Range resume (a dropped connection continues where it stopped), verified
against the manifest SHA-256, then moved into place; complete.json is written
last. Sources are tried in order with retries.

CLI (used by the panel, which reads stdout):
  python amh_model.py path        -> prints the resolved dir, or nothing
  python amh_model.py status      -> one JSON line
  python amh_model.py download    -> "[dl] <done> <total>" lines, then JSON
"""

import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST_PATH = os.path.join(HERE, "model_manifest.json")
CHUNK = 1 << 20
ATTEMPTS_PER_SOURCE = 4
READ_TIMEOUT = 30


def load_manifest(path=MANIFEST_PATH):
    try:
        with open(path, "r", encoding="utf-8") as f:
            m = json.load(f)
        if m.get("id") and m.get("files"):
            return m
    except Exception:
        pass
    return None


def shared_root():
    env = os.environ.get("AMH_MODEL_HOME")
    if env:
        return env
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return os.path.join(base, "AmharicCaptions", "models")


def shared_dir(manifest):
    return os.path.join(shared_root(), manifest["id"])


def _size_of(manifest, name):
    for f in manifest["files"]:
        if f["name"] == name:
            return f["size"]
    return None


def _looks_like_model(d):
    return os.path.isfile(os.path.join(d, "model_meta.json")) or \
        os.path.isfile(os.path.join(d, "config.json"))


def bundled_ok(d, manifest):
    if not os.path.isfile(os.path.join(d, "model_meta.json")):
        return False
    if manifest:
        want = _size_of(manifest, "model.bin")
        try:
            if want is not None and os.path.getsize(os.path.join(d, "model.bin")) != want:
                return False
        except OSError:
            return False
    return True


def shared_ok(manifest):
    d = shared_dir(manifest)
    try:
        with open(os.path.join(d, "complete.json"), "r", encoding="utf-8") as f:
            if json.load(f).get("id") != manifest["id"]:
                return False
        for fe in manifest["files"]:
            if os.path.getsize(os.path.join(d, fe["name"])) != fe["size"]:
                return False
        return True
    except Exception:
        return False


def resolve(runtime_dir=HERE):
    env = os.environ.get("AMH_MODEL_DIR")
    if env and os.path.isdir(env) and _looks_like_model(env):
        return env
    manifest = load_manifest(os.path.join(runtime_dir, "model_manifest.json"))
    bundled = os.path.join(runtime_dir, "model")
    if bundled_ok(bundled, manifest):
        return bundled
    if manifest and shared_ok(manifest):
        return shared_dir(manifest)
    return None


# ── download ────────────────────────────────────────────────────────────────
def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def _fetch(url, part, expected_size, on_bytes):
    """Append the missing tail of `url` to `part`. Returns when the part is
    expected_size long; raises on network/HTTP errors (caller retries)."""
    have = os.path.getsize(part) if os.path.exists(part) else 0
    if have > expected_size:
        os.remove(part)
        have = 0
    if have == expected_size:
        return
    req = urllib.request.Request(url, headers={"User-Agent": "AmharicCaptions-model",
                                               "Range": "bytes=%d-" % have})
    with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as res:
        status = getattr(res, "status", 200)
        mode = "ab"
        if status == 200 and have:
            # Server ignored the Range header: start the file over.
            on_bytes(-have)
            have = 0
            mode = "wb"
        with open(part, mode) as out:
            while True:
                block = res.read(CHUNK)
                if not block:
                    break
                out.write(block)
                have += len(block)
                on_bytes(len(block))
    if have != expected_size:
        raise IOError("incomplete download (%d of %d bytes)" % (have, expected_size))


def download(manifest=None, progress=None, sources=None):
    """Download + verify every file of the manifest into the shared dir.
    progress(done_bytes, total_bytes) is called as data arrives."""
    manifest = manifest or load_manifest()
    if not manifest:
        raise RuntimeError("no model manifest in this package")
    sources = sources or manifest.get("sources") or []
    if not sources:
        raise RuntimeError("the model manifest lists no download source")
    dest = shared_dir(manifest)
    partial = os.path.join(dest, ".partial")
    os.makedirs(partial, exist_ok=True)
    total = sum(f["size"] for f in manifest["files"])

    state = {"done": 0, "last": 0.0}

    def bump(n):
        state["done"] += n
        now = time.time()
        if progress and (now - state["last"] > 0.25 or state["done"] >= total):
            state["last"] = now
            progress(state["done"], total)

    todo = []
    for fe in manifest["files"]:
        final = os.path.join(dest, fe["name"])
        if os.path.isfile(final) and os.path.getsize(final) == fe["size"]:
            state["done"] += fe["size"]
            continue
        part = os.path.join(partial, fe["name"] + ".part")
        if os.path.exists(part):
            state["done"] += min(os.path.getsize(part), fe["size"])
        todo.append((fe, final, part))
    if progress:
        progress(state["done"], total)

    for fe, final, part in todo:
        last_err = None
        ok = False
        for base in sources:
            url = base.rstrip("/") + "/" + fe["name"]
            for attempt in range(ATTEMPTS_PER_SOURCE):
                try:
                    _fetch(url, part, fe["size"], bump)
                    ok = True
                    break
                except Exception as e:  # network / HTTP / short read: retry
                    last_err = e
                    time.sleep(min(2 ** attempt, 8))
            if ok:
                break
        if not ok:
            raise IOError("could not download %s: %s" % (fe["name"], last_err))
        if _sha256(part) != fe["sha256"]:
            # Corrupt: discard so the next attempt starts clean.
            before = os.path.getsize(part)
            os.remove(part)
            bump(-before)
            raise IOError("%s failed its integrity check; it will be downloaded again" % fe["name"])
        os.replace(part, final)

    with open(os.path.join(dest, "complete.json"), "w", encoding="utf-8") as f:
        json.dump({"id": manifest["id"], "at": int(time.time())}, f)
    shutil.rmtree(partial, ignore_errors=True)
    return dest


def main(argv):
    cmd = argv[0] if argv else "status"
    manifest = load_manifest()
    if cmd == "path":
        d = resolve()
        if d:
            print(d)
        return 0
    if cmd == "status":
        d = resolve()
        total = sum(f["size"] for f in manifest["files"]) if manifest else 0
        print(json.dumps({"ok": True, "dir": d, "needDownload": d is None and bool(manifest),
                          "total": total, "target": shared_dir(manifest) if manifest else None}))
        return 0
    if cmd == "download":
        def prog(done, total):
            print("[dl] %d %d" % (done, total), flush=True)
        try:
            d = download(manifest, prog)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)
            return 1
        print(json.dumps({"ok": True, "dir": d}), flush=True)
        return 0
    print("usage: amh_model.py path|status|download", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
