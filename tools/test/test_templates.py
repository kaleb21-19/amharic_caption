"""Caption templates (1.66): the professional looks.

Every template is a look made of numbers, drawn by one code. The test checks
that each template builds a clean script, that the editor's options work on
it, that the old styles did not change - and (when a real ffmpeg with libass is
around) that the captions are really drawn where they belong.

  python tools/test/test_templates.py
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


W = [("ሰላም", 0.0, 0.4), ("እንዴት", 0.5, 0.9), ("ነህ", 1.0, 1.3), ("ዛሬ", 1.5, 1.8)]
CUES = [("ሰላም ሁሉም", 0.4, 1.3), ("እንኳን ደህና መጡ", 1.4, 2.6)]
DIALOGUE = re.compile(r"^Dialogue: \d+,[^,]+,[^,]+,[^,]+,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$")


def events(script):
    return [l for l in script.splitlines() if l.startswith("Dialogue:")]


def styles_of(script):
    return [l for l in script.splitlines() if l.startswith("Style: ")]


def style_fields(script, name="S"):
    for l in styles_of(script):
        f = l[7:].split(",")
        if f[0] == name:
            return f
    return None


def texts(script):
    out = []
    for l in events(script):
        m = DIALOGUE.match(l)
        if m:
            out.append(re.sub(r"\{[^}]*\}", "", m.group(1)))
    return out


def pos_of(script):
    """The (x, y) the caption is placed at."""
    m = re.search(r"\\pos\((\d+),(\d+)\)", script)
    return (int(m.group(1)), int(m.group(2))) if m else None


# ── every template builds a clean script ────────────────────────────────────
check(len(A.template_ids()) >= 10, "the built-in templates are there (%d)" % len(A.template_ids()))
for tid in A.template_ids():
    look = A.template(tid)
    t = A.build(W, tid, 1080, 1920)
    ev = events(t)
    ok = (t.startswith("[Script Info]") and t.count("{") == t.count("}")
          and len(ev) > 0 and style_fields(t) is not None
          and all(DIALOGUE.match(l) for l in ev)
          and all(w[0] in " ".join(texts(t)) for w in W))
    check(ok, "%s: a clean script with every word (%d events)" % (tid, len(ev)))
    check(A.template(tid) is not None and A.template("nope") is None, "%s: the look is readable" % tid)

# the old styles are untouched: they are still styles, not templates
check(all(s not in A.template_ids() for s in A.STYLES), "no template took a style's name")
check(A.build(W, "karaoke", 1080, 1920) != A.build(W, "modern", 1080, 1920), "a template is not an old style")

# ── how the spoken word is marked ───────────────────────────────────────────
t = A.build(W, "boldpop", 1080, 1920)
check(A.YELLOW not in t and "&H0000D4FF" in t, "boldpop: the spoken word is yellow")
check("\\t(" in t, "boldpop: the colour fades in, it does not jump")
t = A.build(W, "modern", 1080, 1920)
check("\\alpha&HFF&" in t, "modern: the words appear one by one")
t = A.build(W, "neonglow", 1080, 1920)
check(style_fields(t, "G") is not None and any(",G," in l for l in events(t)),
      "neonglow: a glow layer behind the words")
check(t.index(",G,") < t.index(",S,"), "neonglow: the glow is drawn behind the text")
t = A.build(W, "glass", 1080, 1920)
check(style_fields(t, "B") is not None and any(",B," in l for l in events(t)), "glass: a box behind the words")
check(t.index(",B,") < t.index(",S,"), "glass: the box is behind the text")
t = A.build(W, "gradient", 1080, 1920)
cols = set(re.findall(r"\\1c&H([0-9A-F]{8})&", t))
check(len(cols) >= 6, "gradient: every letter has its own colour (%d)" % len(cols))
t = A.build(W, "comic", 1080, 1920)
check("AMHARIC" not in t and "ዛሬ" in t, "comic: Amharic is not changed by the caps")
t = A.build([("TikTok ብዙ ነው", 0.0, 1.2)], "creator", 1080, 1920)
check("TikTok" not in t and "TIKTOK" in t, "creator: Latin words go to caps")
t = A.build(W, "arch", 1080, 1920)
check("\\frz" in t, "arch: the words are turned along the curve")
check(len(set(re.findall(r"\\frz(-?\d+\.\d+)", t))) >= 2, "arch: every word has its own turn")
t = A.build(W, "chips", 1080, 1920)
check(any(",B," in l for l in events(t)) and any(",C," in l for l in events(t)),
      "chips: every word in a box, the spoken one in another colour")

# ── the panel knows the same templates ───────────────────────────────────────
panel_js = os.path.join(REPO, "panel", "js", "main.js")
src = open(panel_js, encoding="utf-8").read()
m = re.search(r"const TEMPLATE_LIST = \[(.*?)\];", src, re.S)
panel_ids = re.findall(r"'([^']+)'", m.group(1)) if m else []
check(panel_ids == list(A.template_ids()), "the panel lists the same templates (%s)" % ",".join(panel_ids[:4]))
m = re.search(r"const TEMPLATE_NAMES = \{(.*?)\};", src, re.S)
panel_names = dict(re.findall(r"(\w+): '([^']+)'", m.group(1))) if m else {}
check(panel_names == dict((k, v["name"]) for k, v in A.TEMPLATES.items()),
      "the panel names them like the engine")
m = re.search(r"const TEMPLATE_FONTS = \{(.*?)\};", src, re.S)
panel_fonts = dict(re.findall(r"(\w+): '(\w+)'", m.group(1))) if m else {}
check(panel_fonts == dict((k, v["look"]["font"]) for k, v in A.TEMPLATES.items()),
      "every template starts on its own font")
missing = [t for t in A.template_ids() if not os.path.isfile(os.path.join(REPO, "panel", "img", "styles", t + ".jpg"))]
check(not missing, "every template has its picture for the panel button (%s)" % ",".join(missing))
i18n = open(os.path.join(REPO, "panel", "js", "i18n.js"), encoding="utf-8").read()
check("'Templates':" in i18n, "the templates group has its Amharic name")

# ── the editor's options work on a template ─────────────────────────────────
base = A.build(W, "boldpop", 1080, 1920)
check("&H0000D4FF" not in A.build(W, "boldpop", 1080, 1920, opts={"color": "#FF3B30"}),
      "the colour option paints the spoken word")
check("&H0000FF00" in A.build(W, "boldpop", 1080, 1920, opts={"text": "#00FF00"}),
      "the text option paints the words")
check(float(style_fields(A.build(W, "boldpop", 1080, 1920, opts={"size": "xl"}))[2]) >
      float(style_fields(base)[2]) * 1.4, "the size slider makes the text bigger")
check(pos_of(A.build(W, "boldpop", 1080, 1920, opts={"pos": "middle"}))[1] <
      pos_of(A.build(W, "boldpop", 1080, 1920, opts={"pos": "bottom"}))[1], "the position option moves the caption")
one = texts(A.build(W, "boldpop", 1080, 1920, opts={"words": 1}))
five = texts(A.build(W, "boldpop", 1080, 1920, opts={"words": 5}))
check(one and five and len(one[0].split()) == 1 and len(five[0].split()) == len(W),
      "the words option groups the caption (%s / %s)" % (one[:1], five[:1]))
check(style_fields(A.build(W, "boldpop", 1080, 1920, opts={"font": "serif"}))[1] == A.FONTS["serif"],
      "the font option changes the font")
check(style_fields(A.build(W, "boldpop", 1080, 1920))[1] == A.FONTS[A.template("boldpop")["font"]],
      "without a font of its own the template keeps its font")
check(all(len(l.split(",")) == 10 or l.count(",") >= 9 for l in events(A.build(W, "boldpop", 1080, 1920, opts={"anim": "slide"}))),
      "the animation option keeps the script clean")
check(len(events(A.build(W, "boldpop", 1080, 1920, opts={"lines": 2}))) == len(events(base)),
      "two lines: the same captions")
check("\\N" in A.build(W, "boldpop", 1080, 1920, opts={"lines": 2}), "two lines: the phrase breaks in two")

# ── the caption is where it belongs ─────────────────────────────────────────
for tid in A.template_ids():
    t = A.build(W, tid, 1080, 1920)
    p = pos_of(t)
    if p is None:
        check(tid in ("chips",), "%s: placed by us" % tid)
        continue
    check(0 < p[1] < 1920 and 0 < p[0] <= 540, "%s: the caption sits inside the frame %s" % (tid, p))
    p = pos_of(A.build(W, tid, 1080, 1920, opts={"pos": "top"}))
    check(p is None or p[1] < 1920 * 0.35, "%s: the top position is near the top" % tid)

# a very long word still fits
long = [("ድርባታይንጥርጥመንፈጥባይንጥርጥመን", 0.0, 2.0)]
for tid in A.template_ids():
    t = A.build(long, tid, 1080, 1920)
    check(len(events(t)) > 0, "%s: a long word still builds" % tid)

# ── real drawing (needs an ffmpeg with libass; skipped otherwise) ───────────
ff = os.environ.get("AMH_FFMPEG") or shutil.which("ffmpeg")
if ff and A.supported(ff):
    tmp = tempfile.mkdtemp()
    try:
        fonts = os.path.join(REPO, "tools", "fonts")
        vid = os.path.join(tmp, "v.mp4")
        subprocess.run([ff, "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=320x568:r=25:d=3",
                        "-pix_fmt", "yuv420p", vid], check=True)

        def frame(style, at=1.0, opts=None):
            job = {"cues": CUES, "style": style, "width": 320, "height": 568, "fps": 25, "mode": "burn",
                   "video": vid, "duration": 3, "out": os.path.join(tmp, "b.mp4"), "ffmpeg": ff, "fonts": fonts}
            if opts:
                job["opts"] = opts
            r = A.render(job)
            raw = subprocess.run([ff, "-v", "error", "-ss", str(at), "-i", r["out"], "-frames:v", "1",
                                  "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
            return raw

        for style, what in (("boldpop", "the words are drawn"), ("glass", "the box is drawn"),
                            ("neonglow", "the glow is drawn"), ("chips", "the boxes are drawn")):
            raw = frame(style)
            ink = sum(1 for i in range(0, len(raw), 3) if raw[i] + raw[i + 1] + raw[i + 2] > 40)
            check(ink > 200, "%s: %s (%d lit pixels)" % (style, what, ink))
        # the accent colour of the spoken word is really on the screen
        raw = frame("boldpop")
        ylw = sum(1 for i in range(0, len(raw), 3)
                  if abs(raw[i] - 255) < 40 and abs(raw[i + 1] - 212) < 45 and abs(raw[i + 2] - 0) < 60)
        check(ylw > 100, "boldpop: the yellow of the spoken word is on the screen (%d pixels)" % ylw)
        # the box of the glass template is really there
        raw = frame("glass")
        box = sum(1 for i in range(0, len(raw), 3)
                  if abs(raw[i] - 11) < 25 and abs(raw[i + 1] - 15) < 25 and abs(raw[i + 2] - 26) < 30)
        check(box > 300, "glass: the dark box is behind the words (%d pixels)" % box)
        # the caption is in the lower part of the frame (the "bottom" position)
        raw = frame("boldpop")
        rows = [0] * 568
        for i in range(0, len(raw), 3):
            if raw[i] + raw[i + 1] + raw[i + 2] > 40:
                rows[(i // 3) // 320] += 1
        lit = [r for r, c in enumerate(rows) if c > 0]
        check(lit and lit[0] > 568 * 0.55, "boldpop: the caption is in the lower part of the frame")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
else:
    print("  skip  the drawing checks (no ffmpeg with libass)")

print("ALL PASS" if not fails else "FAILURES: %d" % fails)
sys.exit(1 if fails else 0)
