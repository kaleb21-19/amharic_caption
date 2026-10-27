"""1.80 one-tap update: amh_update.py replaces exactly the changed files,
refuses anything unsafe, and puts every file back when something fails.
Everything happens in a temporary folder; the real install is never touched."""
import hashlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
import amh_update  # noqa: E402

PASS = []


def ok(name):
    PASS.append(name)
    print("  PASS  " + name)


def make_install(base):
    ext = os.path.join(base, "com.amharic.captions")
    for rel, text in {
        "CSXS/manifest.xml": '<ExtensionManifest ExtensionBundleVersion="1.79.0"/>',
        "js/main.js": "old main",
        "js/core.js": "same core",
        "app/studio.js": "old studio",
        "runtime/ethio_srt.pyc": "old engine",
        "runtime/python/Lib/site-packages/numpy-2.1.0.dist-info/METADATA": "x",
        "runtime/python/python.exe": "py" * 50,
        "runtime/python/python311.dll": "dll",
        "runtime/bin/ffmpeg.exe": "ff" * 100,
        "runtime/model/model.bin": "the model",
        "license.json": "the customer's license",
    }.items():
        p = os.path.join(ext, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(text)
    return ext


def make_package(path, files, version="1.80.0", rid=None):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("update.json", json.dumps({"version": version, "runtime_id": rid}))
        for name, text in files.items():
            zf.writestr(name, text)
    h = hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()
    return pathlib.Path(path).as_uri(), h, os.path.getsize(path)


def run(url, sha, size, ext, version="1.80.0"):
    p = subprocess.run([sys.executable, os.path.join(ROOT, "amh_update.py"), "apply", "--url", url, "--sha256", sha,
                        "--size", str(size), "--ext", ext, "--version", version], capture_output=True, text=True)
    last = [l for l in p.stdout.splitlines() if l.startswith("{")][-1]
    return json.loads(last)


def read(ext, rel):
    with open(os.path.join(ext, *rel.split("/")), encoding="utf-8") as f:
        return f.read()


base = tempfile.mkdtemp(prefix="amh_upd_")
try:
    ext = make_install(base)
    rid = amh_update.runtime_id(os.path.join(ext, "runtime"))
    assert len(rid) == 16
    # the same install twice: the same id; another package version: another id
    assert amh_update.runtime_id(os.path.join(ext, "runtime")) == rid
    other = make_install(os.path.join(base, "other"))
    os.rename(os.path.join(other, "runtime/python/Lib/site-packages/numpy-2.1.0.dist-info"),
              os.path.join(other, "runtime/python/Lib/site-packages/numpy-2.2.0.dist-info"))
    assert amh_update.runtime_id(os.path.join(other, "runtime")) != rid, "a new numpy changes the id"
    ok("runtime id: the same for the same Python/packages/ffmpeg, different when a package changes")

    # a normal update: changed files replaced, unchanged kept, new files added,
    # the license, Python, ffmpeg and the model never touched
    pkg = os.path.join(base, "u1.zip")
    url, sha, size = make_package(pkg, {
        "CSXS/manifest.xml": '<ExtensionManifest ExtensionBundleVersion="1.80.0"/>',
        "js/main.js": "new main",
        "js/core.js": "same core",
        "app/studio.js": "new studio",
        "app/new_file.js": "brand new",
        "runtime/ethio_srt.pyc": "new engine",
    }, rid=rid)
    r = run(url, sha, size, ext)
    assert r == {"ok": True, "changed": 5, "version": "1.80.0"}, r
    assert read(ext, "js/main.js") == "new main" and read(ext, "app/new_file.js") == "brand new"
    assert read(ext, "runtime/ethio_srt.pyc") == "new engine"
    assert "1.80.0" in read(ext, "CSXS/manifest.xml")
    assert read(ext, "license.json") == "the customer's license", "files not in the package are kept"
    assert read(ext, "runtime/model/model.bin") == "the model"
    assert not os.path.exists(ext + ".update") and not os.path.exists(ext + ".update-backup"), "nothing left behind"
    ok("update: 5 changed files replaced, unchanged files and the license / Python / model left alone, nothing left behind")

    # a wrong checksum (a broken or swapped download): nothing changes
    url2, sha2, size2 = make_package(os.path.join(base, "u2.zip"), {"js/main.js": "evil"}, version="1.80.1", rid=rid)
    r = run(url2, "0" * 64, size2, ext, "1.80.1")
    assert r["ok"] is False and r["error"] == "checksum", r
    assert read(ext, "js/main.js") == "new main"
    ok("a download that does not match the signed checksum is refused, nothing changes")

    # unsafe paths: outside the folder, or into Python / ffmpeg / the model
    for bad in ("../outside.txt", "runtime/python/evil.py", "runtime/bin/ffmpeg.exe", "runtime/model/model.bin", "/abs.txt"):
        u, s, z = make_package(os.path.join(base, "bad.zip"), {bad: "x"}, version="1.80.2", rid=rid)
        r = run(u, s, z, ext, "1.80.2")
        assert r["ok"] is False and ("bad path" in r["error"] or "touches" in r["error"]), (bad, r)
    assert not os.path.exists(os.path.join(base, "outside.txt"))
    assert read(ext, "runtime/model/model.bin") == "the model"
    ok("packages that write outside the folder or into Python / ffmpeg / the model are refused")

    # built for another Python: the full installer is needed, nothing changes
    u, s, z = make_package(os.path.join(base, "u3.zip"), {"js/main.js": "needs new python"}, version="1.80.3", rid="ffffffffffffffff")
    r = run(u, s, z, ext, "1.80.3")
    assert r["ok"] is False and r["error"] == "runtime", r
    assert read(ext, "js/main.js") == "new main"
    # a package that says another version than the one signed
    u, s, z = make_package(os.path.join(base, "u4.zip"), {"js/main.js": "x"}, version="1.99.0", rid=rid)
    r = run(u, s, z, ext, "1.80.4")
    assert r["ok"] is False and r["error"] == "version", r
    ok("a package for another Python / packages, or another version than signed, is refused")

    # a file that cannot be replaced halfway: every replaced file is put back
    u, s, z = make_package(os.path.join(base, "u5.zip"), {"js/a_first.js": "A", "js/main.js": "B", "js/z_last": "C"},
                           version="1.80.5", rid=rid)
    os.makedirs(os.path.join(ext, "js", "z_last"))   # a folder where the file must go: os.replace fails
    r = run(u, s, z, ext, "1.80.5")
    assert r["ok"] is False and r["error"].startswith("replace"), r
    assert read(ext, "js/main.js") == "new main", "rolled back"
    assert not os.path.exists(os.path.join(ext, "js", "a_first.js")), "a new file from the failed update is removed"
    ok("a failure halfway puts every file back (old files restored, new ones removed)")

    # not the program folder
    r = run(url, sha, size, os.path.join(base, "nowhere"))
    assert r["ok"] is False and "program folder" in r["error"], r
    ok("refuses a folder that is not the program")
finally:
    shutil.rmtree(base, ignore_errors=True)

print("\nALL PASS  (%d tests)" % len(PASS))
