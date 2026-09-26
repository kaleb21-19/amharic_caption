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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import amh_license as lic  # noqa: E402

MEDIA_EXT = {".mp4", ".mov", ".mkv", ".avi", ".wmv", ".m4v", ".webm", ".mts", ".mxf",
             ".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma"}
# Same clean-up chain as the panel's extractAudio() (AUDIO_CLEAN_FILTER).
AUDIO_CLEAN_FILTER = "highpass=f=80,lowpass=f=7500,afftdn=nf=-25"
BUY_URL = "https://t.me/AmharicCaptionsBot"


def say(am, en=None):
    """One message, Amharic first, English under it."""
    print(am)
    if en:
        print("   " + en)
    sys.stdout.flush()


def rule():
    print("-" * 60)


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
        say("✓ ፈቃድ አለው።", "Licensed." + ("" if info == "00000000" else " (expires %s)" % info))
        return "licensed"

    status = lic.trial_status(mid)
    if status is None:
        rule()
        say("ኢንተርኔት ያስፈልጋል፦ ያለ ፈቃድ ለነጻ ሙከራ ከሰርቨሩ ጋር መገናኘት አለብን።",
            "Internet needed: free trials are checked with the server when there is no license.")
        return offer_activation(mid)
    remaining = int(status.get("remaining", 0))
    if remaining > 0:
        say("ሙከራ፦ %d ነጻ ሙከራ ቀርቷል።" % remaining,
            "Trial: %d free transcription(s) left." % remaining)
        if n_files > remaining:
            say("ማሳሰቢያ፦ %d ፋይሎች ሰጥተዋል፣ ግን %d ነጻ ሙከራ ብቻ ቀርቷል።" % (n_files, remaining),
                "Note: you gave %d files but only %d free transcription(s) remain." % (n_files, remaining))
        return "trial"
    rule()
    say("ነጻ ሙከራዎቹ አልቀዋል።", "Your free trials are used up.")
    return offer_activation(mid)


def offer_activation(mid):
    rule()
    say("የማሽን መለያዎ (Machine ID)፦  " + mid)
    say("ፈቃድ ለመግዛት፦ 2,500 ብር ለ KALEB TEGEGEN በባንክ ያስተላልፉ፣ ከዚያ የማሽን መለያውን እና ስክሪንሾቱን ለቦቱ ይላኩ፦",
        "To buy: pay ETB 2,500 by bank transfer to KALEB TEGEGEN, then send the Machine ID")
    say("   " + BUY_URL, "and the payment screenshot to the bot above.")
    rule()
    say("ቁልፍ ካለዎት እዚህ ይለጥፉ እና Enter ይጫኑ (ለመውጣት ባዶ ይተዉ)፦",
        "If you have a key, paste it here and press Enter (leave empty to quit):")
    try:
        key = input("> ").strip()
    except EOFError:
        return None
    if not key:
        return None
    ok, msg = lic.activate(mid, key)
    if ok:
        say("✓ ፈቃዱ ገቢር ሆኗል። በPremiere/After Effects ፓነልም ይሰራል።",
            "✓ License activated. It also unlocks the Premiere/After Effects panel.")
        return "licensed"
    say("✗ " + msg)
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
        say("✗ ሞዴሉን ማውረድ አልተቻለም። ኢንተርኔትዎን ፈትሸው እንደገና ይሞክሩ — ካቆመበት ይቀጥላል።",
            "Could not download the model (%s). Check your internet and run again; it resumes." % e)
        return False
    print()
    say("✓ ሞዴሉ ወርዷል።", "Model downloaded and verified.")
    return True


def transcribe(engine, src, out_srt, mode, speakers):
    import ethio_srt as es
    with tempfile.TemporaryDirectory(prefix="amh_srt_") as tmp:
        wav = os.path.join(tmp, "audio.wav")
        say("   ድምፁን በማውጣት ላይ…", "Extracting audio…")
        extract_audio(src, wav)
        audio = es.read_wav(wav)
        mins = len(audio) / 16000 / 60
        say("   ወደ ጽሑፍ በመቀየር ላይ (%.1f ደቂቃ)… እባክዎ ይጠብቁ።" % mins,
            "Transcribing (%.1f min of audio)… please wait." % mins)
        group = 3 if mode == "words" else 0
        _text, cues = es._run_file(engine, audio, mode, group, 42, 0.0, out_srt, speakers=speakers)
        return es.write_srt(out_srt, cues, 0.0)


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

    print()
    say("አማርኛ ካፕሽን — SRT ሰሪ", "Amharic Captions — SRT maker")
    rule()
    if not files:
        files = ask_files()
    files = [os.path.abspath(f) for f in files]
    good = [f for f in files if os.path.isfile(f) and os.path.splitext(f)[1].lower() in MEDIA_EXT]
    for f in files:
        if f not in good:
            say("✗ የሚደገፍ ፋይል አይደለም፦ " + f, "Not a supported video/audio file.")
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
    engine = es.load_pipeline()

    done = 0
    for i, src in enumerate(good, 1):
        rule()
        say("[%d/%d] %s" % (i, len(good), os.path.basename(src)))
        final = output_path(src)
        # Trial output goes to a temp file first: nothing is delivered until
        # the server has actually charged the free transcription.
        work = final if state == "licensed" else final + ".pending"
        try:
            n = transcribe(engine, src, work, mode, speakers)
        except Exception as e:
            say("✗ ይህን ፋይል ወደ ጽሑፍ መቀየር አልተቻለም።", "Could not transcribe this file: %s" % e)
            for p in (work, work + ".part.json"):
                if work != final and os.path.exists(p):
                    os.remove(p)
            continue
        remaining = None
        if state == "trial":
            charged, remaining = lic.trial_charge(mid, lic.new_run_id())
            if not charged:
                for p in (work, work + ".part.json"):
                    if os.path.exists(p):
                        os.remove(p)
                say("✗ ነጻ ሙከራውን ማረጋገጥ አልተቻለም (ኢንተርኔት የለም ወይም ሙከራዎቹ አልቀዋል)።",
                    "Could not confirm the free trial with the server (offline, or trials used up).")
                break
            os.replace(work, final)
            try:
                os.remove(work + ".part.json")
            except OSError:
                pass
        done += 1
        say("✓ %d ካፕሽኖች ተቀምጠዋል፦ %s" % (n, final), "Saved %d captions." % n)
        if state == "trial" and remaining is not None:
            say("   ሙከራ፦ %s ነጻ ሙከራ ቀርቷል።" % remaining, "Trial: %s left." % remaining)
            if remaining == 0 and i < len(good):
                say("ነጻ ሙከራዎቹ አልቀዋል — ለቀሪዎቹ ፋይሎች ፈቃድ ያስፈልጋል።",
                    "Free trials used up — a license is needed for the remaining files.")
                break

    rule()
    say("ተጠናቋል፦ %d/%d ፋይሎች።" % (done, len(good)), "Finished: %d of %d file(s)." % (done, len(good)))
    say("የ.srt ፋይሉን በCapCut፣ DaVinci Resolve ወይም በሌላ ኤዲተር ያስገቡ።",
        "Import the .srt into CapCut, DaVinci Resolve or any editor.")
    show_update_notice()
    return 0 if done == len(good) else 1


def show_update_notice():
    """One line after the work is done if a newer version exists (silent
    offline; never delays the transcription itself)."""
    newer = lic.newer_release(lic.installed_version(HERE))
    if newer:
        rule()
        say("🔔 አዲስ ስሪት %s ወጥቷል፦ %s" % (newer, lic.SITE_INSTALL_URL),
            "New version %s is available: %s" % (newer, lic.SITE_INSTALL_URL))


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print()
        sys.exit(130)
