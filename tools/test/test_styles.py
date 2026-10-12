"""Caption styles (1.11): every style builds a valid script; the smoothness
rules hold; words get times from multi-word captions; caption text cannot
inject ASS commands; and (when a real ffmpeg with libass is around) a
transparent layer and a burned-in MP4 are really drawn.

  python tools/test/test_styles.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, REPO)
import amh_styles as A  # noqa: E402

fails = 0


def check(cond, msg):
    global fails
    print(("  ok    " if cond else "  FAIL  ") + msg)
    if not cond:
        fails += 1


W = [("ሰላም", 0.0, 0.4), ("እንዴት", 0.5, 0.9), ("ነህ", 1.0, 1.3), ("ዛሬ", 1.5, 1.8), ("ደህና", 4.0, 4.4)]
TS = re.compile(r"^Dialogue: \d+,(\d+:\d\d:\d\d\.\d\d),(\d+:\d\d:\d\d\.\d\d),")


def secs(t):
    h, m, s = t.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


for st in A.STYLES:
    for (w, h) in ((1080, 1920), (1920, 1080)):
        t = A.build(W, st, w, h)
        ev = [l for l in t.splitlines() if l.startswith("Dialogue")]
        ok = bool(ev) and all(TS.match(l) and secs(TS.match(l).group(2)) > secs(TS.match(l).group(1)) for l in ev)
        ok = ok and ("PlayResX: %d" % w) in t and "Style: S," in t
        # every word appears, and the text never goes past the last word by more than the hold
        plain = re.sub(r"\{[^}]*\}", "", t)
        ok = ok and all(word in plain for word, _, _ in W)
        ok = ok and max(secs(TS.match(l).group(2)) for l in ev) <= 4.4 + 0.5
        check(ok, "%s %dx%d: valid events, every word, sane times" % (st, w, h))

# smoothness: no fade between back-to-back lines (same layer)
for st in A.STYLES:
    ev = [l for l in A.build(W, st, 1080, 1920).splitlines() if l.startswith("Dialogue")]
    bad = 0
    for l in ev:
        m = re.search(r"\\fad\((\d+),(\d+)\)", l)
        if not m:
            continue
        lay = l.split(",")[0]
        a, b = TS.match(l).group(1), TS.match(l).group(2)
        if int(m.group(2)) and any(x.split(",")[0] == lay and TS.match(x).group(1) == b for x in ev):
            bad += 1
        if int(m.group(1)) and any(x.split(",")[0] == lay and TS.match(x).group(2) == a for x in ev):
            bad += 1
    check(bad == 0, "%s: no fade between back-to-back captions" % st)

# the spoken word never changes size inside a line (that pushed the others)
for st in ("karaoke", "highlight", "bold", "podcast"):
    t = A.build(W, st, 1080, 1920)
    inline = [l for l in t.splitlines() if l.startswith("Dialogue") and re.search(r"\}[^{]+\{[^}]*\\fsc", l)]
    check(not inline, "%s: no in-line size change" % st)

# times from multi-word captions, by letters; edits keep the cue's time
ws = A.words_from_cues([("ሰላም እንዴት ነህ", 1.0, 2.2), ("ደህና", 3.0, 3.5), ("", 4, 5), ("x", 6, 6)])
check([w[0] for w in ws] == ["ሰላም", "እንዴት", "ነህ", "ደህና"], "words split from a 3-word caption; empty/zero-length dropped")
check(abs(ws[0][1] - 1.0) < 1e-9 and abs(ws[2][2] - 2.2) < 1e-9 and ws[0][2] < ws[1][1] + 1e-9, "word times cover the caption in order")

# caption text cannot inject ASS commands
t = A.build([("{\\pos(0,0)}hack\\N", 0, 1)], "clean", 1080, 1920)
check("\\pos(0,0)" not in t and "{\\pos" not in t, "caption text with { } \\ is neutralised")

# plan: the overlay covers only the captions
t0, dur, sw = A.plan([("ሰላም", 10.0, 10.5), ("ነህ", 12.0, 12.4)])
check(abs(t0 - 9.75) < 1e-9 and abs(dur - (12.4 - 9.75 + 0.6)) < 1e-9 and abs(sw[0][1] - 0.25) < 1e-9,
      "overlay starts just before the first caption and ends just after the last")

# customize options (1.12)
t0 = A.build(W, "karaoke", 1080, 1920)
check(A.build(W, "karaoke", 1080, 1920, opts={}) == t0 and A.build(W, "karaoke", 1080, 1920, opts=None) == t0,
      "no options = exactly the style as before")
t = A.build(W, "karaoke", 1080, 1920, opts={"color": "#FF3B30", "text": "#000000"})
check("&H00303BFF" in t and A.YELLOW not in t and "&H00000000," in t, "highlight and text colours applied")
sz = lambda tt: float([l for l in tt.splitlines() if l.startswith("Style:")][0].split(",")[2])
check(abs(sz(A.build(W, "bold", 1080, 1920, opts={"size": "xl"})) / sz(A.build(W, "bold", 1080, 1920)) - 1.45) < 0.02, "size XL = 1.45x")
st = lambda tt: [l for l in tt.splitlines() if l.startswith("Style:")][0].split(",")
check(st(A.build(W, "pop", 1080, 1920, opts={"pos": "top"}))[18] == "8", "top position")
check(st(A.build(W, "pop", 1080, 1920, opts={"pos": "middle"}))[18] == "5", "middle position")
check(int(st(A.build(W, "pop", 1080, 1920, opts={"pos": "safe"}))[21]) >= 0.29 * 1920, "TikTok-safe keeps clear of the bottom 30%")
check("\pos(540,960)" in A.build(W, "word", 1080, 1920, opts={"pos": "middle"}), "the one-word style moves too")
ev = lambda tt: len([l for l in tt.splitlines() if l.startswith("Dialogue")])
check(ev(A.build(W, "pop", 1080, 1920, opts={"words": 1})) == 5 and ev(A.build(W, "pop", 1080, 1920, opts={"words": 5})) == 2,
      "words per line")
check(st(A.build(W, "karaoke", 1080, 1920, opts={"box": True}))[15] == "3" and
      st(A.build(W, "neon", 1080, 1920, opts={"box": True}))[15] == "1", "box on (not for styles that are their own box/glow)")
o = A.options({"color": "red", "size": "huge", "pos": "left", "words": 9, "box": 1})
check(o == {"color": None, "text": None, "size": "m", "pos": "bottom", "words": 0, "box": True}, "bad options fall back safely")

# real drawing (needs an ffmpeg with libass; skipped otherwise)
ff = os.environ.get("AMH_FFMPEG") or shutil.which("ffmpeg")
if ff and A.supported(ff):
    tmp = tempfile.mkdtemp()
    try:
        fonts = os.path.join(REPO, "tools", "fonts")
        r = A.render({"cues": [("ሰላም እንዴት ነህ", 0.5, 2.0)], "style": "karaoke", "width": 320, "height": 568, "fps": 25,
                      "out": os.path.join(tmp, "o.mov"), "ffmpeg": ff, "fonts": fonts, "tag": True})
        info = subprocess.run([ff, "-hide_banner", "-i", r["out"]], capture_output=True, universal_newlines=True,
                              encoding="utf-8", errors="replace").stderr
        check("qtrle" in info and "argb" in info and "320x568" in info, "overlay: QuickTime Animation with alpha, the asked size")
        raw = subprocess.run([ff, "-v", "error", "-ss", "1.0", "-i", r["out"], "-frames:v", "1", "-vf", "alphaextract",
                              "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        opaque = sum(1 for b in raw if b > 200)
        clear = sum(1 for b in raw if b == 0)
        check(opaque > 200 and clear > len(raw) * 0.8, "overlay frame: the text is solid, the rest is see-through")
        vid = os.path.join(tmp, "v.mp4")
        subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=320x568:r=25:d=3", vid], check=True)
        r2 = A.render({"cues": [("ሰላም", 0.5, 2.0)], "style": "bold", "width": 320, "height": 568, "mode": "burn",
                       "video": vid, "duration": 3, "out": os.path.join(tmp, "b.mp4"), "ffmpeg": ff, "fonts": fonts})
        check(os.path.getsize(r2["out"]) > 1000, "burn: the video with the captions drawn in")
        r3 = A.render({"cues": [("ሰላም እንዴት ነህ", 0.5, 2.0)], "style": "bold", "opts": {"color": "#FF3B30", "size": "l"},
                       "width": 1080, "height": 1920, "mode": "preview", "out": os.path.join(tmp, "p"), "ffmpeg": ff, "fonts": fonts})
        check(r3["out"].endswith((".webp", ".gif")) and 200 < os.path.getsize(r3["out"]) < 400000,
              "preview: a small animated picture (%s, %d bytes)" % (os.path.basename(r3["out"]), os.path.getsize(r3["out"])))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
else:
    print("  skip  drawing tests (no ffmpeg with libass; set AMH_FFMPEG)")

print("\nALL PASS" if not fails else "\nFAILURES: %d" % fails)
sys.exit(1 if fails else 0)
