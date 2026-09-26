#!/usr/bin/env python3
"""
fetch_lang_eval.py — a fixed, reproducible evaluation set for non-Amharic
languages from Google's WAXAL dataset (google/WaxalNLP, CC-BY-4.0), TEST split.

  python tools/test/fetch_lang_eval.py orm tir [--n 20]

Writes tools/test/fixtures_langs/<lang>/<id>.wav + <id>.txt (16 kHz mono).
Always the first N test rows, so every model is scored on the same clips.
Uses the public datasets-server API (no account needed) and ffmpeg to convert.
"""
import json
import os
import shutil
import subprocess
import sys
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(REPO, "tools", "test", "fixtures_langs")
API = "https://datasets-server.huggingface.co/rows?dataset=google/WaxalNLP&config=%s_asr&split=test&offset=%d&length=%d"


def ffmpeg():
    for p in (os.path.join(REPO, "tools", "stage", "win-x64", "ffmpeg.exe"), shutil.which("ffmpeg")):
        if p and os.path.exists(p):
            return p
    sys.exit("ffmpeg not found")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("langs", nargs="+")
    ap.add_argument("--n", type=int, default=20)
    a = ap.parse_args()
    n = a.n
    for lang in a.langs:
        d = os.path.join(OUT, lang)
        os.makedirs(d, exist_ok=True)
        rows = json.load(urllib.request.urlopen(API % (lang, 0, n), timeout=60))["rows"]
        got = 0
        for r in rows:
            row = r["row"]
            audio = row["audio"]
            src = audio[0]["src"] if isinstance(audio, list) else audio.get("src")
            text = (row.get("transcription") or "").strip()
            if not src or not text:
                continue
            base = os.path.join(d, row["id"])
            raw = base + ".src"
            with urllib.request.urlopen(src, timeout=120) as res, open(raw, "wb") as f:
                shutil.copyfileobj(res, f)
            subprocess.run([ffmpeg(), "-v", "error", "-y", "-i", raw, "-ac", "1", "-ar", "16000", base + ".wav"],
                           check=True)
            os.remove(raw)
            with open(base + ".txt", "w", encoding="utf-8") as f:
                f.write(text + "\n")
            got += 1
        print("%s: %d clips -> %s" % (lang, got, d))


if __name__ == "__main__":
    main()
