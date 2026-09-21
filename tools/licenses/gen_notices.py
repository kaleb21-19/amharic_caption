#!/usr/bin/env python3
"""
gen_notices.py — emit THIRD-PARTY-NOTICES.md for one built target.

Run from tools/build.sh and tools/build_win.ps1 at assemble time, against the
runtime that is about to be zipped. Python (not bash) so the Windows build can
call it the same way, without depending on Git-Bash being on PATH under pwsh.

Two things are read from the artefacts themselves rather than hand-listed, so
the notice cannot drift away from what actually ships:

  * ffmpeg's ./configure line, scanned out of the binary. ffmpeg embeds it as a
    plain string, so this works even when cross-staging a target we cannot
    execute (an x86_64 ffmpeg on an arm64 runner, or ffmpeg.exe on a Mac).
    Whether the build is GPLv2 or GPLv3 is derived from that line, not assumed.

  * the bundled Python packages, enumerated from their .dist-info METADATA.

usage:
  gen_notices.py --ffmpeg RT/bin/ffmpeg --runtime RT --target mac-arm64 \
                 --out BUILD/licenses/THIRD-PARTY-NOTICES.md
"""
import argparse
import os
import re
import subprocess
import sys

# Packages whose METADATA carries no usable License:/Classifier: field. Kept
# short and explicit rather than silently printing "UNKNOWN" to a customer.
LICENSE_FALLBACK = {
    "numpy": "BSD-3-Clause",
    "cffi": "MIT",
    "pycparser": "BSD-3-Clause",
    "packaging": "Apache-2.0 OR BSD-2-Clause",
    "typing_extensions": "PSF-2.0",
    "sherpa_onnx": "Apache-2.0",
}

# Non-pip components copied into the runtime by build.sh. Each is only listed
# if the corresponding file is actually present in the built runtime.
BUNDLED = [
    ("model/", "Ethio-ASR-amharic (speech recognition weights, CTranslate2 int8)",
     "https://huggingface.co/badrex/Ethio-ASR-amharic"),
    ("speaker_embed.onnx",
     "NVIDIA NeMo TitaNet-Small (speaker embeddings) — NVIDIA NeMo is "
     "Apache-2.0; redistributed as the ONNX export published by sherpa-onnx",
     "https://github.com/k2-fsa/sherpa-onnx/releases/tag/speaker-recongition-models"),
    ("silero_vad.onnx", "Silero VAD (voice activity detection) — MIT",
     "https://github.com/snakers4/silero-vad"),
    ("amh_lm.json.gz", "Amharic word-frequency language model, built from public Amharic text",
     "https://github.com/geezorg/data"),
]

# Shipped inside the panel itself (not the runtime).
PANEL_COMPONENTS = [
    ("CSInterface.js", "Adobe CEP JavaScript interface — BSD-3-Clause, (c) Adobe Systems Inc.",
     "https://github.com/Adobe-CEP/CEP-Resources"),
    ("json2.jsx", "json2 JSON parser/serialiser for ExtendScript — Public Domain",
     "https://github.com/douglascrockford/JSON-js"),
]


def ffmpeg_configure(path):
    """Scan the embedded ./configure line out of the ffmpeg binary."""
    try:
        with open(path, "rb") as fh:
            blob = fh.read()
    except OSError:
        return ""
    m = re.search(rb"--prefix=[ -~]{20,4000}", blob)
    return m.group(0).decode("ascii", "replace") if m else ""


def ffmpeg_version(path):
    """Best-effort version. Only works when the target binary is executable on
    this host; cross-staged builds fall back to the configure line alone."""
    try:
        out = subprocess.run([path, "-version"], capture_output=True, timeout=30)
        first = out.stdout.decode("utf-8", "replace").splitlines()[0]
        m = re.match(r"ffmpeg version (\S+)", first)
        if m:
            return m.group(1)
    except Exception:
        pass
    return ""


def python_packages(runtime):
    """Enumerate bundled pip packages from their .dist-info METADATA."""
    roots = [
        os.path.join(runtime, "python", "lib", "python3.11", "site-packages"),
        os.path.join(runtime, "python", "Lib", "site-packages"),
    ]
    found = {}
    for root in roots:
        if not os.path.isdir(root):
            continue
        for entry in sorted(os.listdir(root)):
            if not entry.endswith(".dist-info"):
                continue
            name = entry[: -len(".dist-info")].rsplit("-", 1)[0]
            meta = os.path.join(root, entry, "METADATA")
            lic = ""
            try:
                with open(meta, "r", encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if line.startswith("License:") and not lic:
                            lic = line.split(":", 1)[1].strip()
                        elif line.startswith("Classifier: License ::") and not lic:
                            lic = line.rsplit("::", 1)[1].strip()
                        elif line.startswith("Classifier: License ::") and lic:
                            pass
                        if line.strip() == "":
                            break
            except OSError:
                pass
            # Long prose licence fields are useless in a notice; prefer the map.
            if not lic or len(lic) > 40:
                lic = LICENSE_FALLBACK.get(name, lic or "see package metadata")
            if len(lic) > 40:
                lic = LICENSE_FALLBACK.get(name, "see package metadata")
            found[name] = lic
    return sorted(found.items())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--runtime", required=True)
    ap.add_argument("--target", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    cfg = ffmpeg_configure(args.ffmpeg)
    if not cfg:
        print("[FAIL] could not read ffmpeg configure line from " + args.ffmpeg,
              file=sys.stderr)
        return 1
    if "--enable-nonfree" in cfg:
        # prepare_python.sh already blocks this; refuse again at assemble time
        # so a hand-placed binary cannot slip past a skipped prepare step.
        print("[FAIL] bundled ffmpeg is --enable-nonfree and cannot be "
              "redistributed: " + args.ffmpeg, file=sys.stderr)
        return 1

    gpl = "--enable-gpl" in cfg
    v3 = "--enable-version3" in cfg
    if gpl:
        lic_name = "GPL version 3 or later" if v3 else "GPL version 2 or later"
        lic_file = "COPYING.GPLv3.txt" if v3 else "COPYING.GPLv2.txt"
    else:
        lic_name = "LGPL version 2.1 or later"
        lic_file = "COPYING.LGPLv2.1.txt"

    ver = ffmpeg_version(args.ffmpeg)
    # Avoid nesting backticks inside the code span when falling back.
    ver_txt = ("`%s`" % ver) if ver else \
        "see `ffmpeg -version` (cross-staged build; not executable on the build host)"

    L = []
    w = L.append
    w("# Third-Party Notices — Amharic Captions Pro")
    w("")
    w("Build target: `%s`" % args.target)
    w("")
    w("This product bundles the third-party components listed below. Full "
      "licence texts for the copyleft components are in this folder.")
    w("")
    w("## FFmpeg")
    w("")
    w("* Upstream: https://ffmpeg.org")
    w("* Version: %s" % ver_txt)
    w("* Licence: **%s** — see `%s`" % (lic_name, lic_file))
    w("")
    w("FFmpeg is included as a standalone command-line executable at "
      "`com.amharic.captions/runtime/bin/`. Amharic Captions Pro runs it as a "
      "separate child process and does not link against it.")
    w("")
    if gpl:
        w("Because this is a GPL build, your rights to the FFmpeg binary are "
          "governed by the GPL. A written offer for the complete corresponding "
          "source code is in `WRITTEN-OFFER.txt` in this folder.")
        w("")
    w("Build configuration of the exact binary shipped here:")
    w("")
    w("```")
    w(cfg)
    w("```")
    w("")
    w("Parts of FFmpeg are under the LGPL v2.1 or later; that text is included "
      "as `COPYING.LGPLv2.1.txt`.")
    w("")

    w("## Models and data")
    w("")
    for rel, desc, url in BUNDLED:
        target = os.path.join(args.runtime, rel.rstrip("/"))
        if os.path.exists(target):
            w("* **%s** — %s" % (desc, url))
    w("")

    w("## Bundled Python runtime")
    w("")
    w("* **CPython** — Python Software Foundation License 2.0. Redistributed as "
      "a relocatable build from python-build-standalone "
      "(https://github.com/astral-sh/python-build-standalone).")
    w("")
    pkgs = python_packages(args.runtime)
    if pkgs:
        w("Python packages included in the runtime:")
        w("")
        w("| Package | Licence |")
        w("| --- | --- |")
        for name, lic in pkgs:
            w("| %s | %s |" % (name, lic))
        w("")
        w("`onnxruntime` ships its own detailed attributions at "
          "`runtime/python/.../onnxruntime/ThirdPartyNotices.txt`.")
        w("")

    w("## Panel")
    w("")
    for _f, desc, url in PANEL_COMPONENTS:
        w("* **%s** — %s" % (_f, desc))
        w("  %s" % url)
    w("")

    out_dir = os.path.dirname(args.out)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(L) + "\n")
    print("  [ok] THIRD-PARTY-NOTICES.md (%s, ffmpeg %s)"
          % (args.target, lic_name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
