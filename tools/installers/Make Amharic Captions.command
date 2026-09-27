#!/bin/bash
# Amharic Captions Pro - standalone SRT maker (macOS). Double-click, then drag a
# video or audio file into the window; an .srt appears next to it.
RT="$(cd "$(dirname "$0")" && pwd)/runtime"
if [[ ! -x "$RT/python/bin/python3" ]]; then
  echo "The Amharic Captions files were not found. Run Install.command again."; read -r; exit 1
fi
"$RT/python/bin/python3" -E -s -X utf8 "$RT/amh_standalone.py" "$@"
echo; read -r -p "Press Enter to close."
