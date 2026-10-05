#!/bin/bash
# Amharic Captions Pro for CapCut, DaVinci Resolve and other editors (macOS).
# Opens the app window; files dropped on this launcher open ready to caption.
# AMH_CONSOLE=1 runs the classic SRT maker in this Terminal window instead.
# When the app cannot open, this window says WHY before falling back, so a
# customer's screenshot is enough for support.
DIR="$(cd "$(dirname "$0")" && pwd)"
RT="$DIR/runtime"
PY="$RT/python/bin/python3"
if [[ ! -x "$PY" ]]; then
  echo "The Amharic Captions files were not found. Run Install.command again."; read -r; exit 1
fi
if [[ -z "${AMH_CONSOLE:-}" ]]; then
  if [[ ! -f "$DIR/app/amh_app.py" ]]; then
    echo "  [!] This install has no app folder (older version). Install the latest version"
    echo "      from https://amharic-caption-pro.vercel.app/install/ to get the app window."
  else
    WHY="$("$PY" -E -s -c "import webview" 2>&1 >/dev/null | tail -n 3)"
    if [[ -z "$WHY" ]]; then
      LOG="${TMPDIR:-/tmp}/amharic-captions-app.log"
      nohup "$PY" -E -s -X utf8 "$DIR/app/amh_app.py" "$@" </dev/null >"$LOG" 2>&1 &
      APP=$!
      disown
      sleep 5
      if kill -0 "$APP" 2>/dev/null; then
        echo "  The Amharic Captions window is open. You can close this Terminal window."
        exit 0
      fi
      echo "  [!] The app window stopped right away. Send a screenshot of this to support:"
      tail -n 6 "$LOG" | sed 's/^/      /'
    else
      echo "  [!] The app window cannot open on this Mac. Send a screenshot of this to support:"
      echo "$WHY" | sed 's/^/      /'
    fi
  fi
  echo
  echo "  Using the classic SRT maker in this window instead."
  echo
fi
"$PY" -E -s -X utf8 "$RT/amh_standalone.py" "$@"
echo; read -r -p "Press Enter to close."
