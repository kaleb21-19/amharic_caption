"""One-tap update (1.80): replace the program's own files with a newer release.

88% of the program opens in Ethiopia (7 days, 2026-10-27) ran a version
older than the last fixes: updating meant the website, a 110 MB zip and the
installer again. The panel now asks this script to fetch the small update
package of the newest release and put its files in place.

  python amh_update.py runtime-id <runtime dir>
      what this install's Python + ffmpeg are (the build stores the same id in
      the update package; a different one needs the full installer).

  python amh_update.py apply --url URL --sha256 HEX --size N --ext DIR --version V
      download (continues after a dropped connection), check the SHA-256 the
      panel already checked against our server's signature, then replace the
      changed files. Every replaced file is kept in <ext>.update-backup until
      everything is in place; any failure puts every file back.

Never touched: runtime/python, runtime/bin, runtime/model (not in the
package), and any file of this install that the package does not have
(licenses, settings). Prints "[up] <bytes> <total>" while downloading and one
JSON line at the end: {"ok": true, "changed": N} or {"ok": false, "error": …}.
"""
import argparse
import hashlib
import json
import os
import shutil
import ssl
import sys
import time
import urllib.request
import zipfile

KEEP_OUT = ("runtime/python/", "runtime/bin/", "runtime/model/")
CHUNK = 1 << 16
READ_TIMEOUT = 60
TRIES = 6


def runtime_id(runtime_dir):
    """Python version + every installed package (name-version) + the ffmpeg
    size: what a package's compiled files and scripts depend on."""
    py = os.path.join(runtime_dir, "python")
    parts = []
    for root, dirs, _files in os.walk(py):
        for d in dirs:
            if d.endswith(".dist-info"):
                parts.append(d.lower())
        # site-packages is never deeper than this; skip the package trees
        if root.count(os.sep) - py.count(os.sep) >= 4:
            dirs[:] = []
    for name in ("python.exe", "python3", "python"):
        for sub in ("", "bin"):
            p = os.path.join(py, sub, name)
            if os.path.isfile(p):
                parts.append("exe:%s:%d" % (name, os.path.getsize(p)))
                break
    for d in (py, os.path.join(py, "lib")):  # python311.dll (Windows), libpython3.11.dylib (Mac)
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for f in names:
            if f.lower().startswith(("python3", "libpython3")) and f.lower().endswith((".dll", ".dylib", ".so")):
                parts.append("lib:" + f.lower())
    for name in ("ffmpeg.exe", "ffmpeg"):
        p = os.path.join(runtime_dir, "bin", name)
        if os.path.isfile(p):
            parts.append("ffmpeg:%d" % os.path.getsize(p))
    parts.sort()
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:16]


def own_target():
    """The package this install needs (a Mac under Rosetta runs the x64 one)."""
    import platform
    if sys.platform == "win32":
        return "win-x64"
    if sys.platform == "darwin":
        return "mac-arm64" if platform.machine().lower() in ("arm64", "aarch64") else "mac-x64"
    return ""


def say(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(CHUNK), b""):
            h.update(b)
    return h.hexdigest()


def fetch(url, dest, size):
    """Download url to dest, continuing a partial file (HTTP Range)."""
    if url.startswith("file://"):            # tests
        shutil.copyfile(urllib.request.url2pathname(url[7:]), dest)
        return
    ctx = None
    try:
        import certifi  # noqa: F401  (bundled with the runtime when present)
        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
    last = None
    for attempt in range(TRIES):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        if size and have >= size:
            return
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "amharic-captions-update",
                                                       "Range": "bytes=%d-" % have})
            with urllib.request.urlopen(req, timeout=READ_TIMEOUT, context=ctx) as res:
                mode = "ab" if res.status == 206 and have else "wb"
                got = have if mode == "ab" else 0
                with open(dest, mode) as f:
                    while True:
                        b = res.read(CHUNK)
                        if not b:
                            break
                        f.write(b)
                        got += len(b)
                        sys.stdout.write("[up] %d %d\n" % (got, size or 0))
                        sys.stdout.flush()
            if not size or os.path.getsize(dest) >= size:
                return
        except Exception as e:  # dropped connection: wait, continue where it stopped
            last = e
        time.sleep(min(30, 3 * (attempt + 1)))
    raise RuntimeError("download failed: %s" % last)


def safe_members(zf):
    """(name, info) of every file to install; refuses anything that could
    write outside the program folder or into the parts we never touch."""
    out = []
    for info in zf.infolist():
        name = info.filename.replace("\\", "/")
        while name.startswith("./"):
            name = name[2:]
        if name.endswith("/") or not name:
            continue
        parts = name.split("/")
        if name.startswith("/") or ":" in parts[0] or ".." in parts or "." in parts or "" in parts:
            raise ValueError("bad path in package: %r" % name)
        if any(name.startswith(k) for k in KEEP_OUT):
            raise ValueError("package touches %r" % name)
        out.append((name, info))
    return out


def apply(args):
    ext = os.path.realpath(args.ext)
    if not os.path.isfile(os.path.join(ext, "CSXS", "manifest.xml")):
        return {"ok": False, "error": "not the program folder"}
    work = ext + ".update"
    os.makedirs(work, exist_ok=True)
    pkg = os.path.join(work, "update-%s.zip" % args.version)
    fetch(args.url, pkg, args.size)
    if sha256_of(pkg) != args.sha256.lower():
        os.remove(pkg)                       # never reuse a wrong file
        return {"ok": False, "error": "checksum"}
    with zipfile.ZipFile(pkg) as zf:
        members = safe_members(zf)
        meta_info = dict(members).get("update.json")
        if meta_info is None:
            return {"ok": False, "error": "no update.json"}
        meta = json.loads(zf.read(meta_info).decode("utf-8"))
        if meta.get("version") != args.version:
            return {"ok": False, "error": "version"}
        if meta.get("target") and meta.get("target") != own_target():
            return {"ok": False, "error": "target"}
        here = runtime_id(os.path.join(ext, "runtime"))
        if meta.get("runtime_id") != here:
            # new Python / packages / ffmpeg: only the full installer has them
            return {"ok": False, "error": "runtime", "need": meta.get("runtime_id"), "have": here}
        stage = os.path.join(work, "stage")
        shutil.rmtree(stage, ignore_errors=True)
        todo = []
        for name, info in members:
            if name == "update.json":
                continue
            dst = os.path.join(ext, *name.split("/"))
            data = zf.read(info)
            if os.path.isfile(dst):
                with open(dst, "rb") as f:
                    if hashlib.sha256(f.read()).digest() == hashlib.sha256(data).digest():
                        continue             # unchanged: leave it (it may be in use)
            tmp = os.path.join(stage, *name.split("/"))
            os.makedirs(os.path.dirname(tmp), exist_ok=True)
            with open(tmp, "wb") as f:
                f.write(data)
            todo.append((name, tmp, dst))
    backup = ext + ".update-backup"
    shutil.rmtree(backup, ignore_errors=True)
    done = []
    try:
        for name, tmp, dst in todo:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.exists(dst):
                bak = os.path.join(backup, *name.split("/"))
                os.makedirs(os.path.dirname(bak), exist_ok=True)
                shutil.copy2(dst, bak)
                done.append((dst, bak))
            else:
                done.append((dst, None))
            os.replace(tmp, dst)
    except Exception as e:
        for dst, bak in reversed(done):      # put every file back
            try:
                if bak:
                    shutil.copy2(bak, dst)
                elif os.path.exists(dst):
                    os.remove(dst)
            except Exception:
                pass
        return {"ok": False, "error": "replace: %s" % e}
    shutil.rmtree(work, ignore_errors=True)
    shutil.rmtree(backup, ignore_errors=True)
    return {"ok": True, "changed": len(todo), "version": args.version}


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("target")
    r = sub.add_parser("runtime-id")
    r.add_argument("runtime")
    a = sub.add_parser("apply")
    a.add_argument("--url", required=True)
    a.add_argument("--sha256", required=True)
    a.add_argument("--size", type=int, default=0)
    a.add_argument("--ext", required=True)
    a.add_argument("--version", required=True)
    args = ap.parse_args(argv)
    if args.cmd == "target":
        print(own_target())
        return 0
    if args.cmd == "runtime-id":
        print(runtime_id(args.runtime))
        return 0
    try:
        out = apply(args)
    except Exception as e:
        out = {"ok": False, "error": str(e)[:300]}
    say(out)
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
