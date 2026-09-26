#!/usr/bin/env python3
"""
make_model_manifest.py — describe the CTranslate2 model for amh_model.py.

  python tools/make_model_manifest.py tools/stage/model-ct2-int8 \
      --source https://huggingface.co/<user>/<repo>/resolve/main \
      [--source <mirror>] --out <runtime>/model_manifest.json

Every file in the model folder is listed with its size and SHA-256. The id is
the first 12 hex digits of model.bin's SHA-256, so a new model gets a new
per-user folder and an old download is never mistaken for it.

Upload the SAME files (flat, same names) to every --source base URL; see
tools/MODEL_HOSTING.md.
"""
import argparse
import hashlib
import json
import os
import sys


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--source", action="append", default=[])
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    if not os.path.isfile(os.path.join(a.model_dir, "model.bin")):
        sys.exit("no model.bin in " + a.model_dir)
    for s in a.source:
        if not s.startswith("https://") and not s.startswith("http://127.0.0.1"):
            sys.exit("model source must be an https:// URL: " + s)
    files = []
    for name in sorted(os.listdir(a.model_dir)):
        p = os.path.join(a.model_dir, name)
        if os.path.isfile(p) and not name.startswith("."):
            files.append({"name": name, "size": os.path.getsize(p), "sha256": sha256(p)})
    model_sha = next(f["sha256"] for f in files if f["name"] == "model.bin")
    manifest = {"id": model_sha[:12], "files": files,
                "sources": [s.rstrip("/") + "/" for s in a.source]}
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1)
    total = sum(f["size"] for f in files)
    print("manifest %s: %d files, %.0f MB, sources=%d" % (manifest["id"], len(files), total / 1e6, len(a.source)))


if __name__ == "__main__":
    main()
