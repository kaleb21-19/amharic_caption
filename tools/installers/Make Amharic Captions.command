#!/bin/bash
# Amharic Captions - standalone SRT maker (macOS). Double-click, then drag a
# video or audio file into the window; an .srt appears next to it.
RT="$(cd "$(dirname "$0")" && pwd)/runtime"
if [[ ! -x "$RT/python/bin/python3" ]]; then
  echo "Runtime not found at $RT. Run Install.command again."; read -r; exit 1
fi
"$RT/python/bin/python3" -E -s -X utf8 "$RT/amh_standalone.py" "$@"
echo; read -r -p "Press Enter to close."
