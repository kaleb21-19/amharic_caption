#!/bin/bash
# Amharic Captions Pro for CapCut, DaVinci Resolve and other editors (macOS).
# Opens the app window; files dropped on this launcher open ready to caption.
# AMH_CONSOLE=1 (or a Python without the window library) runs the classic
# SRT maker in this Terminal window instead.
DIR="$(cd "$(dirname "$0")" && pwd)"
RT="$DIR/runtime"
PY="$RT/python/bin/python3"
if [[ ! -x "$PY" ]]; then
  echo "The Amharic Captions files were not found. Run Install.command again."; read -r; exit 1
fi
if [[ -z "${AMH_CONSOLE:-}" && -f "$DIR/app/amh_app.py" ]] && "$PY" -E -s -c "import webview" 2>/dev/null; then
  nohup "$PY" -E -s -X utf8 "$DIR/app/amh_app.py" "$@" >/dev/null 2>&1 &
  disown
  exit 0
fi
"$PY" -E -s -X utf8 "$RT/amh_standalone.py" "$@"
echo; read -r -p "Press Enter to close."
