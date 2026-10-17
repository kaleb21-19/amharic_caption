#!/usr/bin/env python3
"""Run the tests for an area and print ONLY failures + one summary line per
suite (saves reading thousands of lines).

  python tools/agent/test.py panel|host|styles|app|bot|texts|versions|all  [-v]

panel needs a runtime/ folder: when this checkout has none, a junction to the
main clone's runtime is made for the run and removed afterwards (only the
junction - never the folder it points to). Set AMH_RUNTIME_SRC to choose it.
styles uses the installed product's ffmpeg when AMH_FFMPEG is not set.
"""
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
WIN = os.name == "nt"
MAIN_RUNTIME = os.environ.get("AMH_RUNTIME_SRC") or r"C:\Users\ROG\Downloads\Compressed\amharic_caption-git\runtime"
FAIL_RE = re.compile(r"\bFAIL|AssertionError|Error:|Traceback|not ok\b", re.I)
SUM_RE = re.compile(r"ALL PASS|FAILURES|\d+ checks|\d+ passed|all green|versions consistent", re.I)


def suites(area):
    node = ["node"]
    py = [sys.executable]
    # the engine imports numpy/soundfile: the installed panel's own Python has them
    cep_py = os.path.join(os.environ.get("APPDATA", ""), "Adobe", "CEP", "extensions", "com.amharic.captions",
                          "runtime", "python", "python.exe" if WIN else "bin/python3")
    engine_py = [cep_py, "-E", "-s"] if os.path.exists(cep_py) and os.path.getsize(cep_py) > 0 else py
    host = sorted(f for f in os.listdir(os.path.join(ROOT, "tools", "test")) if f.startswith("test_host_") and f.endswith(".js"))
    table = {
        "panel": [("panel unit", node + ["tools/test/test_panel.js"], ROOT),
                  ("panel DOM", node + ["tools/test/test_panel_dom.js"], ROOT)],
        "host": [(f[:-3], node + ["tools/test/" + f], ROOT) for f in host],
        "styles": [("styles", py + ["tools/test/test_styles.py"], ROOT)],
        "texts": [("trial texts", py + ["tools/test/test_trial_texts.py"], ROOT)],
        "engine": [("word times", engine_py + ["tools/test/test_word_times.py"], ROOT)],
        "app": [("app", py + ["tools/test/test_app.py"], ROOT), ("app shim", node + ["tools/test/test_app_shim.js"], ROOT),
                ("studio", node + ["tools/test/test_studio.js"], ROOT)],
        "bot": [("bot e2e", node + ["test/e2e.mjs"], os.path.join(ROOT, "tools", "telegram-worker"))],
        "versions": [("versions", ["bash", "tools/check_versions.sh"], ROOT)],
    }
    if area == "all":
        return [s for k in ("versions", "panel", "host", "styles", "texts", "engine", "app", "bot") for s in table[k]]
    if area not in table:
        sys.exit("area must be one of: %s, all" % ", ".join(table))
    return table[area]


def env_for():
    env = dict(os.environ)
    if not env.get("AMH_FFMPEG"):
        cand = os.path.join(os.environ.get("APPDATA", ""), "Adobe", "CEP", "extensions", "com.amharic.captions",
                            "runtime", "bin", "ffmpeg.exe" if WIN else "ffmpeg")
        if os.path.isfile(cand):
            env["AMH_FFMPEG"] = cand
    return env


def with_runtime(fn):
    rt = os.path.join(ROOT, "runtime")
    made = False
    if not os.path.exists(rt):
        src = MAIN_RUNTIME
        if not os.path.isdir(src) or os.path.abspath(src) == os.path.abspath(rt):
            print("  note: no runtime/ for the panel DOM test (set AMH_RUNTIME_SRC)")
        elif WIN:
            made = subprocess.run(["cmd", "/c", "mklink", "/J", rt, src], capture_output=True).returncode == 0
        else:
            os.symlink(src, rt)
            made = True
    try:
        return fn()
    finally:
        if made:
            # removes the junction / link only; the folder it points to stays
            if WIN:
                os.rmdir(rt)
            else:
                os.unlink(rt)
            if not os.path.isdir(MAIN_RUNTIME):
                print("  !! the main runtime folder is missing after the run - check it")


def run(name, cmd, cwd, verbose):
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", env=env_for())
    out = (p.stdout or "") + (p.stderr or "")
    lines = [l for l in out.splitlines() if "Fontconfig" not in l]
    fails = [l for l in lines if FAIL_RE.search(l) and "[OK]" not in l and not l.strip().startswith("ok ")]
    summary = next((l.strip() for l in reversed(lines) if SUM_RE.search(l)), lines[-1].strip() if lines else "")
    ok = p.returncode == 0
    print("%s %-22s %s" % ("PASS" if ok else "FAIL", name, summary[:110]))
    if not ok or verbose:
        for l in (lines if verbose else fails[:25]):
            print("     " + l[:200])
    return ok


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    args = [a for a in sys.argv[1:] if a != "-v"]
    verbose = "-v" in sys.argv
    if len(args) != 1:
        sys.exit(__doc__)
    todo = suites(args[0])
    needs_rt = any(n == "panel DOM" for n, _, _ in todo)
    results = []
    body = lambda: [results.append(run(n, c, d, verbose)) for n, c, d in todo]
    with_runtime(body) if needs_rt else body()
    bad = results.count(False)
    print("== %d suite(s), %s" % (len(results), "all passed" if not bad else "%d FAILED" % bad))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
