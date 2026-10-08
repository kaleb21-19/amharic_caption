#!/usr/bin/env python3
"""
engine_cli.py — run a runtime's engine for TESTS, the way `ethio_srt.py
<audio> <out.srt> [flags]` does, without the license check.

    python tools/test/engine_cli.py <runtime dir> <audio> <out.srt> [--words]
                                    [--group N] [--max-chars N] [--offset S]

Since 1.10.3 the engine refuses to run without a license or a trial ticket
for the computer (ethio_srt.require_license) — on CI machines there is
neither. Test harnesses (run_engine.sh, the accuracy gate) run it through this
file, which stands in for the license check in this process only and then
asks for permission like a real job (since 1.10.6 the model itself checks).
Lives in tools/test/, never in a package. Works with a runtime that has
ethio_srt.py or the compiled .pyc.
"""
import os
import sys


def main(argv):
    if len(argv) < 3:
        raise SystemExit(__doc__)
    rt, audio, out = argv[0], argv[1], argv[2]
    mode, group, max_chars, offset = "grouped", 0, 42, 0.0
    i = 3
    while i < len(argv):
        a = argv[i]
        if a == "--words":
            mode = "words"
        elif a == "--group":
            mode, group = "grouped", int(argv[i + 1])
            i += 1
        elif a == "--max-chars":
            max_chars = int(argv[i + 1])
            i += 1
        elif a == "--offset":
            offset = float(argv[i + 1])
            i += 1
        i += 1
    sys.path.insert(0, os.path.abspath(rt))
    import ethio_srt as es
    import amh_license
    amh_license.engine_auth = lambda lease=None, ticket=None: (True, "test")
    es.require_license()
    wav = es.read_wav(audio)
    engine = es.load_pipeline()
    _text, cues = es._run_file(engine, wav, mode, group, max_chars, offset, out)
    es.write_srt(out, cues, offset)


if __name__ == "__main__":
    main(sys.argv[1:])
