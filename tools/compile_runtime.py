#!/usr/bin/env python3
"""
compile_runtime.py — ship the licensing-relevant engine modules as compiled
bytecode, not readable source (1.10.4).

    <bundled python> tools/compile_runtime.py <extension>/runtime

Run with the BUNDLED interpreter of the package being built: a .pyc only
loads in the same Python minor version. For each module below, writes
<name>.pyc next to it (the legacy "sourceless" layout Python imports and runs
directly — `python ethio_srt.pyc --server` works) and deletes <name>.py.

Only the modules that decide who may transcribe are compiled: the engine with
its license check (ethio_srt), the license / trial logic (amh_license) and the
SRT maker (amh_standalone). The panel finds either form (engineFile() in
main.js) and the launchers do the same, so a developer checkout keeps the .py.
Bytecode is not encryption — it raises the effort from "edit a text file" to
"decompile Python 3.11 bytecode", which is the point.
"""
import os
import py_compile
import sys

MODULES = ("ethio_srt", "amh_license", "amh_standalone")


def main(rt):
    done = []
    for name in MODULES:
        src = os.path.join(rt, name + ".py")
        if not os.path.isfile(src):
            raise SystemExit("compile_runtime: missing %s" % src)
        dst = os.path.join(rt, name + ".pyc")
        # dfile: tracebacks name the module, never the build machine's path.
        # optimize=2 also drops the docstrings (they explain the license
        # logic); none of these modules uses __doc__ or assert.
        py_compile.compile(src, cfile=dst, dfile=name + ".py", doraise=True, optimize=2,
                           invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
        os.remove(src)
        done.append(name)
    # The compiled engine must still import and expose its entry points.
    sys.path.insert(0, rt)
    for name in done:
        __import__(name)
    import ethio_srt
    assert callable(ethio_srt.require_license) and callable(ethio_srt.main)
    print("  [ok] compiled %s (python %d.%d)" % (", ".join(n + ".pyc" for n in done), *sys.version_info[:2]))


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isdir(sys.argv[1]):
        raise SystemExit("usage: compile_runtime.py <extension>/runtime")
    main(os.path.abspath(sys.argv[1]))
