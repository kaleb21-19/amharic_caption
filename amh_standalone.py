"""
amh_standalone.py — Amharic captions without Premiere / After Effects.

Drag one or more video/audio files onto "Make Amharic Captions" (the desktop
shortcut Install.cmd creates) and an .srt appears next to each file, ready to
import into CapCut, DaVinci Resolve, older Premiere, YouTube, etc.

  python amh_standalone.py <file> [<file> ...] [--karaoke] [--speakers]

Licensing is shared with the panel (amh_license.py): a licensed machine runs
freely; otherwise each file uses one of the 2 free transcriptions, charged on
the server only after a transcription succeeds. The console speaks Amharic
with English underneath, because Windows 10's legacy console cannot draw
Ethiopic glyphs and a user must never be left with only boxes on screen.
"""

import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import amh_license as lic  # noqa: E402

MEDIA_EXT = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".m4v", ".webm", ".mts", ".mxf",
             ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
# Same clean-up chain as the panel's extractAudio() (AUDIO_CLEAN_FILTER).
AUDIO_CLEAN_FILTER = "highpass=f=80,lowpass=f=7500,afftdn=nf=-25"
BUY_URL = "https://t.me/AmharicCaptionsBot"


WIDTH = 64
# Markers in plain ASCII: Windows 10's console draws ✓ ✗ 📁 🔔 as empty boxes.
OK, ERR, NOTE = "  [OK] ", "  [!]  ", "  [i]  "
LOG = os.path.join(tempfile.gettempdir(), "amharic-captions-srt.log")


def say(am, en=None):
    """One message, Amharic first, English under it."""
    print(am)
    if en:
        print("       " + en if am.startswith("  [") else "   " + en)
    sys.stdout.flush()


def rule():
    print("-" * WIDTH)


def banner(version):
    print()
    print("=" * WIDTH)
    title = "  Amharic Captions Pro  |  SRT maker"
    print(title + ("v" + version).rjust(WIDTH - len(title) - 2) if version else title)
    print("  አማርኛ ካፕሽን ፕሮ — ለCapCut፣ DaVinci Resolve እና ለሌሎች ኤዲተሮች")
    print("=" * WIDTH)


class _EngineLog:
    """The engine reports its internals on stderr ("[info] engine: CTranslate2
    int8", resume notes, warnings). Useful for support, noise for an editor:
    while it runs, stderr goes to a log file in the temp folder instead."""

    def __enter__(self):
        self._old = sys.stderr
        try:
            self._f = open(LOG, "a", encoding="utf-8")
            self._f.write("\n==== %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            sys.stderr = self._f
        except OSError:
            self._f = None
        return self

    def __exit__(self, *exc):
        sys.stderr = self._old
        if self._f:
            self._f.close()
        return False


def drop_sidecars(srt_path):
    """Only the .srt belongs next to the video. The engine also writes
    <name>.srt.doubt.json (doubtful-word marks for the panel's review screen)
    and a <name>.srt.part.json resume journal — meaningless in CapCut or
    DaVinci, and customers asked what the .json file was."""
    for ext in (".doubt.json", ".part.json"):
        try:
            os.remove(srt_path + ext)
        except OSError:
            pass


def open_folder(path):
    """Show the finished .srt in Explorer / Finder, selected. Customers asked
    "where is the file?" — this answers it. AMH_NO_OPEN=1 disables (tests)."""
    if os.environ.get("AMH_NO_OPEN") == "1":
        return
    try:
        if sys.platform == "win32":
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", path])
    except Exception:
        pass


def copy_to_clipboard(text):
    """Best effort; returns True when the text is on the clipboard."""
    if os.environ.get("AMH_NO_OPEN") == "1":
        return False
    try:
        if sys.platform == "win32":
            flags = subprocess.CREATE_NO_WINDOW
            r = subprocess.run(["clip"], input=text.encode("ascii"), creationflags=flags)
        elif sys.platform == "darwin":
            r = subprocess.run(["pbcopy"], input=text.encode("ascii"))
        else:
            return False
        return r.returncode == 0
    except Exception:
        return False


def fmt_secs(s):
    s = int(round(s))
    return "%d:%02d" % (s // 60, s % 60)


def progress_bar(done, total):
    """Replaces ethio_srt's machine-readable "[progress] 3/15" lines (meant for
    the panel) with a bar a person can read, redrawn on one line."""
    if total <= 1:
        return
    width = 24
    fill = int(width * done / total)
    sys.stdout.write("\r   [%s%s] %3d%%" % ("#" * fill, "." * (width - fill), 100 * done // total))
    if done >= total:
        sys.stdout.write("\n")
    sys.stdout.flush()


def ffmpeg_path():
    name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
    p = os.path.join(HERE, "bin", name)
    return p if os.path.isfile(p) else name


def extract_audio(src, wav):
    cmd = [ffmpeg_path(), "-v", "error", "-y", "-i", src, "-vn", "-sn",
           "-af", AUDIO_CLEAN_FILTER, "-ac", "1", "-ar", "16000", wav]
    flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    r = subprocess.run(cmd, capture_output=True, text=True, creationflags=flags)
    if r.returncode != 0 or not os.path.isfile(wav) or os.path.getsize(wav) < 1000:
        raise RuntimeError((r.stderr or "").strip()[-400:] or "ffmpeg failed")


def output_path(src):
    """<name>.srt beside the source; never overwrite a finished file. A path
    with a resume journal (long audio cut off by a power cut or a closed
    window) is reused, so ethio_srt continues where it stopped."""
    base = os.path.splitext(src)[0]
    out = base + ".srt"
    n = 2
    while os.path.exists(out):
        if os.path.exists(out + ".part.json") or os.path.exists(out + ".pending.part.json"):
            return out
        out = "%s (%d).srt" % (base, n)
        n += 1
    return out


def ask_files():
    say("ቪዲዮ ወይም የድምፅ ፋይል ወደዚህ መስኮት ይጎትቱ እና Enter ይጫኑ፦",
        "Drag a video or audio file into this window, then press Enter:")
    try:
        raw = input("> ").strip()
    except EOFError:
        return []
    if not raw:
        return []
    if sys.platform == "win32":
        # Windows quotes a dragged path that contains spaces.
        return [raw.strip('"').strip("'")]
    # macOS Terminal escapes spaces ("My\\ Video.mp4") and separates several
    # dragged files with spaces; shlex undoes exactly that.
    import shlex
    try:
        return shlex.split(raw)
    except ValueError:
        return [raw]


def ensure_license(mid, n_files):
    """Return 'licensed', 'trial', or None (stop)."""
    ok, info = lic.licensed(mid)
    if ok:
        say(OK + "ፈቃድ አለው።", "Licensed." + ("" if info == "00000000" else " (expires %s)" % info))
        return "licensed"

    status = lic.trial_status(mid)
    if status is None:
        say("ኢንተርኔት ያስፈልጋል፦ ያለ ፈቃድ ለነጻ ሙከራ ከሰርቨሩ ጋር መገናኘት አለብን።",
            "Internet needed: free trials are checked with the server when there is no license.")
        return offer_activation(mid)
    remaining = int(status.get("remaining", 0))
    if remaining > 0:
        say(NOTE + "ሙከራ፦ %d ነጻ ሙከራ ቀርቷል።" % remaining,
            "Trial: %d free transcription(s) left." % remaining)
        if n_files > remaining:
            say(NOTE + "ማሳሰቢያ፦ %d ፋይሎች ሰጥተዋል፣ ግን %d ነጻ ሙከራ ብቻ ቀርቷል።" % (n_files, remaining),
                "Note: you gave %d files but only %d free transcription(s) remain." % (n_files, remaining))
        return "trial"
    say(ERR + "ነጻ ሙከራዎቹ አልቀዋል።", "Your free trials are used up.")
    return offer_activation(mid)


def offer_activation(mid):
    rule()
    say("የማሽን መለያዎ (Machine ID)፦  " + mid)
    if copy_to_clipboard(mid):
        say("   (ተቀድቷል — በቦቱ ላይ ይለጥፉት)", "(copied — paste it in the bot)")
    say("ፈቃድ ለመግዛት፦ 2,500 ብር ለ KALEB TEGEGEN ብቻ በባንክ ያስተላልፉ፣ ከዚያ Machine ID ውን እና ስክሪንሾቱን ለቦቱ ይላኩ፦",
        "To buy: pay ETB 2,500 by bank transfer to KALEB TEGEGEN only, then send the Machine ID")
    say("   " + BUY_URL, "and the payment screenshot to the bot above.")
    rule()
    say("የማግበሪያ ኮድ (XXXX-XXXX) ወይም ቁልፍ ካለዎት እዚህ ይለጥፉ እና Enter ይጫኑ (ለመውጣት ባዶ ይተዉ)፦",
        "If you have an activation code (XXXX-XXXX) or a key, paste it here and press Enter (leave empty to quit):")
    try:
        key = input("> ").strip()
    except EOFError:
        return None
    if not key:
        return None
    ok, msg = lic.activate(mid, key)
    if ok:
        say(OK + "ፈቃዱ ገቢር ሆኗል። በPremiere/After Effects ፓነልም ይሰራል።",
            "License activated. It also unlocks the Premiere/After Effects panel.")
        return "licensed"
    say(ERR + msg)
    return None


def ensure_model():
    """Lite packages: download the model once (resumable) before first use."""
    import amh_model
    manifest = amh_model.load_manifest()
    if not manifest or amh_model.resolve():
        return True
    total_mb = sum(f["size"] for f in manifest["files"]) / 1e6
    rule()
    say("የአማርኛ ሞዴሉ (%d MB) አንድ ጊዜ ብቻ መውረድ አለበት። ኢንተርኔት ቢቋረጥ ካቆመበት ይቀጥላል።" % total_mb,
        "The Amharic model (%d MB) is downloaded once. If the connection drops, it resumes." % total_mb)

    def prog(done, total):
        sys.stdout.write("\r   %d / %d MB   " % (done / 1e6, total / 1e6))
        sys.stdout.flush()
    try:
        amh_model.download(manifest, prog)
    except Exception as e:
        print()
        say(ERR + "ሞዴሉን ማውረድ አልተቻለም። ኢንተርኔትዎን ፈትሸው እንደገና ይሞክሩ — ካቆመበት ይቀጥላል።",
            "Could not download the model (%s). Check your internet and run again; it resumes." % e)
        return False
    print()
    say(OK + "ሞዴሉ ወርዷል።", "Model downloaded and verified.")
    return True


def transcribe(engine, src, out_srt, mode, speakers):
    import ethio_srt as es
    es._emit_progress = progress_bar
    with tempfile.TemporaryDirectory(prefix="amh_srt_") as tmp:
        wav = os.path.join(tmp, "audio.wav")
        say("   ድምፁን በማውጣት ላይ…", "Reading the audio…")
        extract_audio(src, wav)
        audio = es.read_wav(wav)
        secs = len(audio) / 16000
        say("   ወደ ጽሑፍ በመቀየር ላይ (%s ደቂቃ ድምፅ)… እባክዎ ይጠብቁ።" % fmt_secs(secs),
            "Transcribing %s of audio… please wait." % fmt_secs(secs))
        group = 3 if mode == "words" else 0
        with _EngineLog():
            _text, cues = es._run_file(engine, audio, mode, group, 42, 0.0, out_srt, speakers=speakers)
            n = es.write_srt(out_srt, cues, 0.0)
        drop_sidecars(out_srt)
        return n


def main(argv):
    mode = "grouped"
    speakers = False
    files = []
    for a in argv:
        if a == "--karaoke":
            mode = "words"
        elif a == "--speakers":
            speakers = True
        elif not a.startswith("--"):
            files.append(a)

    try:
        version = lic.installed_version(HERE) or ""
    except Exception:
        version = ""
    banner(version)
    if not files:
        files = ask_files()
    files = [os.path.abspath(f) for f in files]
    good = [f for f in files if os.path.isfile(f) and os.path.splitext(f)[1].lower() in MEDIA_EXT]
    for f in files:
        if f not in good:
            say(ERR + "የሚደገፍ ፋይል አይደለም፦ " + os.path.basename(f), "Not a supported video/audio file.")
    if not good:
        return 1

    mid = lic.get_or_create_machine_id()
    state = ensure_license(mid, len(good))
    if not state:
        return 1

    if not ensure_model():
        return 1
    say("   ሞዴሉን በመጫን ላይ…", "Loading the Amharic model…")
    import ethio_srt as es
    with _EngineLog():
        engine = es.load_pipeline()

    done = 0
    last_saved = None
    saved = []
    for i, src in enumerate(good, 1):
        rule()
        say("[%d/%d] %s" % (i, len(good), os.path.basename(src)))
        final = output_path(src)
        # A free transcription is charged BEFORE it is made (1.10.6): the
        # server's ticket for it is what lets the engine run. (Charging after
        # left a finished caption on disk when the window was closed first.)
        remaining = None
        ticket = None
        if state == "trial":
            charged, remaining = lic.trial_charge(mid, lic.new_run_id())
            ticket = lic.last_ticket() if charged else None
            if not ticket:
                say(ERR + "ነጻ ሙከራውን ማረጋገጥ አልተቻለም (ኢንተርኔት የለም ወይም ሙከራዎቹ አልቀዋል)።",
                    "Could not confirm the free trial with the server (offline, or trials used up).")
                break
        try:
            es.require_license(None, ticket)
        except es.LicenseRequired as e:
            say(ERR + "ፈቃድ ያስፈልጋል።", str(e))
            break
        t0 = time.monotonic()
        try:
            n = transcribe(engine, src, final, mode, speakers)
        except Exception as e:
            say(ERR + "ይህን ፋይል ወደ ጽሑፍ መቀየር አልተቻለም።", "Could not transcribe this file: %s" % e)
            say("       ዝርዝር፦ " + LOG, "Details for support: " + LOG)
            if state == "trial" and os.path.exists(final):
                os.remove(final)
            drop_sidecars(final)
            continue
        finally:
            es.end_permit()
        done += 1
        last_saved = final
        saved.append(final)
        took = fmt_secs(time.monotonic() - t0)
        say(OK + "ተቀምጧል፦ %s  (%d ካፕሽኖች፣ %s ደቂቃ ወስዷል)" % (os.path.basename(final), n, took),
            "Saved %s (%d captions, took %s) next to the video." % (os.path.basename(final), n, took))
        if state == "trial" and remaining is not None:
            say(NOTE + "ሙከራ፦ %s ነጻ ሙከራ ቀርቷል።" % remaining, "Trial: %s left." % remaining)
            if remaining == 0 and i < len(good):
                say(ERR + "ነጻ ሙከራዎቹ አልቀዋል — ለቀሪዎቹ ፋይሎች ፈቃድ ያስፈልጋል።",
                    "Free trials used up — a license is needed for the remaining files.")
                break

    print("=" * WIDTH)
    say("ተጠናቋል፦ %d/%d ፋይሎች።" % (done, len(good)), "Finished: %d of %d file(s)." % (done, len(good)))
    if last_saved:
        print()
        say("የተሰሩ ፋይሎች፦", "Your caption files:")
        for p in saved:
            print("       " + p)
        print()
        say("በኤዲተርዎ ውስጥ ለማስገባት፦", "To use them in your editor:")
        print("       CapCut          Text > Local captions > Import > choose the .srt")
        print("       DaVinci Resolve File > Import > Subtitle... > drag it onto the timeline")
        print("       Premiere Pro    File > Import > drag it onto the timeline")
        print()
        say(NOTE + "ፎልደሩ አሁን ይከፈታል።", "The folder opens now.")
        open_folder(last_saved)
    show_update_notice()
    return 0 if done == len(good) else 1


def show_update_notice():
    """One line after the work is done if a newer version exists (silent
    offline; never delays the transcription itself)."""
    newer = lic.newer_release(lic.installed_version(HERE))
    if newer:
        rule()
        say(NOTE + "አዲስ ስሪት %s ወጥቷል፦ %s" % (newer, lic.SITE_INSTALL_URL),
            "New version %s is available: %s" % (newer, lic.SITE_INSTALL_URL))


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print()
        sys.exit(130)
