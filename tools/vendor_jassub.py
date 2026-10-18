"""Copy JASSUB (libass in WebAssembly) into app/vendor for the Studio's live
caption-style preview (1.29.0). A developer tool, run once per JASSUB update:

  python tools/vendor_jassub.py <dir with the extracted npm packages>

The dir holds the npm tarballs extracted as <name>/package/ for jassub 2.5.21,
abslink 1.3.1, lfa-ponyfill 1.1.1 (checksums verified
against the npm registry), plus LGPL-2.1.txt and Apache-2.0.txt.

Only the import lines are changed (a bare package name -> a relative file,
the page has no bundler); every library is otherwise copied unmodified.
rvfc-polyfill (GPL-3.0) is NOT shipped: it only fills in
requestVideoFrameCallback for old browsers, which the app's WebView2 / WebKit
already have; jassub's import of it points at our own empty module instead.
"""
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "app", "vendor")

# (source under <dir>, destination under app/vendor, {bare import: relative path})
FILES = [
    ("jassub/package/dist/jassub.js", "jassub/dist/jassub.js",
     {"'rvfc-polyfill'": "'../../rvfc-empty.js'", "'abslink'": "'../../abslink/src/abslink.js'",
      "'abslink/w3c'": "'../../abslink/adapters/w3c.js'"}),
    ("jassub/package/dist/debug.js", "jassub/dist/debug.js", {"'throughput'": "'../../throughput-stub.js'"}),
    ("jassub/package/dist/worker/worker.js", "jassub/dist/worker/worker.js",
     {"'abslink'": "'../../../abslink/src/abslink.js'", "'abslink/w3c'": "'../../../abslink/adapters/w3c.js'",
      "'lfa-ponyfill'": "'../../../lfa-ponyfill/index.js'"}),
    ("jassub/package/dist/worker/util.js", "jassub/dist/worker/util.js", {}),
    ("jassub/package/dist/worker/extern-pre-worker.js", "jassub/dist/worker/extern-pre-worker.js", {}),
    ("jassub/package/dist/worker/renderers/2d-renderer.js", "jassub/dist/worker/renderers/2d-renderer.js", {}),
    ("jassub/package/dist/worker/renderers/webgl1-renderer.js", "jassub/dist/worker/renderers/webgl1-renderer.js", {}),
    ("jassub/package/dist/worker/renderers/webgl2-renderer.js", "jassub/dist/worker/renderers/webgl2-renderer.js", {}),
    ("jassub/package/dist/worker/renderers/readback.js", "jassub/dist/worker/renderers/readback.js", {}),
    ("jassub/package/dist/wasm/jassub-worker.js", "jassub/dist/wasm/jassub-worker.js", {}),
    ("jassub/package/dist/wasm/jassub-worker.wasm", "jassub/dist/wasm/jassub-worker.wasm", None),
    ("jassub/package/dist/wasm/jassub-worker-modern.wasm", "jassub/dist/wasm/jassub-worker-modern.wasm", None),
    ("jassub/package/LICENSE", "jassub/LICENSE", None),
    ("abslink/package/src/abslink.js", "abslink/src/abslink.js", {}),
    ("abslink/package/src/types.js", "abslink/src/types.js", {}),
    ("abslink/package/adapters/w3c.js", "abslink/adapters/w3c.js", {}),
    ("lfa-ponyfill/package/index.js", "lfa-ponyfill/index.js", {}),
    ("Apache-2.0.txt", "abslink/LICENSE", None),
    ("LGPL-2.1.txt", "jassub/LGPL-2.1.txt", None),
]

MIT = """MIT License

Copyright (c) ThaUnknown

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

NOTICE = """Third-party code in app/vendor (Amharic Captions Studio, live caption preview)
==============================================================================

jassub 2.5.21 - https://github.com/ThaUnknown/jassub - MIT (jassub/LICENSE).
  JavaScript + WebAssembly build of libass. The WebAssembly files
  jassub/dist/wasm/jassub-worker*.wasm are unmodified and contain:
    libass (ISC), FreeType (FTL: portions of this software are copyright
    (c) The FreeType Project, www.freetype.org), HarfBuzz (MIT),
    FriBidi (LGPL-2.1-or-later, full text in jassub/LGPL-2.1.txt),
    Expat / zlib / Brotli / Emscripten runtime (MIT, Zlib, BSL-1.0,
    MIT-Modern-Variant, NTP) - see the jassub package's license field.
  LGPL: the libraries are a separate, replaceable file (jassub-worker*.wasm),
  loaded at run time; their source code and the build scripts are at
  https://github.com/ThaUnknown/jassub (tag 2.5.21) and the projects above.
  You may replace those files with your own build.
abslink 1.3.1 - https://github.com/ThaUnknown/abslink - Apache-2.0 (abslink/LICENSE).
lfa-ponyfill 1.1.1 - https://github.com/ThaUnknown/lfa-ponyfill - MIT (lfa-ponyfill/LICENSE).

Changes: only the import lines of jassub.js, debug.js and worker/worker.js
(package names -> relative files, no bundler). rvfc-polyfill (GPL-3.0) is
not included; rvfc-empty.js (ours) stands in for it. throughput (only used
by JASSUB's debug mode) is not included; throughput-stub.js (ours) stands in.
"""


def main(src):
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    for s, d, repl in FILES:
        sp, dp = os.path.join(src, s), os.path.join(OUT, d)
        os.makedirs(os.path.dirname(dp), exist_ok=True)
        if repl is None:
            shutil.copyfile(sp, dp)
            continue
        text = open(sp, encoding="utf-8").read()
        for a, b in repl.items():
            if a not in text:
                raise SystemExit("import %s not found in %s" % (a, s))
            text = text.replace("from " + a, "from " + b).replace("import " + a, "import " + b)
        with open(dp, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    for name in ("lfa-ponyfill",):
        with open(os.path.join(OUT, name, "LICENSE"), "w", encoding="utf-8", newline="") as f:
            f.write(MIT)
    with open(os.path.join(OUT, "rvfc-empty.js"), "w", encoding="utf-8", newline="") as f:
        f.write("// Stands in for rvfc-polyfill (GPL-3.0, not shipped): the app's browser engines have\n"
                "// HTMLVideoElement.requestVideoFrameCallback already.\nexport {};\n")
    with open(os.path.join(OUT, "throughput-stub.js"), "w", encoding="utf-8", newline="") as f:
        f.write("// Stands in for the throughput package (CommonJS, only used by JASSUB's debug mode,\n"
                "// which the Studio never turns on).\nexport default function () { return () => 0; }\n")
    with open(os.path.join(OUT, "NOTICE.txt"), "w", encoding="utf-8", newline="") as f:
        f.write(NOTICE)
    total = sum(os.path.getsize(os.path.join(r, n)) for r, _, fs in os.walk(OUT) for n in fs)
    print("app/vendor: %d files, %.1f MB" % (sum(len(fs) for _, _, fs in os.walk(OUT)), total / 1e6))


if __name__ == "__main__":
    main(sys.argv[1])
