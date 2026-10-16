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
check(o == {"color": None, "text": None, "size": "m", "pos": "bottom", "words": 0, "box": True, "font": "sans", "anim": "auto", "emph": "auto"},
      "bad options fall back safely")
check(A.options({"font": "comic"})["font"] == "sans", "unknown font -> the default")
for fid, fam in A.FONTS.items():
    t = A.build(W, "bold", 1080, 1920, opts={"font": fid})
    check(all(l.split(",")[1] == fam for l in t.splitlines() if l.startswith("Style: ")), "font %s -> %s in every style line" % (fid, fam))
# entrance animations: every style x every animation is a clean script
check(A.options({"anim": "spin"})["anim"] == "auto", "unknown animation -> the style's own")
for st in A.STYLES:
    for an in A.ANIMS:
        t = A.build(W, st, 1080, 1920, opts={"anim": an})
        ev_lines = [l for l in t.splitlines() if l.startswith("Dialogue")]
        ok = not any(c in t for c in (chr(2), chr(3), chr(4))) and all(l.count("{") == l.count("}") for l in ev_lines)
        if an == "auto" and st not in A.SELF_PLACED:
            ok = ok and "\\org(" not in t
        if an in ("slide", "drop"):
            ok = ok and "\\org(" in t and "\\frz0" in t
        if an == "none":
            ok = ok and "\\t(" not in ev_lines[0].split("}")[0]
        check(ok, "%s + %s animation: clean script" % (st, an))
# modern styles (1.16): every word placed by us from the font metrics
m = A._metrics()
check(all("%s|1" % fam in m and "%s|0" % fam in m for fam in A.FONTS.values()), "letter widths shipped for every font")
check(abs(A._text_w(" ", "Noto Sans Ethiopic", 100) - 19.10) < 0.05 and A._text_w("ሰላም", "Noto Sans Ethiopic", 100) > 100,
      "widths in pixels (font units / (winAscent + winDescent))")
for pos in ("bottom", "middle", "top", "safe"):
    for (w, h) in ((1080, 1920), (1920, 1080)):
        for st in A.SELF_PLACED:
            t = A.build(W, st, w, h, opts={"pos": pos, "size": "xl", "words": 5})
            xy = [(int(a), int(b)) for a, b in re.findall(r"\\pos\((\d+),(\d+)\)", t)]
            ok = bool(xy) and all(0 < x < w and 0 < y < h for x, y in xy)
            if pos == "safe" and h > w:
                ok = ok and max(y for _, y in xy) < h * 0.72
            if pos == "top":
                ok = ok and max(y for _, y in xy) < h * 0.5
            check(ok, "%s %s %dx%d: every word inside the frame" % (st, pos, w, h))
long = [("ኢትዮጵያውያንንናንንናንንንን", 0.0, 1.0)]
t = A.build(long, "glide", 1080, 1920, opts={"size": "xl"})
size = float([l for l in t.splitlines() if l.startswith("Style: S,")][0].split(",")[2])
check(A._text_w(long[0][0], "Noto Sans Ethiopic", size) <= 1080 * 0.86 + 1, "a very long word still fits: the text gets smaller")
t = A.build(W, "glide", 1080, 1920, opts={"color": "#FF3B30"})
check("&H00303BFF" in t and A.VIOLET not in t, "the colour option paints the glide pill")
t = A.build(W, "spotlight", 1080, 1920, opts={"color": "#FF3B30"})
check("&H00303BFF" in t and A.SPOT not in t, "the colour option tints the spoken word in spotlight")
# ★ emphasis (1.16.16): *marked* words and (auto) numbers / money pop
EW = A.words_from_cues([("ዋጋው *5,000 ብር* ነው *ልዩ* ዋጋ 20% ብቻ", 0, 6)])
marked = lambda mode: [w[0].startswith(A.EM) for w in A._mark_emphasis(EW, mode)]
check(marked("auto") == [False, True, True, False, True, False, True, False], "auto: *marked* words + numbers/percent")
check(marked("off") == [False, True, True, False, True, False, False, False], "off: only the *marked* words")
check(not any(A.EM in w[0] or "*" in w[0] for w in [(x[0].lstrip(A.EM),) for x in A._mark_emphasis(EW, "auto")]),
      "the * marks never reach the screen")
check(A.options({})["emph"] == "auto" and A.options({"emph": "off"})["emph"] == "off" and A.options({"emph": "x"})["emph"] == "auto",
      "emphasis option: auto by default")
for st in A.STYLES:
    t = A.build(EW, st, 1080, 1920)
    ok = t.count("\\fscx%d\\fscy%d" % (A.EMPH_SCALE, A.EMPH_SCALE)) >= 4 and A.EM not in t and "*" not in t
    check(ok, "%s: emphasized words drawn bigger in the accent colour" % st)
unm = A.words_from_cues([("ዋጋው 5000 ብር ነው", 0, 2)])
t0 = A.build(unm, "bold", 1080, 1920, opts={"emph": "off"})
check("fscx115" not in t0, "nothing marked + off: the style exactly as before")
pl = A._place([A.EM + "ሰላም", "ሰላም"], "Noto Sans Ethiopic", 100, 1080, 1920, A.options({}), 0.24)
check(abs(pl[0][2] / pl[1][2] - A.EMPH_SCALE / 100.0) < 0.01, "self-placed styles make room for a bigger word")

FONT_FILES = {"sans": "NotoSansEthiopic", "menbere": "Menbere", "serif": "NotoSerifEthiopic", "abyssinica": "AbyssinicaSIL"}
shipped = os.listdir(os.path.join(REPO, "tools", "fonts"))
check(set(FONT_FILES) == set(A.FONTS) and all(FONT_FILES[f] + "-Regular.ttf" in shipped for f in A.FONTS),
      "every font is shipped in tools/fonts")
check(all(n in shipped for n in ("OFL.txt", "OFL-Menbere.txt", "OFL-NotoSerifEthiopic.txt", "OFL-AbyssinicaSIL.txt")),
      "every font's license is shipped")

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
        if sys.platform == "darwin":
            # Premiere on Apple Silicon showed qtrle as smeared streaks (customer, 1.16.7)
            check("prores" in info and "4444" in info and "yuva" in info and "320x568" in info,
                  "overlay on Mac: ProRes 4444 with alpha, the asked size")
        else:
            check("qtrle" in info and "argb" in info and "320x568" in info, "overlay: QuickTime Animation with alpha, the asked size")
        # ProRes 4444 (the Mac format) keeps the same transparency, on every OS
        rp = A.render({"cues": [("ሰላም እንዴት ነህ", 0.5, 2.0)], "style": "karaoke", "width": 320, "height": 568, "fps": 25,
                       "out": os.path.join(tmp, "p.mov"), "ffmpeg": ff, "fonts": fonts, "codec": "prores"})
        pinfo = subprocess.run([ff, "-hide_banner", "-i", rp["out"]], capture_output=True, universal_newlines=True,
                               encoding="utf-8", errors="replace").stderr
        praw = subprocess.run([ff, "-v", "error", "-ss", "1.0", "-i", rp["out"], "-frames:v", "1", "-vf", "alphaextract",
                               "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        if "prores" in pinfo:
            check(sum(1 for b in praw if b > 200) > 200 and sum(1 for b in praw if b == 0) > len(praw) * 0.8,
                  "ProRes 4444 overlay: the text is solid, the rest is see-through")
        else:
            print("  skip  ProRes check (this ffmpeg has no prores_ks)")
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
        # the preview is only the strip where the captions are (wide and short)
        head = open(r3["out"], "rb").read(30)
        if r3["out"].endswith(".gif"):
            pw_, ph_ = int.from_bytes(head[6:8], "little"), int.from_bytes(head[8:10], "little")
        else:
            pw_, ph_ = 1 + int.from_bytes(head[24:27], "little"), 1 + int.from_bytes(head[27:30], "little")
        check(pw_ == A.PREVIEW_PX and ph_ <= pw_ * 0.4, "preview: the caption strip only, %dx%d" % (pw_, ph_))
        # 1.16.14: the editor's own footage plays behind the captions; an
        # audio-only file (the voice clip) falls back to the plain background
        foot = os.path.join(tmp, "foot.mp4")
        subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x568:r=25:d=8", "-pix_fmt", "yuv420p", foot], check=True)
        voice = os.path.join(tmp, "voice.wav")
        subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i", "sine=d=8", voice], check=True)
        save = A._has_encoder
        A._has_encoder = lambda f, n: False if n == "libwebp_anim" else save(f, n)   # GIF: ffmpeg can read it back
        try:
            def colours(job):
                rr = A.render(dict({"cues": [("ሰላም እንዴት ነህ", 4.5, 6.0)], "style": "bold", "width": 320, "height": 568,
                                    "mode": "preview", "ffmpeg": ff, "fonts": fonts}, **job))
                fr = subprocess.run([ff, "-v", "error", "-i", rr["out"], "-vf", "select=eq(n\\,8)", "-frames:v", "1",
                                     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
                # colourfulness: mean |R-G| + |G-B| (test pattern: bright bars; plain: grey-blue)
                px = [(fr[i], fr[i + 1], fr[i + 2]) for i in range(0, len(fr) - 2, 3 * 5)]
                return sum(abs(r - g) + abs(g - b) for r, g, b in px) / float(max(1, len(px)))
            on_foot = colours({"out": os.path.join(tmp, "pv1"), "video": foot, "videoOffset": -2.0})
            on_voice = colours({"out": os.path.join(tmp, "pv2"), "video": voice})
            plain = colours({"out": os.path.join(tmp, "pv3")})
            check(on_foot > plain * 3 and on_foot > 60, "preview over the editor's footage (colour %.0f vs %.0f plain)" % (on_foot, plain))
            check(on_voice > 0 and abs(on_voice - plain) < 10,
                  "preview from an audio-only file: the plain background, no error (%.0f vs %.0f)" % (on_voice, plain))
        finally:
            A._has_encoder = save
        # entrances: the text moves the right way with no jump (fast words, so
        # the word-by-word redraws start while the entrance still runs) and
        # ends exactly where the style puts it
        fast = [("ሰላም", 0.30, 0.42), ("እንዴት", 0.42, 0.54), ("ናችሁ", 0.54, 0.66), ("ዛሬ", 0.66, 1.4)]

        def tops(an):
            r5 = A.render({"cues": fast, "style": "karaoke", "opts": {"anim": an, "words": 4}, "width": 360, "height": 640,
                           "fps": 50, "out": os.path.join(tmp, "a_" + an + ".mov"), "ffmpeg": ff, "fonts": fonts})
            raw = subprocess.run([ff, "-v", "error", "-i", r5["out"], "-vf", "alphaextract", "-f", "rawvideo",
                                  "-pix_fmt", "gray", "-"], capture_output=True).stdout
            n, out = 360 * 640, []
            frames = [raw[k * n:(k + 1) * n] for k in range(len(raw) // n)]
            ink = [sum(1 for b in f if b > 128) for f in frames]
            for f, c in zip(frames, ink):
                # only frames where the fade-in is done (a half-faded first
                # frame shows just parts of the letters)
                if c > 0.8 * max(ink):
                    # the ink-weighted centre (sub-pixel; the top edge flickers
                    # by a pixel with anti-aliasing)
                    rows = [sum(f[y * 360:(y + 1) * 360]) for y in range(640)]
                    out.append(round(sum(y * v for y, v in enumerate(rows)) / float(sum(rows)), 2))
            return out
        base, up, down = tops("auto"), tops("slide"), tops("drop")
        check(up and down and abs(up[-1] - base[-1]) < 0.05 and abs(down[-1] - base[-1]) < 0.05, "slide up / down end where the style puts the text")
        check(all(b <= a + 0.1 for a, b in zip(up, up[1:])) and up[0] - up[-1] >= 4, "slide up only rises, no jump (%s)" % up[:12])
        check(all(b >= a - 0.1 for a, b in zip(down, down[1:])) and down[-1] - down[0] >= 4, "slide down only falls, no jump (%s)" % down[:12])
        # modern styles: words placed by us land exactly where libass would
        # put them in one line (same letters, same pixels)
        def alpha(script, w_, h_, at="0.5"):
            d = tempfile.mkdtemp()
            shutil.copytree(fonts, os.path.join(d, "fonts"))
            with open(os.path.join(d, "c.ass"), "w", encoding="utf-8") as fh:
                fh.write(script + "\n")
            raw = subprocess.run([ff, "-v", "error", "-f", "lavfi", "-i", "color=c=black@0:s=%dx%d:d=2:r=50,format=rgba" % (w_, h_),
                                  "-vf", "subtitles=c.ass:fontsdir=fonts:alpha=1,alphaextract", "-ss", at, "-frames:v", "1",
                                  "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, cwd=d).stdout
            shutil.rmtree(d, ignore_errors=True)
            return raw
        phrase = ["ሰላም", "እንዴት", "ናችሁ"]
        for fam in A.FONTS.values():
            sty = "Style: S,%s,90,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,5,0,0,0,1" % fam
            one = A._header(800, 300, sty) + "Dialogue: 0,0:00:00.00,0:00:01.00,S,,0,0,0,,{\\pos(400,150)}" + " ".join(phrase)
            wsz = [A._text_w(x, fam, 90) for x in phrase]
            spw = A._text_w(" ", fam, 90)
            x = 400 - (sum(wsz) + spw * 2) / 2
            parts = A._header(800, 300, sty)
            for word, tw in zip(phrase, wsz):
                parts += "Dialogue: 0,0:00:00.00,0:00:01.00,S,,0,0,0,,{\\pos(%.2f,150)}%s\n" % (x + tw / 2, word)
                x += tw + spw
            a, b = alpha(one, 800, 300), alpha(parts, 800, 300)
            ca = [sum(a[y * 800 + c] for y in range(300)) for c in range(800)]
            cb = [sum(b[y * 800 + c] for y in range(300)) for c in range(800)]
            diff = sum(abs(u - v) for u, v in zip(ca, cb)) / float(sum(ca))
            check(diff < 0.03, "%s: words placed by us match libass's own line (%.2f%% apart)" % (fam, diff * 100))

        # glide: even room around the word inside the pill, and the pill glides
        # (eased, straight, no jump) and lands exactly on the next word
        ww = [("ሰላም", 0.0, 0.5), ("እንዴት", 0.5, 1.0), ("ናችሁ", 1.0, 1.6)]
        g = A.build(ww, "glide", 540, 960)

        def layer(script, n, keep=None):
            return "\n".join(l for l in script.splitlines() if not l.startswith("Dialogue") or
                             (l.startswith("Dialogue: %d," % n) and (keep is None or keep in l)))

        def bbox(raw, w_, h_):
            ys = [y for y in range(h_) if max(raw[y * w_:(y + 1) * w_]) > 128]
            xs = [x for x in range(w_) if any(raw[y * w_ + x] > 128 for y in range(ys[0], ys[-1] + 1))]
            return xs[0], ys[0], xs[-1], ys[-1]
        nob = layer(g, 2, "እንዴት").replace("\\fad(120,90)}", "\\bord0\\shad0}")
        tb = bbox(alpha(nob, 540, 960, "0.8"), 540, 960)
        pb = bbox(alpha(layer(g, 1), 540, 960, "0.8"), 540, 960)
        pads = (tb[1] - pb[1], pb[3] - tb[3], tb[0] - pb[0], pb[2] - tb[2])
        check(min(pads) >= 8 and abs(pads[0] - pads[1]) <= 4 and abs(pads[2] - pads[3]) <= 3,
              "glide: the word sits in the middle of its pill (top, bottom, left, right: %s)" % (pads,))
        lefts = []
        for k in range(24, 40):
            raw = alpha(layer(g, 1), 540, 960, "%.2f" % (k / 50.0))
            lefts.append(bbox(raw, 540, 960)[0])
        steps = [b - a for a, b in zip(lefts, lefts[1:])]
        check(all(s_ >= 0 for s_ in steps) and max(steps) <= 0.35 * (lefts[-1] - lefts[0]) and lefts[-1] == pb[0],
              "glide: the pill slides to the next word smoothly and stops exactly on it (%s)" % lefts)
        # each font really draws (libass falls back to one font when a name is
        # not found, and then every frame would be the same)
        frames = {}
        for fid in A.FONTS:
            r4 = A.render({"cues": [("ሰላም እንዴት ነህ", 0.2, 2.0)], "style": "bold", "opts": {"font": fid}, "width": 480,
                           "height": 270, "fps": 25, "out": os.path.join(tmp, "f_" + fid + ".mov"), "ffmpeg": ff, "fonts": fonts})
            frames[fid] = subprocess.run([ff, "-v", "error", "-ss", "1.0", "-i", r4["out"], "-frames:v", "1", "-vf", "alphaextract",
                                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        check(all(sum(1 for b in v if b > 200) > 100 for v in frames.values()) and len(set(frames.values())) == len(frames),
              "every font draws, and each one looks different")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
else:
    print("  skip  drawing tests (no ffmpeg with libass; set AMH_FFMPEG)")

print("\nALL PASS" if not fails else "\nFAILURES: %d" % fails)
sys.exit(1 if fails else 0)
