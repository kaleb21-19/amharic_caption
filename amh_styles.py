#!/usr/bin/env python3
"""Animated caption styles (1.11): words with times -> an ASS script that the
bundled ffmpeg (libass) draws on a transparent layer (QuickTime Animation,
for Premiere / After Effects / DaVinci) or onto the video (burned-in MP4).

Smoothness rules, learned from the first prototype (the owner found it jumpy):
  * a phrase stays on screen until the next one starts when the pause is
    short (no blank flash between phrases);
  * the spoken word never changes size inside a line (that pushed the other
    words sideways every time the highlight moved) - only its colour fades;
  * animations last 150-300 ms with easing, never 3 frames.

The modern styles (glide, spotlight, bounce) place every word themselves
(fonts/metrics.json has each letter's width exactly as libass draws it), so
a highlight can glide from word to word and a word can grow without pushing
the others.

Styles:
  glide    a rounded colour pill glides smoothly behind the spoken word
  spotlight the phrase is dimmed; the spoken word lights up and grows a little
  bounce   words spring up one by one as they are spoken
  karaoke  3 words, the spoken word turns yellow (soft colour fade)
  fill     3 words, a smooth left-to-right colour sweep as they are spoken
  pop      1-2 big words that grow in with an ease-out, white / yellow
  clean    a subtitle on a soft dark box, gentle fade
  highlight 3 words, the spoken word on a yellow box (black letters)
  reveal   3 words appear one by one as they are spoken (the line never moves)
  word     one big word at a time in the middle, with a small bounce
  neon     glowing cyan text, soft light around it
  habesha  2 words, green / yellow / red (Ethiopian colours), dark outline
  bold     heavy black outline + solid 3D shadow, the spoken word bright green
  podcast  2 tidy lines for long interviews, the spoken word highlighted
  typewriter letters appear one by one as the phrase is spoken
  impact   words punch in with a small rotation that settles
  retro    white text with a long solid shadow (poster look)
  cinema   elegant: smaller, spaced letters, soft shadow, slow fade

Pure stdlib. Usage (tests / tools):
  python amh_styles.py words.json style out.ass WIDTH HEIGHT
"""
import json
import os
import math
import re
import sys

STYLES = ("glide", "spotlight", "bounce", "karaoke", "fill", "highlight", "bold", "podcast", "reveal", "typewriter", "pop", "word", "impact",
          "neon", "retro", "habesha", "cinema", "clean")
YELLOW = "&H0000E5FF"
BLACK = "&H00000000"
GREEN = "&H0071CC2E"
RED = "&H004A44F0"
CYAN = "&H00FFF04D"
LIME = "&H0014FF39"
WHITE = "&H00FFFFFF"
VIOLET = "&H00ED3A7C"   # glide's pill (#7C3AED)
SPOT = "&H00FFFFFE"     # spotlight's spoken word (white; the colour option tints it)
GAP_HOLD = 0.6     # a pause shorter than this keeps the phrase on screen
MIN_SHOW = 0.45    # a phrase shows at least this long
FONT = "Noto Sans Ethiopic"
# Amharic fonts shipped in runtime/fonts (all SIL Open Font License):
# id -> family name inside the font files.
FONTS = {
    "sans": "Noto Sans Ethiopic",     # clean, modern (default)
    "menbere": "Menbere",             # rounded, friendly
    "serif": "Noto Serif Ethiopic",   # classic, for documentaries / news
    "abyssinica": "Abyssinica SIL",   # traditional book letters
    # 1.28.0 (owner's pick for TikTok / Reels): Senamirmir fonts are shipped
    # UNMODIFIED (Reserved Font Names), like Abyssinica
    "yebse": "Ethiopic Yebse",        # heavy, blocky
    "washra": "Ethiopic WashRa Bold", # bold, clean
    "agbalumo": "Agbalumo",           # playful, rounded
    "tint": "Ethiopic Tint",          # brush
    "fantuwua": "Ethiopic Fantuwua",  # handwritten
    "jiret": "Ethiopia Jiret",        # book
    "hibur": "Hibur Mono",            # typewriter (TypeHabesha)
    "gothic": "Ethiopic Yigezu Bisrat Gothic",  # ornate
}

# "Install Amharic fonts on this PC" (1.28.0): the shipped files and the
# names Windows lists them under, so Premiere's own titles, CapCut and
# DaVinci can use them too
FONT_INSTALL = [
    ("NotoSansEthiopic-Regular.ttf", "Noto Sans Ethiopic Regular"), ("NotoSansEthiopic-Bold.ttf", "Noto Sans Ethiopic Bold"),
    ("NotoSerifEthiopic-Regular.ttf", "Noto Serif Ethiopic Regular"), ("NotoSerifEthiopic-Bold.ttf", "Noto Serif Ethiopic Bold"),
    ("Menbere-Regular.ttf", "Menbere Regular"), ("Menbere-Bold.ttf", "Menbere Bold"),
    ("AbyssinicaSIL-Regular.ttf", "Abyssinica SIL Regular"),
    ("yebse.ttf", "Ethiopic Yebse"), ("washrab.ttf", "Ethiopic WashRa Bold"), ("Agbalumo-Regular.ttf", "Agbalumo Regular"),
    ("tint.ttf", "Ethiopic Tint"), ("fantuwua.ttf", "Ethiopic Fantuwua"), ("jiret.ttf", "Ethiopia Jiret"),
    ("HiburMono-Regular.ttf", "Hibur Mono Regular"), ("yigezubisratgothic.ttf", "Ethiopic Yigezu Bisrat Gothic"),
]


def install_fonts(src):
    """Copy the shipped fonts into THIS user's font folder (no administrator):
    Windows %LOCALAPPDATA%\\Microsoft\\Windows\\Fonts + the per-user font list in
    the registry (and loaded right away for running apps), Mac ~/Library/Fonts,
    Linux ~/.local/share/fonts. A font already there with the same size is
    left alone. Tests: AMH_FONT_INSTALL_DIR / AMH_FONT_REG_KEY redirect both.
    -> {"installed": [...], "already": [...], "failed": [...], "dir": ...}"""
    import shutil
    test_dir = os.environ.get("AMH_FONT_INSTALL_DIR")
    if test_dir:
        dest = test_dir
    elif sys.platform == "win32":
        dest = os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "Microsoft", "Windows", "Fonts")
    elif sys.platform == "darwin":
        dest = os.path.expanduser("~/Library/Fonts")
    else:
        dest = os.path.expanduser("~/.local/share/fonts")
    os.makedirs(dest, exist_ok=True)
    res = {"installed": [], "already": [], "failed": [], "dir": dest}
    reg = None
    if sys.platform == "win32":
        try:
            import winreg
            key = os.environ.get("AMH_FONT_REG_KEY") or r"Software\Microsoft\Windows NT\CurrentVersion\Fonts"
            reg = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE)
        except Exception:
            reg = None
    for fname, name in FONT_INSTALL:
        s = os.path.join(src, fname)
        if not os.path.isfile(s):
            continue
        d = os.path.join(dest, fname)
        try:
            if os.path.isfile(d) and os.path.getsize(d) == os.path.getsize(s):
                res["already"].append(name)
            else:
                shutil.copyfile(s, d)
                res["installed"].append(name)
            if reg is not None:
                import winreg
                winreg.SetValueEx(reg, name + " (TrueType)", 0, winreg.REG_SZ, d)
                if not test_dir:
                    # running apps see it now (Premiere may still need a restart)
                    import ctypes
                    ctypes.windll.gdi32.AddFontResourceW(d)
        except Exception as e:
            res["failed"].append("%s: %s" % (name, e))
    if reg is not None:
        try:
            import winreg
            winreg.CloseKey(reg)
            if not test_dir:
                import ctypes
                ctypes.windll.user32.SendMessageTimeoutW(0xFFFF, 0x001D, 0, 0, 0x0002, 1000, None)   # WM_FONTCHANGE
        except Exception:
            pass
    return res


def _ts(t):
    t = max(0.0, float(t))
    cs = int(round(t * 100))
    return "%d:%02d:%02d.%02d" % (cs // 360000, cs // 6000 % 60, cs // 100 % 60, cs % 100)


def _secs(ts):
    h, m, s = ts.split(":")
    return int(h) * 3600 + int(m) * 60 + float(s)


def _clean(text):
    # ASS control characters must not come from the captions.
    return str(text).replace("\\", "").replace("{", "(").replace("}", ")").replace("\n", " ").strip()


def words_from_cues(cues):
    """[(text, start, end)] per word. A cue with several words (grouped
    captions, or text edited in the review) shares its time by letters."""
    out = []
    for c in cues:
        text, s, e = c[0], float(c[1]), float(c[2])
        parts = [p for p in _clean(text).split() if p]
        if not parts or e <= s:
            continue
        total = sum(len(p) for p in parts)
        t = s
        for i, p in enumerate(parts):
            end = e if i == len(parts) - 1 else t + (e - s) * len(p) / total
            out.append((p, t, end))
            t = end
    return out


def _phrases(words, size, o=None):
    """Groups of up to `size` words; a long pause starts a new group. Two
    lines (o["lines"] == 2, 1.50) hold about twice the words."""
    if o and o.get("lines") == 2 and size >= 2:
        size = min(10, size * 2)
    out, cur = [], []
    for w in words:
        if cur and (len(cur) >= size or w[1] - cur[-1][2] > GAP_HOLD):
            out.append(cur)
            cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


# every phrase's (start, end) of the last build(), when render() asks for it:
# one Premiere clip per phrase (1.27.0), so each caption can be moved,
# trimmed or deleted on its own and redrawn alone after an edit
_SPAN_LOG = None


def _spans(groups):
    """(start, end) per group: held until the next group when the pause is
    short, and at least MIN_SHOW long (never overlapping the next one)."""
    spans = []
    for i, g in enumerate(groups):
        s, e = g[0][1], max(g[-1][2], g[0][1] + MIN_SHOW)
        if i + 1 < len(groups):
            nxt = groups[i + 1][0][1]
            if nxt - g[-1][2] <= GAP_HOLD:
                e = nxt
            e = min(e, nxt)
        spans.append((s, max(e, s + 0.05)))
    if _SPAN_LOG is not None:
        _SPAN_LOG.extend(spans)
    return spans


def _header(width, height, style_line):
    return ("[Script Info]\nScriptType: v4.00+\nPlayResX: %d\nPlayResY: %d\nWrapStyle: 2\n"
            "ScaledBorderAndShadow: yes\n\n[V4+ Styles]\n"
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
            "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding\n%s\n\n[Events]\n"
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n") % (width, height, style_line)


SIZES = {"s": 0.8, "m": 1.0, "l": 1.2, "xl": 1.45}
POSITIONS = ("bottom", "middle", "top", "safe")
NO_BOX = ("highlight", "neon", "retro", "clean", "glide", "spotlight", "bounce")
SELF_PLACED = ("glide", "spotlight", "bounce")
# Entrance animations (Customize): "auto" = the style's own.
ANIMS = ("auto", "none", "fade", "slide", "drop", "pop", "zoom", "blur",
         # 1.40 animation pack (our own, in the spirit of TikTok editors' favourites)
         "typewriter", "wave", "slidecolor", "shake", "glow", "blurzoom",
         # 1.73 motion pack (our own takes on the moves editors love)
         "bounce", "flicker", "snap", "rampup", "fadeup")
# letter by letter: drawn by _letters() after the ★ words are coloured
LETTER_ANIMS = ("typewriter", "wave")


def _ass_color(hexrgb, default):
    """'#RRGGBB' -> ASS '&H00BBGGRR' (default when missing or not a colour)."""
    m = re.match(r"^#?([0-9a-fA-F]{6})$", str(hexrgb or ""))
    if not m:
        return default
    v = m.group(1).upper()
    return "&H00%s%s%s" % (v[4:6], v[2:4], v[0:2])


SIZE_RANGE = (0.6, 1.8)
Y_RANGE = (0.10, 0.97)


def _num(v, lo, hi):
    """A number inside lo..hi, else None (bools and text are not numbers)."""
    if isinstance(v, bool):
        return None
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return min(hi, max(lo, v)) if v == v else None


def options(opts):
    """Clean customize options: colour (the highlight), text, size s/m/l/xl
    or a number 0.6-1.8 (the Size slider, 1.32), pos bottom/middle/top/safe,
    y = where the caption's bottom edge sits (0-1 of the frame height from
    the top; dragged in the Studio player, 1.32 - wins over pos), words 1-5
    (0 = the style's own), box, font (an id of FONTS), anim (of ANIMS),
    lines 1 / 2 (1.50: two balanced lines per caption)."""
    o = opts or {}
    words = o.get("words")
    try:
        words = int(words)
    except (TypeError, ValueError):
        words = 0
    k = SIZES.get(o.get("size")) if isinstance(o.get("size"), str) else _num(o.get("size"), *SIZE_RANGE)
    return {
        "color": _ass_color(o.get("color"), None),
        "text": _ass_color(o.get("text"), None),
        "size": o.get("size") if o.get("size") in SIZES else "m",
        "k": k if k else 1.0,
        "y": _num(o.get("y"), *Y_RANGE),
        "pos": o.get("pos") if o.get("pos") in POSITIONS else "bottom",
        "words": words if 1 <= words <= 5 else 0,
        "box": bool(o.get("box")),
        "font": o.get("font") if o.get("font") in FONTS else "sans",
        "anim": o.get("anim") if o.get("anim") in ANIMS else "auto",
        "emph": "off" if o.get("emph") == "off" else "auto",
        "lines": 2 if str(o.get("lines")) == "2" else 1,
    }


def _apply_layout(script, style, width, height, o):
    """Position and box on the finished script (style lines + \\pos tags).
    A dragged height (o["y"]) puts the caption's bottom edge exactly there:
    bottom-aligned style lines, \\pos lines anchored at their bottom."""
    h = float(height)
    portrait = height > width
    pos = o["pos"]
    y = o.get("y")
    out = []
    for line in script.split("\n"):
        if line.startswith("Style: "):
            f = line[7:].split(",")
            # f: 0 Name,1 Font,2 Size,3 Prim,4 Sec,5 Outline,6 Back,7 Bold,8 It,9 Und,10 Strike,
            #    11 ScX,12 ScY,13 Spacing,14 Angle,15 BorderStyle,16 Outline,17 Shadow,18 Align,
            #    19 ML,20 MR,21 MV,22 Enc
            if y is not None:
                f[18], f[21] = "2", str(round(h * (1 - y)))
            elif pos == "middle":
                f[18], f[21] = "5", "0"
            elif pos == "top":
                f[18], f[21] = "8", str(round(h * 0.08))
            elif pos == "safe":
                f[18], f[21] = "2", str(round(h * (0.30 if portrait else 0.16)))
            if o["box"] and style not in NO_BOX and style not in TEMPLATES:
                size = float(f[2])
                f[15], f[5], f[16], f[17] = "3", "&H40000000", "%.1f" % (size * 0.28), "0"
            line = "Style: " + ",".join(f)
        elif line.startswith("Dialogue") and "\\pos(" in line and (pos != "bottom" or y is not None) \
                and style not in SELF_PLACED and style not in TEMPLATES:
            py = y if y is not None else {"middle": 0.50, "top": 0.18, "safe": 0.62 if portrait else 0.70}[pos]
            line = re.sub(r"\\pos\((\d+),\d+\)", lambda m: "\\pos(%s,%d)" % (m.group(1), round(h * py)), line, count=1)
        out.append(line)
    return "\n".join(out)


def caption_bottom(script, style, width, height, o):
    """Where the caption's bottom edge sits (0-1 from the top) - for the
    Studio's drag handle. Exact for a dragged height and for bottom-aligned
    lines, close for the others (the handle only needs a starting point)."""
    if o.get("y") is not None:
        return o["y"]
    h = float(height)
    portrait = height > width
    pos = o["pos"]
    if style in TEMPLATES:
        look = template(style)
        size, _font = _tpl_size(look, width, height, o)
        for line in script.split("\n"):
            if line.startswith("Style: S,"):
                size = float(line[7:].split(",")[2])     # the font the editor picked
                break
        _cx, cy = _tpl_pos(size, width, height, o, 0.24 if portrait else 0.10)
        return min(0.99, (cy + size * 0.62) / h)
    if style in SELF_PLACED:
        return {"bottom": 1 - (0.24 if portrait else 0.10), "safe": 1 - (0.30 if portrait else 0.16),
                "middle": 0.54, "top": 0.15}[pos]
    for line in script.split("\n"):
        if line.startswith("Style: "):
            f = line[7:].split(",")
            fs, mv = float(f[2]), float(f[21])
            if "\\pos(" in script and pos != "bottom":
                py = {"middle": 0.50, "top": 0.18, "safe": 0.62 if portrait else 0.70}[pos]
                return min(0.99, py + fs * 0.6 / h)
            if pos == "middle":
                return 0.5 + fs * 0.6 / h
            if pos == "top":
                return mv / h + fs * 1.25 / h
            if style == "word":
                return min(0.99, (0.62 if portrait else 0.75) + fs * 0.6 / h)
            return 1 - mv / h
    return 0.85


# ── Emphasis words (1.16.16) ────────────────────────────────────────────────
# A word that should POP: the editor wraps it in *asterisks* in the review
# ("*5,000 ብር*" = two words), and in "auto" numbers / money / percent pop by
# themselves. The word is drawn in the accent colour and EMPH_SCALE % bigger -
# the same size for the whole phrase, so nothing moves when the next word is
# spoken (the size is never animated inside a line).
EM = "\x01"
EMPH_SCALE = 115
_EMPH_WORDS = ("ብር", "ዶላር", "ሚሊዮን", "ቢሊዮን", "ሺህ", "ሺ", "ፐርሰንት", "በመቶ", "birr", "million", "billion")
_EMPH_NUM = re.compile("[0-9\u1369-\u137c%$]")


def _mark_emphasis(words, mode):
    """Words -> the same words, emphasized ones prefixed with EM, *marks* removed.
    "*word*" = one word; "*two words*" = both; an unclosed "*" stops after 6 words."""
    out, inside, run = [], False, 0
    for t, a, b in words:
        lead, trail = t.startswith("*"), t.endswith("*")
        clean = t.strip("*")
        if not clean:                       # a lone "*" between words
            inside, run = not inside, 0
            continue
        manual = inside or lead
        if lead and not trail:
            inside, run = True, 0
        elif trail and not lead:
            inside = False
        if inside:
            run += 1
            if run >= 6:
                inside = False
        auto = mode == "auto" and (_EMPH_NUM.search(clean) is not None or clean.lower().strip(".,!?።፣") in _EMPH_WORDS)
        out.append(((EM + clean) if (manual or auto) else clean, a, b))
    return out


def _emphasis_tags(lines, st):
    """EM-marked words -> accent colour + bigger, then back to the line's own
    colour and size (each line's style decides what "back" is)."""
    prim = {}
    for ln in st.split("\n"):
        f = ln[7:].split(",")
        if ln.startswith("Style: ") and len(f) > 3:
            prim[f[0]] = f[3]
    out = []
    for line in lines:
        if EM not in line:
            out.append(line)
            continue
        p = line.split(",", 9)
        base = prim.get(p[3], WHITE)
        p[9] = re.sub(EM + r"([^\s{}\\" + EM + r"]+)", lambda m: "{\\fscx%d\\fscy%d\\1c%s&}%s{\\fscx100\\fscy100\\1c%s&}" % (
            EMPH_SCALE, EMPH_SCALE, YELLOW, m.group(1), base), p[9])
        out.append(",".join(p).replace(EM, ""))
    return out


def build(words, style, width, height, font=FONT, opts=None):
    """The ASS script for `words` [(text, start, end)] in `style`, for a
    frame of width x height (sizes scale with the frame), customized by
    `opts` (see options())."""
    if style in TEMPLATES:
        return _build_template(words, style, width, height, font, opts)
    if style not in STYLES:
        raise ValueError("unknown style: %s" % style)
    o = options(opts)
    if font == FONT:
        font = FONTS[o["font"]]
    K = o["k"] * float((_face(font) or {}).get("scale", 1.0))   # every font looks the same size (1.28.0)
    NW = o["words"]
    words = _mark_emphasis([(_clean(w[0]), float(w[1]), float(w[2])) for w in words if _clean(w[0])], o["emph"])
    h = float(height)
    portrait = height > width
    lines = []
    if style in ("karaoke", "fill"):
        size = round(K * h * (0.050 if portrait else 0.060))
        mv = round(h * (0.24 if portrait else 0.10))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, YELLOW if style == "fill" else WHITE, WHITE, size * 0.09, size * 0.04,
            round(width * 0.06), round(width * 0.06), mv)
        groups = _phrases(words, NW or 3, o)
        for g, (s, e) in zip(groups, _spans(groups)):
            intro = "{\\fad(120,90)}"
            if style == "fill":
                # one line for the whole phrase: \kf sweeps the colour across
                # each word exactly while it is spoken (no redraw, no jump)
                parts, t = [], s
                for w in g:
                    lead = max(0.0, w[1] - t)
                    if lead >= 0.01:
                        parts.append("{\\k%d}" % round(lead * 100))
                    parts.append("{\\kf%d}%s " % (max(1, round((w[2] - w[1]) * 100)), w[0]))
                    t = w[2]
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s), _ts(e), IN + intro, "".join(parts).strip()))
                continue
            # karaoke: the same line redrawn per word with only a colour fade on
            # the spoken word - positions never move
            for i, w in enumerate(g):
                ws = s if i == 0 else w[1]
                we = g[i + 1][1] if i + 1 < len(g) else e
                if we <= ws:
                    continue
                txt = " ".join(
                    ("{\\1c%s&\\t(0,120,\\1c%s&)}%s{\\1c%s&}" % (WHITE, YELLOW, x[0], WHITE)) if j == i else x[0]
                    for j, x in enumerate(g))
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (
                    _ts(ws), _ts(we), (IN + intro) if i == 0 else _cont(ws - s), txt))
    elif style == "highlight":
        # The spoken word: black letters on a yellow box. The box is the word's
        # own thick outline, so the line never moves when it changes.
        size = round(K * h * (0.050 if portrait else 0.060))
        mv = round(h * (0.24 if portrait else 0.10))
        bord = size * 0.09
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, bord, size * 0.04, round(width * 0.06), round(width * 0.06), mv)
        groups = _phrases(words, NW or 3, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            for i, w in enumerate(g):
                ws = s0 if i == 0 else w[1]
                we = g[i + 1][1] if i + 1 < len(g) else e
                if we <= ws:
                    continue
                on = "{\\1c%s&\\3c%s&\\bord%.1f\\shad0}%s{\\r}" % (BLACK, YELLOW, size * 0.22, "%s")
                txt = " ".join((on % x[0]) if j == i else x[0] for j, x in enumerate(g))
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (
                    _ts(ws), _ts(we), (IN + "{\\fad(120,0)}") if i == 0 else _cont(ws - s0), txt))
    elif style == "reveal":
        # The whole phrase is laid out from the start (so it never moves);
        # each word fades in when it is spoken.
        size = round(K * h * (0.050 if portrait else 0.060))
        mv = round(h * (0.24 if portrait else 0.10))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.09, size * 0.04, round(width * 0.06), round(width * 0.06), mv)
        groups = _phrases(words, NW or 3, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            parts = []
            for w in g:
                t = max(0, int(round((w[1] - s0) * 1000)))
                parts.append("{\\alpha&HFF&\\t(%d,%d,\\alpha&H00&)}%s" % (t, t + 140, w[0]))
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\fad(0,90)}%s" % (_ts(s0), _ts(e), IN, " ".join(parts)))
    elif style == "word":
        size = round(K * h * (0.085 if portrait else 0.095))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,5,%d,%d,0,1" % (
            font, size, WHITE, WHITE, size * 0.10, size * 0.05, round(width * 0.05), round(width * 0.05))
        groups = _phrases(words, NW or 1, o)
        for k, (g, (s0, e)) in enumerate(zip(groups, _spans(groups))):
            col = YELLOW if k % 3 == 2 else WHITE
            anim = ("{\\1c%s&\\pos(%d,%d)\\fscx86\\fscy86\\t(0,160,0.6,\\fscx106\\fscy106)"
                    "\\t(160,260,1.3,\\fscx100\\fscy100)}") % (col, width // 2, round(h * (0.62 if portrait else 0.75)))
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), IN + anim, g[0][0]))
    elif style == "neon":
        size = round(K * h * (0.054 if portrait else 0.064))
        mv = round(h * (0.24 if portrait else 0.10))
        m = (round(width * 0.06), round(width * 0.06), mv)
        st = "\n".join([
            "Style: H,%s,%d,&HFF000000,&HFF000000,%s,&H00000000,-1,0,0,0,100,100,0,0,1,%.1f,0,2,%d,%d,%d,1" % ((font, size, CYAN, size * 0.30) + m),
            "Style: G,%s,%d,%s,%s,%s,&H00000000,-1,0,0,0,100,100,0,0,1,%.1f,0,2,%d,%d,%d,1" % ((font, size, CYAN, CYAN, CYAN, size * 0.07) + m),
            "Style: S,%s,%d,&H00FFFFFF,&H00FFFFFF,&H00FFF8D0,&H00000000,-1,0,0,0,100,100,0,0,1,%.1f,0,2,%d,%d,%d,1" % ((font, size, size * 0.015) + m),
        ])
        flick = "\\alpha&HFF&\\t(0,40,\\alpha&H20&)\\t(40,80,\\alpha&HA0&)\\t(80,150,\\alpha&H00&)"
        groups = _phrases(words, NW or 3, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            txt = " ".join(w[0] for w in g)
            lines.append("Dialogue: 0,%s,%s,H,,0,0,0,,\x02{%s\\blur16\\fad(0,140)}%s" % (_ts(s0), _ts(e), flick.replace("H20", "H70").replace("H00&)", "H60&)"), txt))
            lines.append("Dialogue: 1,%s,%s,G,,0,0,0,,\x02{%s\\blur5\\fad(0,140)}%s" % (_ts(s0), _ts(e), flick, txt))
            lines.append("Dialogue: 2,%s,%s,S,,0,0,0,,\x02{%s\\blur0.6\\fad(0,140)}%s" % (_ts(s0), _ts(e), flick, txt))
    elif style == "habesha":
        size = round(K * h * (0.060 if portrait else 0.070))
        mv = round(h * (0.26 if portrait else 0.11))
        st = "Style: S,%s,%d,%s,%s,&H00141414,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.11, size * 0.05, round(width * 0.05), round(width * 0.05), mv)
        groups = _phrases(words, NW or 2, o)
        cols = (GREEN, YELLOW, RED)
        n = 0
        for g, (s0, e) in zip(groups, _spans(groups)):
            parts = []
            for w in g:
                parts.append("{\\1c%s&}%s" % (cols[n % 3], w[0]))
                n += 1
            anim = "{\\fad(90,70)\\fscx88\\fscy88\\t(0,180,0.6,\\fscx102\\fscy102)\\t(180,260,\\fscx100\\fscy100)}"
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), IN + anim, " ".join(parts)))
    elif style == "bold":
        size = round(K * h * (0.058 if portrait else 0.068))
        mv = round(h * (0.25 if portrait else 0.11))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.15, size * 0.09, round(width * 0.05), round(width * 0.05), mv)
        groups = _phrases(words, NW or 3, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            for i, w in enumerate(g):
                ws = s0 if i == 0 else w[1]
                we = g[i + 1][1] if i + 1 < len(g) else e
                if we <= ws:
                    continue
                txt = " ".join(("{\\1c%s&}%s{\\1c%s&}" % (LIME, x[0], WHITE)) if j == i else x[0] for j, x in enumerate(g))
                intro = "{\\fad(100,0)\\fscx90\\fscy90\\t(0,170,0.6,\\fscx100\\fscy100)}" if i == 0 else ""
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(ws), _ts(we), (IN + intro) if i == 0 else _cont(ws - s0), txt))
    elif style == "podcast":
        size = round(K * h * (0.040 if portrait else 0.050))
        mv = round(h * (0.14 if portrait else 0.08))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H90000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, "&H00E6E6E6", WHITE, size * 0.08, size * 0.05, round(width * 0.08), round(width * 0.08), mv)
        groups = _phrases(words, NW or 7, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            half = (len(g) + 1) // 2
            for i, w in enumerate(g):
                ws = s0 if i == 0 else w[1]
                we = g[i + 1][1] if i + 1 < len(g) else e
                if we <= ws:
                    continue
                cells = [("{\\1c%s&}%s{\\1c&H00E6E6E6&}" % (YELLOW, x[0])) if j == i else x[0] for j, x in enumerate(g)]
                txt = " ".join(cells[:half]) + ("\\N" + " ".join(cells[half:]) if len(g) > half else "")
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(ws), _ts(we), (IN + "{\\fad(150,0)}") if i == 0 else _cont(ws - s0), txt))
    elif style == "typewriter":
        size = round(K * h * (0.046 if portrait else 0.056))
        mv = round(h * (0.24 if portrait else 0.10))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.08, size * 0.04, round(width * 0.06), round(width * 0.06), mv)
        groups = _phrases(words, NW or 4, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            parts = []
            for w in g:
                word = w[0].lstrip(EM)          # letter by letter: an emphasized word is tagged whole
                t0 = max(0, int(round((w[1] - s0) * 1000)))
                step = max(25, int(round((w[2] - w[1]) * 1000 / max(1, len(word)))))
                piece = "".join("{\\alpha&HFF&\\t(%d,%d,\\alpha&H00&)}%s" % (t0 + k * step, t0 + k * step + 30, ch)
                                for k, ch in enumerate(word))
                if w[0].startswith(EM):
                    piece = ("{\\fscx%d\\fscy%d\\1c%s&}" % (EMPH_SCALE, EMPH_SCALE, YELLOW) + piece +
                             "{\\fscx100\\fscy100\\1c%s&}" % WHITE)
                parts.append(piece)
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,\x02{\\fad(0,100)}%s" % (_ts(s0), _ts(e), " ".join(parts)))
    elif style == "impact":
        size = round(K * h * (0.070 if portrait else 0.082))
        mv = round(h * (0.27 if portrait else 0.12))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.12, size * 0.07, round(width * 0.05), round(width * 0.05), mv)
        groups = _phrases(words, NW or 2, o)
        for k, (g, (s0, e)) in enumerate(zip(groups, _spans(groups))):
            tilt = -6 if k % 2 == 0 else 6
            col = YELLOW if k % 2 else WHITE
            anim = ("{\\1c%s&\\fad(60,70)\\frz%d\\fscx125\\fscy125\\t(0,140,0.5,\\frz0\\fscx97\\fscy97)"
                    "\\t(140,230,\\fscx100\\fscy100)}") % (col, tilt)
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), IN + anim, " ".join(w[0] for w in g)))
    elif style == "retro":
        size = round(K * h * (0.060 if portrait else 0.070))
        mv = round(h * (0.25 if portrait else 0.11))
        st = "Style: S,%s,%d,&H00F2F7FF,&H00F2F7FF,&H00202020,&H00335CD6,-1,0,0,0,100,100,1,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, size * 0.06, size * 0.13, round(width * 0.05), round(width * 0.05), mv)
        groups = _phrases(words, NW or 2, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            anim = "{\\fad(110,90)\\yshad0\\xshad0\\t(0,200,0.6,\\xshad%.1f\\yshad%.1f)}" % (size * 0.10, size * 0.10)
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), IN + anim, " ".join(w[0] for w in g)))
    elif style == "cinema":
        size = round(K * h * (0.034 if portrait else 0.042))
        mv = round(h * (0.12 if portrait else 0.07))
        st = "Style: S,%s,%d,&H00F0F0F0,&H00F0F0F0,&H00000000,&H96000000,0,0,0,0,100,100,2.5,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, size * 0.04, size * 0.08, round(width * 0.10), round(width * 0.10), mv)
        groups = _phrases(words, NW or 6, o)
        for g, (s0, e) in zip(groups, _spans(groups)):
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,\x02{\\fad(260,220)\\blur0.8}%s" % (_ts(s0), _ts(e), " ".join(w[0] for w in g)))
    elif style == "pop":
        size = round(K * h * (0.072 if portrait else 0.085))
        mv = round(h * (0.28 if portrait else 0.12))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.10, size * 0.05, round(width * 0.05), round(width * 0.05), mv)
        groups = _phrases(words, NW or 2, o)
        for k, (g, (s, e)) in enumerate(zip(groups, _spans(groups))):
            col = WHITE if k % 2 == 0 else YELLOW
            anim = ("{\\1c%s&\\fad(90,70)\\fscx78\\fscy78\\t(0,200,0.6,\\fscx104\\fscy104)"
                    "\\t(200,300,1.4,\\fscx100\\fscy100)}") % col
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s), _ts(e), IN + anim, " ".join(w[0] for w in g)))
    elif style in SELF_PLACED:
        lines, st = _modern(words, style, width, height, font, K, NW, o)
    else:  # clean
        size = round(K * h * (0.042 if portrait else 0.050))
        mv = round(h * (0.16 if portrait else 0.07))
        st = "Style: S,%s,%d,%s,%s,&H50000000,&H50000000,0,0,0,0,100,100,0,0,3,%.1f,0,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.30, round(width * 0.07), round(width * 0.07), mv)
        groups = _phrases(words, NW or 5, o)
        for g, (s, e) in zip(groups, _spans(groups)):
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,\x02{\\fad(140,120)}%s" % (_ts(s), _ts(e), " ".join(w[0] for w in g)))
    if o["lines"] == 2 and style not in SELF_PLACED:
        lines = [_two_lines(x) for x in lines]
    lines = _entrances(lines, o["anim"], st, width, height)
    lines = _emphasis_tags(lines, st)
    if o["anim"] in LETTER_ANIMS:
        lines = _letters(lines, o["anim"])
    script = _header(width, height, st) + "\n".join(_smooth_fades(lines)) + "\n"
    # colours: the highlight (yellow / green / cyan in the styles) and the text
    if o["color"] and style != "habesha":
        for c in (YELLOW, LIME, CYAN, VIOLET, SPOT):
            script = script.replace(c, o["color"])
    if o["text"]:
        script = script.replace(WHITE, o["text"])
    script = _apply_layout(script, style, width, height, o)
    return script.replace("[Events]\n", "; amh-bottom: %.4f\n[Events]\n" % caption_bottom(script, style, width, height, o), 1)


def _build_template(words, style, width, height, font=FONT, opts=None):
    """The ASS script for a caption template - a professional look that is
    drawn by one code for every template (see TEMPLATES)."""
    look = template(style)
    # the editor's own font wins over the template's (the panel starts a
    # template on the font it came with)
    raw_font = (opts or {}).get("font")
    if raw_font in FONTS:
        look = dict(look)
        look["font"] = raw_font
    o = options(opts)
    ws = _mark_emphasis([(_clean(w[0]), float(w[1]), float(w[2])) for w in words if _clean(w[0])], o["emph"])
    lines, st = _tpl_script(ws, look, width, height, o)
    if o["lines"] == 2 and look["mode"] in ("line", "reveal") and int(look.get("rows") or 1) < 2:
        lines = [_two_lines(x) for x in lines]
    anim = o["anim"] if o["anim"] != "auto" else look["anim"]
    lines = _entrances(lines, anim, st, width, height)
    if o["anim"] in LETTER_ANIMS:
        lines = _letters(lines, o["anim"])
    script = _header(width, height, st) + "\n".join(_smooth_fades(lines)) + "\n"
    script = _apply_layout(script, style, width, height, o)
    return script.replace("[Events]\n", "; amh-bottom: %.4f\n[Events]\n" % caption_bottom(script, style, width, height, o), 1)


_FAD = re.compile(r"\\fad\((\d+),(\d+)\)")


def _two_lines(line):
    """A dialogue's phrase on two balanced lines (1.50): the space nearest the
    middle of the VISIBLE letters becomes \\N. Tags are skipped, so every
    redraw of the same phrase (word-by-word styles) breaks at the same word;
    a phrase already on two lines, or of one word, stays."""
    head, sep, text = line.partition(",,0,0,0,,")
    if not sep or "\\N" in text:
        return line
    spaces, n, i = [], 0, 0
    while i < len(text):
        ch = text[i]
        if ch == "{":
            j = text.find("}", i)
            i = len(text) if j < 0 else j + 1
            continue
        if ch in "\x03\x05":                     # a redraw / letter mark: its number is not text
            j = text.find("\x04" if ch == "\x03" else "\x06", i)
            i = len(text) if j < 0 else j + 1
            continue
        if ch in "\x02\x04\x06":
            i += 1
            continue
        if ch == " ":
            spaces.append((n, i))
        n += 1
        i += 1
    if not spaces:
        return line
    k = min(spaces, key=lambda p: abs(n - 1 - 2 * p[0]))[1]
    return head + sep + text[:k] + "\\N" + text[k + 1:]

IN = "\x02"                    # marks the line where a phrase appears
_CONT = re.compile("\x03(\\d+)\x04")


def _cont(secs):
    """Marks a redraw of a phrase that appeared `secs` ago (word-by-word
    styles draw the same phrase again for every word)."""
    return "\x03%d\x04" % max(0, int(round(secs * 1000)))


def _anim_spec(anim, size, width, height, look=None):
    """(fade-in ms, start tags, [(t1, t2, accel, end tags)]) of an entrance.
    Slides ease out: the text turns a tiny angle around a point far to the
    left, so it moves straight up/down (libass \\move cannot ease).
    look: the style line's own colour / outline (what an entrance returns to)."""
    look = look or {}
    if anim in LETTER_ANIMS:
        return 60, "", []                              # the letters do it (_letters)
    if anim == "slidecolor":
        ang = math.degrees(math.atan(size * 0.8 / (20.0 * width)))
        org = "\\org(%d,%d)" % (-20 * width, height // 2)
        return 150, "%s\\frz%.4f\\1c%s&" % (org, -ang, look.get("hl", YELLOW)), \
            [(0, 280, 0.45, "\\frz0"), (120, 420, 1.0, "\\1c%s&" % look.get("prim", WHITE))]
    if anim == "shake":
        return 70, "\\frz-4", [(0, 60, 1.0, "\\frz4"), (60, 120, 1.0, "\\frz-3"), (120, 180, 1.0, "\\frz2"),
                                (180, 240, 1.0, "\\frz-1"), (240, 300, 1.0, "\\frz0")]
    if anim == "glow":
        return 90, "\\3c&H00FFFFFF&\\bord%.1f\\blur%s" % (size * 0.22, "%s"), \
            [(0, 420, 0.7, "\\3c%s&\\bord%.1f\\blur%s" % (look.get("outline", "&H00000000"), look.get("bord", size * 0.08), "%s"))]
    if anim == "blurzoom":
        return 160, "\\fscx145\\fscy145\\blur%s", [(0, 360, 0.45, "\\fscx100\\fscy100\\blur%s")]
    if anim == "fade":
        return 220, "", []
    # 1.73 motion pack
    if anim == "bounce":
        # falls in from above, lands, bounces twice and settles
        ang = math.degrees(math.atan(size * 1.1 / (20.0 * width)))
        org = "\\org(%d,%d)" % (-20 * width, height // 2)
        return 120, "%s\\frz%.4f" % (org, ang), [(0, 230, 1.8, "\\frz%.4f" % (-ang * 0.16)), (230, 330, 0.6, "\\frz%.4f" % (ang * 0.07)),
                                                 (330, 420, 1.6, "\\frz%.4f" % (-ang * 0.025)), (420, 480, 1.0, "\\frz0")]
    if anim == "flicker":
        # a sign switching on: off-on-off-on, then steady
        return 0, "\\alpha&HFF&", [(0, 1, 1.0, "\\alpha&H00&"), (70, 71, 1.0, "\\alpha&HD0&"), (120, 121, 1.0, "\\alpha&H00&"),
                                     (170, 171, 1.0, "\\alpha&H90&"), (220, 221, 1.0, "\\alpha&H00&")]
    if anim == "snap":
        # big and fast, then snaps to its size
        return 40, "\\fscx165\\fscy165", [(0, 110, 0.35, "\\fscx94\\fscy94"), (110, 170, 1.0, "\\fscx100\\fscy100")]
    if anim == "rampup":
        # grows from a flat line, faster and faster, a tiny overshoot
        return 110, "\\fscy8\\fscx92", [(0, 230, 2.2, "\\fscy112\\fscx100"), (230, 300, 1.0, "\\fscy100")]
    if anim == "fadeup":
        # a slow, soft rise
        ang = math.degrees(math.atan(size * 1.3 / (20.0 * width)))
        org = "\\org(%d,%d)" % (-20 * width, height // 2)
        return 380, "%s\\frz%.4f" % (org, -ang), [(0, 560, 0.35, "\\frz0")]
    if anim in ("slide", "drop"):
        ang = math.degrees(math.atan(size * 0.8 / (20.0 * width)))
        org = "\\org(%d,%d)" % (-20 * width, height // 2)
        # +angle turns counter-clockwise around a point on the left: up
        return 170, "%s\\frz%.4f" % (org, -ang if anim == "slide" else ang), [(0, 300, 0.45, "\\frz0")]
    if anim == "pop":
        return 90, "\\fscx70\\fscy70", [(0, 190, 0.6, "\\fscx106\\fscy106"), (190, 290, 1.4, "\\fscx100\\fscy100")]
    if anim == "zoom":
        return 170, "\\fscx135\\fscy135", [(0, 320, 0.45, "\\fscx100\\fscy100")]
    if anim == "blur":
        return 200, "\\blur%s", [(0, 340, 0.6, "\\blur%s")]
    return 0, "", []                                   # none: just appears


_OWN_IN = re.compile(r"\\t\([^)]*\)|\\fad\(\d+,\d+\)|\\fsc[xy][\d.]+|\\frz-?[\d.]+|\\[xy]shad-?[\d.]+|\\alpha&H[0-9A-Fa-f]+&")


def _entrances(lines, anim, st, width, height):
    """Replace each phrase's own entrance with the chosen one ("auto" keeps
    the style's). Redraws of a phrase (word-by-word styles) continue the same
    animation from where it is, so nothing jumps when the next word lights."""
    out = []
    f0 = st.split("\n")[0][7:].split(",")
    size = float(f0[2])
    look = {"prim": f0[3], "outline": f0[5], "bord": float(f0[16]) if len(f0) > 16 else size * 0.08,
            "hl": YELLOW if f0[3] != YELLOW else WHITE}
    fade_in, start, steps = _anim_spec(anim, size, width, height, look)
    total = max([fade_in] + [t2 for _, t2, _, _ in steps])
    for line in lines:
        head, text = line.split(",,0,0,0,,", 1)
        m = _CONT.match(text)
        if not text.startswith(IN) and not m:
            out.append(line)
            continue
        off = int(m.group(1)) if m else 0
        text = text[m.end():] if m else text[1:]
        if anim == "auto":
            out.append(head + ",,0,0,0,," + text)
            continue
        b = re.match(r"\{([^}]*)\}", text)
        block, rest = (b.group(1), text[b.end():]) if b else ("", text)
        fo = _FAD.search(block)
        fade_out = int(fo.group(2)) if fo else 0
        bl = re.search(r"\\blur([\d.]+)", block)
        base = float(bl.group(1)) if bl else 0.0
        # the style's own entrance goes, but its end look stays (neon's soft
        # halo, retro's shadow): the end values of its \t become plain tags
        finals = "".join(t[t.index("\\", 1):-1] for t in re.findall(r"\\t\([^)]*\)", block) if "\\" in t[1:])
        block = re.sub(r"\\blur[\d.]+", "", _OWN_IN.sub("", block) + finals)
        tags = ""
        if off == 0:
            tags += "\\fad(%d,%d)" % (fade_in, fade_out)
        elif off < fade_in:
            a0 = round(255 * (1 - off / float(fade_in)))
            p = head.split(",")
            dur = int(round((_secs(p[2]) - _secs(p[1])) * 1000))
            tags += "\\fade(%d,0,%d,0,%d,%d,%d)" % (a0, 255 if fade_out else 0, fade_in - off,
                                                   dur - fade_out if fade_out else fade_in - off, dur if fade_out else fade_in - off)
        elif fade_out:
            tags += "\\fad(0,%d)" % fade_out
        if off < total:
            tags += start
            for t1, t2, acc, end in steps:
                tags += "\\t(%d,%d,%s,%s)" % (t1 - off, t2 - off, acc, end)
        if anim in ("blur", "blurzoom", "glow"):
            tags = tags.replace("\\blur%s", "\\blur%g" % (base + (6 if anim == "glow" else 10)), 1).replace("\\blur%s", "\\blur%g" % base, 1) \
                if off < total else tags + ("\\blur%g" % base if base else "")
        elif base:
            tags += "\\blur%g" % base
        # letter by letter: a mark for _letters() (how long ago the phrase appeared)
        mark = (LETTER_MARK + str(off) + LETTER_END) if anim in LETTER_ANIMS else ""
        out.append(head + ",,0,0,0,," + ("{" + block + tags + "}" if block + tags else "") + mark + rest)
    return out


LETTER_MARK, LETTER_END = "\x05", "\x06"
_LETTER_RE = re.compile(LETTER_MARK + "(\\d+)" + LETTER_END)


def _letters(lines, anim):
    """Typewriter / wave (1.40): every letter of a phrase gets its own start
    (in reading order; a short phrase types faster, so it is complete well
    before the next one). A redraw of the same phrase (word-by-word styles)
    continues: letters already shown stay shown. Runs after the ★ words are
    coloured, so it never splits their marks; override blocks are kept."""
    out = []
    for line in lines:
        m = _LETTER_RE.search(line)
        if not m:
            out.append(line)
            continue
        off = int(m.group(1))
        head, text = line[:m.start()], line[m.end():]
        n = sum(1 for ch in re.sub(r"\{[^}]*\}", "", text) if not ch.isspace())
        step = max(18, min(55, 650 // max(1, n)))
        res, i, k = [], 0, 0
        while i < len(text):
            ch = text[i]
            if ch == "{":
                j = text.find("}", i)
                j = len(text) - 1 if j < 0 else j
                res.append(text[i:j + 1])
                i = j + 1
                continue
            if ch == "\\" and text[i + 1:i + 2] in ("N", "n", "h"):   # a line break stays one piece
                res.append(text[i:i + 2])
                i += 2
                continue
            if not ch.isspace():
                t = k * step - off
                k += 1
                if t > 0:
                    if anim == "typewriter":
                        res.append("{\\alpha&HFF&\\t(%d,%d,\\alpha&H00&)}" % (t, t + 1))
                    else:   # wave: each letter rises out of the line, one after another
                        res.append("{\\alpha&HFF&\\fscy35\\t(%d,%d,0.6,\\alpha&H00&\\fscy125)\\t(%d,%d,1.3,\\fscy100)}" % (
                            t, t + 110, t + 110, t + 230))
                        res.append(ch)
                        res.append("{\\fscy100\\alpha&H00&}")
                        i += 1
                        continue
                elif anim == "wave":
                    pass
            res.append(ch)
            i += 1
        out.append(head + "".join(res))
    return out


def _smooth_fades(lines):
    """No fade between back-to-back captions: a line that ends exactly when
    another line of the same layer starts does not fade out, and that line
    does not fade in (both half-transparent at once looked like a blink)."""
    def times(line):
        p = line.split(",", 3)
        return p[0], p[1], p[2]
    starts, ends = set(), set()
    for line in lines:
        lay, a, b = times(line)
        starts.add((lay, a))
        ends.add((lay, b))
    out = []
    for line in lines:
        lay, a, b = times(line)
        fin = (lay, a) not in ends
        fout = (lay, b) not in starts
        out.append(_FAD.sub(lambda m: "\\fad(%d,%d)" % (int(m.group(1)) if fin else 0, int(m.group(2)) if fout else 0),
                            line, count=1))
    return out


# ── modern styles: every word placed by us ──────────────────────────────────
_METRICS = {}


def _metrics():
    """Letter widths of the shipped fonts (runtime/fonts or tools/fonts)."""
    if "faces" not in _METRICS:
        here = os.path.dirname(os.path.abspath(__file__))
        faces = {}
        for d in (os.path.join(here, "fonts"), os.path.join(here, "tools", "fonts")):
            f = os.path.join(d, "metrics.json")
            if os.path.isfile(f):
                with open(f, encoding="utf-8") as fh:
                    faces = json.load(fh)
                break
        _METRICS["faces"] = faces
    return _METRICS["faces"]


def _face(font, bold=True):
    m = _metrics()
    return m.get("%s|%d" % (font, 1 if bold else 0)) or m.get("%s|0" % font)


def _text_w(text, font, size, bold=True):
    """Width in pixels of `text` at ASS font size `size`, as libass draws it."""
    f = _face(font, bold)
    if not f:
        return len(text) * size * 0.52             # no metrics: a fair guess
    adv, fb = f["adv"], f["fallback"]
    return sum(adv.get(str(ord(ch)), fb) for ch in text) * size / float(f["em"])


def _ink_offset(font, size, bold=True):
    """How far below the line box centre the middle of Ethiopic letters is."""
    f = _face(font, bold)
    if not f:
        return size * 0.08
    em = float(f["em"])
    return ((f["ascent"] - (f["ink_top"] + f["ink_bottom"]) / 2.0) / em - 0.5) * size


def _place(words, font, size, width, height, o, bottom_frac, gap=0.28):
    """Centre x, centre y and width of every word of a phrase: rows no wider
    than 86% of the frame, the block placed like the other styles."""
    max_w = width * 0.86
    sp = _text_w(" ", font, size) + size * gap * 0.25
    # an emphasized word is drawn EMPH_SCALE bigger: give it that much room
    ws = [_text_w(w.lstrip(EM), font, size) * (EMPH_SCALE / 100.0 if w.startswith(EM) else 1) for w in words]
    rows, cur, cw = [], [], 0.0
    for i, w in enumerate(ws):
        need = w if not cur else cw + sp + w
        if cur and need > max_w:
            rows.append(cur)
            cur, cw = [i], w
        else:
            cur.append(i)
            cw = need
    if cur:
        rows.append(cur)
    # two lines (1.50): one row is cut where both halves are about as wide
    if o.get("lines") == 2 and len(rows) == 1 and len(words) >= 2:
        full = sum(ws) + sp * (len(ws) - 1)
        best, acc = 1, 0.0
        for j in range(1, len(ws)):
            acc += ws[j - 1] + (sp if j > 1 else 0)
            if abs(full - sp - 2 * acc) < abs(full - sp - 2 * (sum(ws[:best]) + sp * (best - 1))):
                best = j
        rows = [list(range(best)), list(range(best, len(ws)))]
    row_h = size * 1.18
    block_h = row_h * len(rows)
    h = float(height)
    portrait = height > width
    if o.get("y") is not None:
        top = h * o["y"] - block_h
    elif o["pos"] == "middle":
        top = h / 2 - block_h / 2
    elif o["pos"] == "top":
        top = h * 0.08
    elif o["pos"] == "safe":
        top = h - h * (0.30 if portrait else 0.16) - block_h
    else:
        top = h - h * bottom_frac - block_h
    out = [None] * len(words)
    for r, row in enumerate(rows):
        total = sum(ws[i] for i in row) + sp * (len(row) - 1)
        x = width / 2.0 - total / 2
        cy = top + row_h * r + row_h / 2
        for i in row:
            out[i] = (x + ws[i] / 2, cy, ws[i])
            x += ws[i] + sp
    return out


def _pill(w, h, r):
    """A rounded rectangle w x h (corner radius r) as an ASS drawing."""
    r = min(r, w / 2.0, h / 2.0)
    c = r * 0.4477                                   # bezier circle constant (1 - 0.5523)
    f = lambda v: ("%.1f" % v).rstrip("0").rstrip(".")
    return ("m %s 0 l %s 0 b %s 0 %s %s %s %s l %s %s b %s %s %s %s %s %s l %s %s b %s %s 0 %s 0 %s "
            "l 0 %s b 0 %s %s 0 %s 0") % (
        f(r), f(w - r), f(w - c), f(w), f(c), f(w), f(r), f(w), f(h - r), f(w), f(h - c), f(w - c), f(h), f(w - r), f(h),
        f(r), f(h), f(c), f(h), f(h - c), f(h - r), f(r), f(c), f(c), f(r))


def _glide_tags(x0, y0, x1, y1, dur, big):
    """Move a line from (x0, y0) to where it is drawn (x1, y1) with an ease-out.
    libass \\move cannot ease, so the line turns a tiny angle around a far
    point on the perpendicular bisector: that moves it along an almost
    straight path, and \\t eases the turn."""
    dx, dy = x0 - x1, y0 - y1
    d = math.hypot(dx, dy)
    if d < 0.5:
        return ""
    R = 60.0 * big
    mx, my = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    ux, uy = -dy / d, dx / d                          # perpendicular to the move
    ox, oy = mx + ux * R, my + uy * R
    # angle that takes the drawn point (x1, y1) to the start (x0, y0)
    a1 = math.atan2(y1 - oy, x1 - ox)
    a0 = math.atan2(y0 - oy, x0 - ox)
    ang = -math.degrees(a0 - a1)                      # screen y points down: ASS \frz is counter-clockwise
    # ease-in-out: speeds up gently, then settles (two halves of the turn)
    half = dur // 2
    return "\\org(%d,%d)\\frz%.4f\\t(0,%d,2,\\frz%.4f)\\t(%d,%d,0.5,\\frz0)" % (
        round(ox), round(oy), ang, half, ang / 2, half, dur)


def _modern(words, style, width, height, font, K, NW, o):
    """glide / spotlight / bounce. Returns (dialogue lines, style lines)."""
    h = float(height)
    portrait = height > width
    big = max(width, height)
    size = round(K * h * ((0.056 if style != "spotlight" else 0.054) if portrait else (0.066 if style != "spotlight" else 0.062)))
    # one long word must still fit the frame: then everything gets smaller
    widest = max([_text_w(w[0].lstrip(EM), font, size) * (EMPH_SCALE / 100.0 if w[0].startswith(EM) else 1)
                  for w in words] + [1])
    if widest > width * 0.86:
        size = max(8, int(size * width * 0.86 / widest))
    bottom = 0.24 if portrait else 0.10
    bord = size * 0.075
    st = "\n".join([
        "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,5,0,0,0,1" % (
            font, size, WHITE, WHITE, bord, size * 0.045),
        "Style: P,%s,%d,%s,%s,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1" % (font, size, VIOLET, VIOLET),
    ])
    lines = []
    groups = _phrases(words, NW or {"glide": 3, "spotlight": 4, "bounce": 3}[style], o)
    slide_in = o.get("anim") in ("slide", "drop")
    for g, (s0, e) in zip(groups, _spans(groups)):
        # word gaps: the pill needs room around its word; a growing word too
        places = _place([w[0] for w in g], font, size, width, height, o, bottom,
                        gap={"glide": 0.9, "spotlight": 0.45, "bounce": 0.28}[style])
        if style == "glide":
            ink = _ink_offset(font, size) - size * 0.025   # (measured: tall letters sit a little higher)
            ph = size * 1.06                                 # room for the letters and their outline
            padx = size * 0.26
            soft = "" if o.get("anim") == "blur" else "\\blur0.6"     # (blur-in sets its own)
            for i, w in enumerate(g):
                ws = s0 if i == 0 else w[1]
                we = g[i + 1][1] if i + 1 < len(g) else e
                if we <= ws:
                    continue
                cx, cy, tw = places[i]
                pw = tw + 2 * padx
                x, y = cx - pw / 2, cy + ink - ph / 2
                if i == 0:
                    # its own grow-in only with the style's own entrance
                    move = "\\fscx82\\fscy82\\t(0,180,0.5,\\fscx100\\fscy100)" if o.get("anim") == "auto" else ""
                    # the last piece of the pill fades out with the words
                    first = "{\\an7\\pos(%d,%d)\\fad(120,%d)}" % (round(x), round(y), 90 if i == len(g) - 1 else 0)
                    lines.append("Dialogue: 1,%s,%s,P,,0,0,0,,%s%s{\\bord0\\shad0%s%s\\p1}%s" % (
                        _ts(ws), _ts(we), IN, first, soft, move, _pill(pw, ph, ph * 0.32)))
                    continue
                px, py, pw0 = places[i - 1]
                x0, y0 = px - (pw0 + 2 * padx) / 2, py + ink - ph / 2
                dur = max(60, min(220, int((we - ws) * 1000 * 0.6)))
                s_from = 100.0 * (pw0 + 2 * padx) / pw
                scale = "\\fscx%.1f\\t(0,%d,2,\\fscx%.1f)\\t(%d,%d,0.5,\\fscx100)" % (
                    s_from, dur // 2, (s_from + 100) / 2, dur // 2, dur)
                if slide_in and ws - s0 < 0.32:
                    # the whole phrase is still sliding in (that turn is taken):
                    # a straight move for the pill
                    glide = "\\move(%d,%d,%d,%d,0,%d)" % (round(x0), round(y0), round(x), round(y), dur)
                    pos = ""
                else:
                    glide = _glide_tags(x0, y0, x, y, dur, big)
                    pos = "\\pos(%d,%d)" % (round(x), round(y))
                lines.append("Dialogue: 1,%s,%s,P,,0,0,0,,%s{\\an7%s%s}{\\bord0\\shad0%s%s%s\\p1}%s" % (
                    _ts(ws), _ts(we), _cont(ws - s0), pos, "\\fad(0,90)" if i == len(g) - 1 else "",
                    soft, glide, scale, _pill(pw, ph, ph * 0.32)))
            for i, w in enumerate(g):
                cx, cy, tw = places[i]
                lines.append("Dialogue: 2,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)\\fad(120,90)}%s" % (
                    _ts(s0), _ts(e), IN, round(cx), round(cy), w[0]))
        elif style == "spotlight":
            for i, w in enumerate(g):
                cx, cy, tw = places[i]
                a = max(0, int(round((w[1] - s0) * 1000)))
                b = max(a + 60, int(round((w[2] - s0) * 1000)))
                lit = ("{\\alpha&H99&\\1c%s&\\t(%d,%d,0.6,\\alpha&H00&\\1c%s&\\fscx112\\fscy112)"
                       "\\t(%d,%d,1.4,\\alpha&H40&\\1c%s&\\fscx100\\fscy100)}") % (
                    WHITE, max(0, a - 40), a + 110, SPOT, b, b + 160, WHITE)
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)\\fad(140,110)}%s%s" % (
                    _ts(s0), _ts(e), IN, round(cx), round(cy), lit, w[0]))
        else:  # bounce
            lift = size * 0.45
            for i, w in enumerate(g):
                cx, cy, tw = places[i]
                ws = s0 if i == 0 else max(s0, w[1] - 0.04)
                if ws >= e:
                    continue
                spoken = max(0, int(round((w[2] - ws) * 1000)))
                col = "{\\1c%s&\\t(%d,%d,\\1c%s&)}" % (YELLOW, spoken, spoken + 140, WHITE)
                # spring: up from below, a little past the line, settle (the
                # first word's spring is the phrase entrance, so it sits in the
                # first block where a chosen entrance replaces it)
                ang = math.degrees(math.atan(lift / (20.0 * width)))
                spring = ("\\org(%d,%d)\\frz%.4f\\fscx86\\fscy86\\t(0,170,0.5,\\frz%.4f\\fscx104\\fscy104)"
                          "\\t(170,280,1.3,\\frz0\\fscx100\\fscy100)") % (-20 * width, round(cy), -ang, ang * 0.14)
                if i == 0:
                    lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)\\fad(90,90)%s}%s%s" % (
                        _ts(ws), _ts(e), IN, round(cx), round(cy), spring, col, w[0]))
                    continue
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,{\\an5\\pos(%d,%d)\\fad(90,90)}{%s}%s%s" % (
                    _ts(ws), _ts(e), round(cx), round(cy), spring, col, w[0]))
    return lines, st


# ── Caption templates (1.66): professional looks, fully customizable ─────────
# A template is a look made of numbers: the font, the colours, the outline, the
# shadow, the glow, the box, the gradient and how the spoken word is marked.
# One drawing code draws every template, so a look is DATA - the editor can
# change it, save it under a name and share it as a file.
#
# mode: line   the phrase on one line, the spoken word marked
#       word   one word at a time, big
#       reveal the phrase is placed at once, each word appears when it is said
#       chip   every word in its own rounded box
#       arch   the words follow an upward curve
# hl:   none | colour | fill | box   (how the spoken word is marked)
TEMPLATE_DEFAULT = {
    "font": "sans",
    "size": 1.0,          # text size (1.0 = the size of the older styles)
    "upper": False,       # ALL CAPS
    "spacing": 0.0,       # letter spacing (x the font size)
    "text": "#FFFFFF",    # text colour
    "accent": "#FFD400",  # the colour of the spoken word
    "outline": "#000000",
    "outline_w": 0.0,     # outline width (x the font size)
    "shadow": "#000000",
    "shadow_w": 0.0,      # shadow depth (x the font size)
    "glow": "",           # glow colour ("" = no glow)
    "glow_w": 0.0,        # glow width (x the font size)
    "box": "",            # box colour ("" = no box)
    "box_a": 0.6,         # box opacity (0-1)
    "box_pad": 0.22,      # box padding (x the font size)
    "box_r": 0.0,         # box corner radius (x the font size; 0 = square)
    "grad_a": "",         # gradient start colour ("" = no gradient)
    "grad_b": "",         # gradient end colour
    "words": 3,           # words per caption
    "align": "center",    # center | left | right
    "hl": "colour",       # how the spoken word is marked
    "anim": "auto",       # entrance animation
    "mode": "line",
    "arc": 13.0,          # arch: degrees per word
    "bold": True,
    "rows": 1,            # 2 = the phrase may stack on two animated lines
    "wrap": 0.86,         # the widest a line may be (x the frame width)
    "line_gap": 1.14,     # distance between stacked lines (x the font size)
    "stagger": 0.09,      # seconds between the lines' entrances
    "exit": 0,            # fade-out of each line (ms; 0 = none)
}

# The built-in templates. Names are what the editor sees (Amharic in i18n.js).
TEMPLATES = {
    "modern": {"name": "Modern", "look": {
        "font": "yebse", "size": 1.05, "text": "#FFFFFF", "accent": "#FFFFFF",
        "outline": "#000000", "outline_w": 0.055, "hl": "none", "mode": "reveal",
        "words": 3, "anim": "fade"}},
    "boldpop": {"name": "Bold Pop", "look": {
        "font": "yebse", "size": 1.10, "upper": True, "text": "#FFFFFF", "accent": "#FFD400",
        "outline": "#000000", "outline_w": 0.075, "shadow": "#000000", "shadow_w": 0.05,
        "hl": "colour", "mode": "line", "words": 2, "anim": "pop"}},
    "creator": {"name": "Creator", "look": {
        "font": "yebse", "size": 1.00, "upper": True, "text": "#FFFFFF", "accent": "#F7C204",
        "outline": "#000000", "outline_w": 0.06, "shadow": "#000000", "shadow_w": 0.045,
        "hl": "colour", "mode": "line", "words": 3, "anim": "pop"}},
    "comic": {"name": "Comic", "look": {
        "font": "washra", "size": 1.15, "upper": True, "text": "#FFE000", "accent": "#FF3B30",
        "outline": "#000000", "outline_w": 0.11, "shadow": "#000000", "shadow_w": 0.06,
        "hl": "colour", "mode": "line", "words": 2, "anim": "pop"}},
    "gradient": {"name": "Gradient", "look": {
        "font": "sans", "size": 1.05, "text": "#FFFFFF", "accent": "#FFFFFF",
        "grad_a": "#FF7A00", "grad_b": "#FF2D95",
        "outline": "#000000", "outline_w": 0.05, "shadow": "#000000", "shadow_w": 0.03,
        "hl": "colour", "mode": "line", "words": 3, "anim": "pop"}},
    "neonglow": {"name": "Neon Glow", "look": {
        "font": "sans", "size": 1.00, "text": "#FFFFFF", "accent": "#FFF35C",
        "outline": "#00E5FF", "outline_w": 0.025, "glow": "#00E5FF", "glow_w": 0.30,
        "hl": "colour", "mode": "line", "words": 3, "anim": "fade"}},
    "glass": {"name": "Glass Box", "look": {
        "font": "sans", "size": 0.95, "text": "#FFFFFF", "accent": "#7DD3FC",
        "box": "#0B0F1A", "box_a": 0.62, "box_r": 0.30,
        "hl": "colour", "mode": "line", "words": 3, "anim": "fade"}},
    "subtitle": {"name": "Subtitle", "look": {
        "font": "sans", "size": 0.90, "text": "#FFFFFF", "accent": "#FFD400",
        "box": "#000000", "box_a": 0.72, "box_r": 0.0,
        "hl": "colour", "mode": "line", "words": 4, "anim": "fade"}},
    "arch": {"name": "Arch", "look": {
        "font": "yebse", "size": 1.15, "text": "#FFFFFF", "accent": "#FFD400",
        "outline": "#000000", "outline_w": 0.065, "shadow": "#000000", "shadow_w": 0.04,
        "hl": "colour", "mode": "arch", "arc": 13.0, "words": 3, "anim": "pop"}},
    "editorial": {"name": "Editorial", "look": {
        "font": "serif", "size": 0.80, "upper": True, "spacing": 0.08,
        "text": "#F2F2F2", "accent": "#E8C36A", "shadow": "#000000", "shadow_w": 0.03,
        "hl": "colour", "mode": "reveal", "words": 5, "anim": "fade"}},
    "chips": {"name": "Chips", "look": {
        "font": "sans", "size": 0.95, "text": "#FFFFFF", "accent": "#7C3AED",
        "box": "#161A26", "box_a": 0.88, "box_r": 0.30,
        "hl": "colour", "mode": "chip", "words": 3, "anim": "pop"}},
    "paperink": {"name": "Paper", "look": {
        "font": "serif", "size": 0.85, "text": "#14141A", "accent": "#B3261E",
        "box": "#FFFFFF", "box_a": 0.94, "box_r": 0.12,
        "hl": "colour", "mode": "line", "words": 4, "anim": "fade"}},
    "story": {"name": "Story", "look": {
        "font": "jiret", "size": 0.95, "text": "#FFB347", "accent": "#FFE0B2",
        "hl": "colour", "mode": "line", "words": 4, "anim": "fade"}},
    "duo": {"name": "Two Line", "look": {
        "font": "yebse", "size": 1.02, "text": "#FFFFFF", "accent": "#FFD84D",
        "outline": "#000000", "outline_w": 0.075, "shadow": "#000000", "shadow_w": 0.045,
        "hl": "colour", "mode": "line", "words": 5, "rows": 2, "anim": "slide",
        "wrap": 0.72, "line_gap": 1.16, "stagger": 0.09, "exit": 90}},
    # 1.73 kinetic pack: our own Reels-emphasis and kinetic-typography looks
    "reels": {"name": "Reels", "look": {
        "font": "yebse", "size": 1.0, "text": "#FFFFFF", "accent": "#FF2D3A",
        "glow": "#9E0014", "glow_w": 0.11, "shadow": "#000000", "shadow_w": 0.03,
        "hl": "none", "mode": "reels", "words": 4, "anim": "auto"}},
    "reelsgold": {"name": "Reels Gold", "look": {
        "font": "yebse", "size": 1.0, "text": "#F6F1E7", "accent": "#FFC23D",
        "glow": "#8A5600", "glow_w": 0.10, "shadow": "#000000", "shadow_w": 0.03,
        "hl": "none", "mode": "reels", "words": 4, "anim": "auto"}},
    "kinetic": {"name": "Kinetic", "look": {
        "font": "yebse", "size": 1.0, "text": "#FFFFFF", "accent": "#3DF5B5",
        "shadow": "#000000", "shadow_w": 0.035, "outline": "#000000", "outline_w": 0.02,
        "hl": "none", "mode": "kinetic", "words": 4, "anim": "auto"}},
    "kineticpop": {"name": "Kinetic Pop", "look": {
        "font": "washra", "size": 1.0, "text": "#FFFFFF", "accent": "#FFD400",
        "outline": "#000000", "outline_w": 0.06, "shadow": "#000000", "shadow_w": 0.04,
        "hl": "none", "mode": "kinetic", "words": 4, "anim": "auto"}},
    "bouncy": {"name": "Bouncy", "look": {
        "font": "yebse", "size": 1.08, "text": "#FFFFFF", "accent": "#FF3B6B",
        "outline": "#000000", "outline_w": 0.07, "shadow": "#000000", "shadow_w": 0.05,
        "hl": "colour", "mode": "line", "words": 2, "anim": "bounce"}},
    "flicker": {"name": "Flicker", "look": {
        "font": "sans", "size": 1.0, "text": "#FFFFFF", "accent": "#FF4D4D",
        "glow": "#FF4D4D", "glow_w": 0.16, "outline": "#000000", "outline_w": 0.03,
        "hl": "colour", "mode": "line", "words": 3, "anim": "flicker"}},
    "snap": {"name": "Snap", "look": {
        "font": "yebse", "size": 1.12, "text": "#FFFFFF", "accent": "#7CFFCB",
        "outline": "#000000", "outline_w": 0.075, "shadow": "#000000", "shadow_w": 0.05,
        "hl": "colour", "mode": "word", "words": 1, "anim": "snap"}},
}


def template(tid):
    """A template's look with the defaults filled in (None for an unknown id)."""
    t = TEMPLATES.get(tid)
    if not t:
        return None
    look = dict(TEMPLATE_DEFAULT)
    look.update(t.get("look") or {})
    look["id"] = tid
    look["name"] = t.get("name") or tid
    return look


def template_ids():
    """The built-in template ids (the panel lists them next to the styles)."""
    return tuple(TEMPLATES.keys())


def _hex_rgb(h):
    m = re.match(r"^#?([0-9a-fA-F]{6})$", str(h or ""))
    if not m:
        return None
    v = m.group(1)
    return (int(v[0:2], 16), int(v[2:4], 16), int(v[4:6], 16))


def _mix(a, b, t):
    """Two colours mixed (t = 0 -> a, 1 -> b)."""
    ca, cb = _hex_rgb(a), _hex_rgb(b)
    if not ca or not cb:
        return a
    t = max(0.0, min(1.0, float(t)))
    return "#%02X%02X%02X" % tuple(int(round(ca[i] + (cb[i] - ca[i]) * t)) for i in range(3))


def _ass_color_a(hexrgb, opacity, default=None):
    """'#RRGGBB' with an opacity (0-1) -> ASS '&H<alpha>BBGGRR'."""
    rgb = _hex_rgb(hexrgb)
    if not rgb:
        return default
    a = int(round((1.0 - max(0.0, min(1.0, float(opacity)))) * 255))
    return "&H%02X%02X%02X%02X" % (a, rgb[2], rgb[1], rgb[0])


def _ass_hex(col):
    """An ASS colour ('&H00BBGGRR') back to '#RRGGBB' (the editor's colours are
    already ASS colours - see options())."""
    m = re.match(r"^&H([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$", str(col or ""))
    if not m:
        return ""
    return "#%s%s%s" % (m.group(4), m.group(3), m.group(2))


def _tpl_width(txts, font, size, look):
    """How wide the phrase is on the screen (the metrics of the font)."""
    sp = _text_w(" ", font, size) + size * look["spacing"]
    w = 0.0
    for x in txts:
        x = x.lstrip(EM)
        w += _text_w(x, font, size) + len(x) * size * look["spacing"]
    return w + sp * max(0, len(txts) - 1)


def _tpl_pos(size, width, height, o, bottom):
    """Where the caption block sits: (centre x, centre y)."""
    h = float(height)
    portrait = height > width
    block_h = size * 1.18
    if o.get("y") is not None:
        top = h * o["y"] - block_h
    elif o["pos"] == "middle":
        top = h / 2 - block_h / 2
    elif o["pos"] == "top":
        top = h * 0.08
    elif o["pos"] == "safe":
        top = h - h * (0.30 if portrait else 0.16) - block_h
    else:
        top = h - h * bottom - block_h
    return width / 2.0, top + block_h / 2


def _tpl_words(txts, look, tcol_a, acol_a, spoken=None):
    """The phrase in pieces: [[(colour, text, bigger)]] - one list per word.
    A gradient gives every letter its own colour, the spoken word and the
    *marked* words are in the accent colour."""
    ga, gb = look.get("grad_a"), look.get("grad_b")
    grad = bool(ga and gb)
    total = sum(len(x.lstrip(EM)) for x in txts) or 1
    out = []
    pos = 0
    for j, x in enumerate(txts):
        emph = x.startswith(EM)
        word = x.lstrip(EM)
        if look["upper"]:
            word = word.upper()
        if j == spoken or emph:
            out.append([(acol_a, word, emph)])
            pos += len(word)
            continue
        if grad:
            pieces = []
            for ch in word:
                pieces.append((_ass_color(_mix(ga, gb, pos / float(max(1, total - 1))), tcol_a), ch, False))
                pos += 1
            out.append(pieces)
        else:
            out.append([(tcol_a, word, False)])
            pos += len(word)
    return out


def _tpl_text(pieces):
    """The phrase's text with its colour tags."""
    out = []
    last = None
    for i, word in enumerate(pieces):
        if i:
            out.append(" ")
        for col, txt, big in word:
            if col != last:
                out.append("{\\1c%s&}" % col)
                last = col
            if big:
                out.append("{\\fscx%d\\fscy%d}" % (EMPH_SCALE, EMPH_SCALE))
            out.append(txt)
            if big:
                out.append("{\\fscx100\\fscy100}")
    return "".join(out)


def _tpl_arch(txts, font, size, width, height, o, look, bottom):
    """The words on an upward curve: (centre x, centre y, width, turn)."""
    n = len(txts)
    ws = [_text_w(x.lstrip(EM), font, size) for x in txts]
    sp = _text_w(" ", font, size)
    total = sum(ws) + sp * (n - 1)
    step = math.radians(max(1.0, float(look["arc"])))
    R = (total / float(max(1, n - 1))) / step if n > 1 else 1e6
    cx, cy = _tpl_pos(size, width, height, o, bottom)
    out = []
    for i in range(n):
        a = (i - (n - 1) / 2.0) * step
        out.append((cx + R * math.sin(a), cy - R * (1 - math.cos(a)), ws[i], -math.degrees(a)))
    return out


def _tpl_size(look, width, height, o):
    """The font size of a template (the font's own scale and the editor's size
    slider included) and the font it uses."""
    h = float(height)
    portrait = height > width
    fid = look["font"] if look["font"] in FONTS else "sans"
    font = FONTS[fid]
    K = o["k"] * float((_face(font) or {}).get("scale", 1.0))
    size = max(8, int(round(K * h * (0.050 if portrait else 0.060) * look["size"])))
    return size, font


# Words that must not start a new line (conjunctions) and words that must not
# end one (prepositions/particles that belong to the word after them) - the
# same idea as the BBC and Netflix line-break rules, for Amharic.
_L_NO_START = {"እና", "ግን", "ወይም", "አሊያም", "እንዲሁም", "ስለዚህ", "ስለሆነም",
               "ምክንያቱም", "ወይስ", "በመሆኑም", "እንደነዚህ"}
_L_NO_END = {"በ", "ለ", "የ", "ከ", "ስለ", "እንደ", "ወደ", "ጋር", "ውስጥ", "ላይ", "በኩል"}


def _tpl_rows(txts, font, size, look, max_w):
    """The phrase's words on one line, or on two when they do not fit: the
    break goes to the most balanced point that is also a natural one (never
    before a conjunction, never after a preposition, no one-word last line)."""
    n = len(txts)
    if n < 2 or int(look.get("rows") or 1) < 2:
        return [list(range(n))]
    if _tpl_width(txts, font, size, look) <= max_w:
        return [list(range(n))]
    best, best_cost = None, None
    for k in range(1, n):
        wl = _tpl_width(txts[:k], font, size, look)
        wr = _tpl_width(txts[k:], font, size, look)
        if wl > max_w or wr > max_w:
            continue
        cost = abs(wl - wr) / float(max_w)
        if len(txts) - k == 1 and n > 2:
            cost += 0.60                                   # an orphan word
        if txts[k].lstrip(EM) in _L_NO_START:
            cost += 0.35
        if txts[k - 1].lstrip(EM) in _L_NO_END:
            cost += 0.25
        if best_cost is None or cost < best_cost:
            best, best_cost = k, cost
    if best is None:                                       # nothing fits: the narrowest blocks
        best = min(range(1, n), key=lambda k: max(
            _tpl_width(txts[:k], font, size, look), _tpl_width(txts[k:], font, size, look)))
    return [list(range(best)), list(range(best, n))]


def _tpl_row_y(cy, n, lh, o):
    """The centre y of each line: a block grows upwards from its bottom line
    (subtitles), downwards from the top, and stays centred in the middle."""
    if n < 2:
        return [cy]
    y = o.get("y")
    if o["pos"] == "middle":
        return [cy + (i - (n - 1) / 2.0) * lh for i in range(n)]
    if o["pos"] == "top" or (y is not None and y < 0.5):
        return [cy + i * lh for i in range(n)]
    return [cy - (n - 1 - i) * lh for i in range(n)]


def _row_text(pieces, row, acol_a, spoken=None):
    """One line's text: only its own words; the spoken word in the accent."""
    out = []
    for i in row:
        w = pieces[i]
        if i == spoken:
            out.append([(acol_a, "".join(p[1] for p in w), False)])
        else:
            out.append(w)
    return _tpl_text(out)


def _row_spans(row, g, e, shown):
    """(from, to, spoken word or None) for one line: the spoken word lights up
    while it is said; before its first word and after its last the line stays
    plain, so the reader can already read ahead."""
    n = len(g)
    a, b = row[0], row[-1]
    out = []
    if g[a][1] > shown + 0.001:
        out.append((shown, g[a][1], None))
    for i in row:
        st = max(g[i][1], shown)
        en = g[i + 1][1] if i + 1 < n else e
        if en - st > 0.01:
            out.append((st, en, i))
    if b < n - 1:
        out.append((max(g[b + 1][1], shown), e, None))
    merged = []
    for st, en, sp in out:
        if en - st <= 0.01:
            continue
        if merged and sp is None and merged[-1][2] is None and abs(merged[-1][1] - st) < 0.002:
            merged[-1] = (merged[-1][0], en, None)
        else:
            merged.append((st, en, sp))
    return merged


def mode_small(look):
    return look.get("mode") == "reels"


def _accent_index(g, txts, font, size, look):
    """The word a caption leans on: the one the editor starred (★), else the
    longest (on the screen) — usually the word that carries the meaning."""
    for i, w in enumerate(g):
        if w[0].startswith(EM):
            return i
    widths = [_tpl_width([x], font, size, look) for x in txts]
    return max(range(len(txts)), key=lambda i: widths[i])


def _tpl_reels(g, txts, font, size, look, width, height, o, bottom, tcol_a, acol_a, s0, e):
    """1.73 Reels emphasis: the words before the big one sit small above its
    left edge, the words after it small below its right edge; the big word
    pops in, glowing. (Our own layout, in the spirit of Reels text packs.)"""
    ai = _accent_index(g, txts, font, size, look)
    small = max(8, int(size * 0.62))
    big = int(size * 1.6)
    bw = _tpl_width([txts[ai]], font, big, look)
    if bw > width * 0.84:
        big = max(small + 2, int(big * width * 0.84 / bw))
        bw = _tpl_width([txts[ai]], font, big, look)
    before, after = txts[:ai], txts[ai + 1:]
    cx, cy = _tpl_pos(size, width, height, o, bottom)
    # the block's middle stays where one line would be; rows around it
    yb = cy - big * 0.50 - small * 0.42
    ya = cy + big * 0.50 + small * 0.42
    if not after:
        cy, yb = cy + small * 0.45, cy + small * 0.45 - big * 0.50 - small * 0.42
    if not before:
        cy, ya = cy - small * 0.45, cy - small * 0.45 + big * 0.50 + small * 0.42
    out = []
    fade = "\\fad(160,120)"
    left = cx - bw / 2.0
    right = cx + bw / 2.0
    if before:
        sw = _tpl_width(before, font, small, look)
        an, x = (4, left) if sw <= bw * 1.05 else (5, cx)
        out.append("Dialogue: 0,%s,%s,R,,0,0,0,,%s{\\an%d\\pos(%d,%d)\\fs%d%s}%s" % (
            _ts(s0), _ts(e), IN, an, round(x), round(yb), small, fade, " ".join(t.lstrip(EM) for t in before)))
    # the big word: pops in (a little blur that sharpens), in the accent colour
    pop = "\\fscx45\\fscy45\\blur5\\t(0,200,0.55,\\fscx112\\fscy112\\blur0)\\t(200,300,1.3,\\fscx100\\fscy100)"
    out.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)\\fs%d\\1c%s&\\fad(90,120)%s}%s" % (
        _ts(s0), _ts(e), IN, round(cx), round(cy), big, acol_a, pop, txts[ai].lstrip(EM)))
    if after:
        sw = _tpl_width(after, font, small, look)
        an, x = (6, right) if sw <= bw * 1.05 else (5, cx)
        out.append("Dialogue: 0,%s,%s,R,,0,0,0,,%s{\\an%d\\pos(%d,%d)\\fs%d%s}%s" % (
            _ts(s0), _ts(e), _cont(0), an, round(x), round(ya), small, fade, " ".join(t.lstrip(EM) for t in after)))
    return out


def _kinetic_rows(n):
    """How many words on each row of a kinetic block (at most 3 rows)."""
    r = min(3, n)
    base, extra = divmod(n, r)
    return [base + (1 if i < extra else 0) for i in range(r)]


def _tpl_kinetic(g, txts, font, size, look, width, height, o, bottom, tcol_a, acol_a, s0, e):
    """1.73 kinetic typography: the caption as 1-3 rows, each row scaled so
    every row is exactly as wide as the block — short words become big. The
    row with the word the caption leans on is in the accent colour. Rows open
    one after the other (stretched in from flat)."""
    counts = _kinetic_rows(len(txts))
    rows, k = [], 0
    for c in counts:
        rows.append(list(range(k, k + c)))
        k += c
    target = width * (0.62 if height > width else 0.44)
    sizes, widths = [], []
    for r in rows:
        w = _tpl_width([txts[i] for i in r], font, size, look) or 1.0
        f = max(0.55, min(2.6, target / w))
        sizes.append(size * f)
        widths.append(w * f)
    gap = size * 0.06
    total = sum(sz * 0.98 for sz in sizes) + gap * (len(rows) - 1)
    room = height * 0.40
    if total > room:
        f = room / total
        sizes = [sz * f for sz in sizes]
        total = room
    ai = _accent_index(g, txts, font, size, look)
    cx, cy = _tpl_pos(size, width, height, o, bottom)
    # the block ends where a one-line caption would end
    top = cy + size * 0.59 - total
    if top < height * 0.04:
        top = height * 0.04
    out = []
    y = top
    for n, (r, sz) in enumerate(zip(rows, sizes)):
        h = sz * 0.98
        col = acol_a if ai in r else tcol_a
        delay = int(70 * n)
        ent = "\\fscy6\\t(%d,%d,0.45,\\fscy100)" % (delay, delay + 210)
        alpha = "\\alpha&HFF&\\t(%d,%d,\\alpha&H00&)" % (delay, delay + 1)
        out.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)\\fs%d\\1c%s&\\fad(0,140)%s%s}%s" % (
            _ts(s0), _ts(e), IN if n == 0 else _cont(0), round(cx), round(y + h / 2.0), max(8, int(round(sz))),
            col, alpha, ent, " ".join(txts[i].lstrip(EM) for i in r)))
        y += h + gap
    return out


def _tpl_script(words, look, width, height, o):
    """Draw a caption template. Returns (dialogue lines, style lines)."""
    h = float(height)
    portrait = height > width
    size, font = _tpl_size(look, width, height, o)
    # a very long word must still fit the frame: then everything gets smaller
    widest = max([_tpl_width([w[0].lstrip(EM)], font, size, look) for w in words] + [1])
    if widest > width * 0.86:
        size = max(8, int(size * width * 0.86 / widest))
    tcol = look["text"]
    acol = look["accent"]
    tcol_a = o["text"] or _ass_color(tcol, WHITE)
    acol_a = o["color"] or _ass_color(acol, YELLOW)
    acol_hex = _ass_hex(acol_a) or acol
    bord = size * look["outline_w"]
    shad = size * look["shadow_w"]
    spc = size * look["spacing"]
    align = {"center": 2, "left": 1, "right": 3}.get(look["align"], 2)
    ml = mr = round(width * 0.06)
    mv = round(h * (0.24 if portrait else 0.10))
    bold = -1 if look["bold"] else 0
    styles = ["Style: S,%s,%d,%s,%s,%s,%s,%d,0,0,0,100,100,%.1f,0,1,%.1f,%.1f,%d,%d,%d,%d,1" % (
        font, size, tcol_a, acol_a, _ass_color(look["outline"], BLACK), _ass_color(look["shadow"], BLACK),
        bold, spc, bord, shad, align, ml, mr, mv)]
    if mode_small(look):
        # the small words of a Reels caption: like S, never glowing
        styles.append(styles[0].replace("Style: S,", "Style: R,", 1))
    if look["glow"]:
        styles.append("Style: G,%s,%d,&HFF000000,&HFF000000,%s,&H00000000,%d,0,0,0,100,100,%.1f,0,1,%.1f,0,%d,%d,%d,%d,1" % (
            font, size, _ass_color(look["glow"], CYAN), bold, spc, size * look["glow_w"], align, ml, mr, mv))
    box_col = look["box"] or ("#000000" if o["box"] else "")
    if box_col:
        bc = _ass_color_a(box_col, look["box_a"], BLACK)
        styles.append("Style: B,%s,%d,%s,%s,%s,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1" % (
            font, size, bc, bc, bc))
        if look["mode"] == "chip":
            ac = _ass_color_a(acol_hex, 1.0, BLACK)
            styles.append("Style: C,%s,%d,%s,%s,%s,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1" % (
                font, size, ac, ac, ac))
    mode = look["mode"]
    NW = 1 if mode == "word" else (o["words"] or look["words"])
    groups = _phrases(words, NW, o)
    bottom = 0.24 if portrait else 0.10
    lines = []
    for g, (s0, e) in zip(groups, _spans(groups)):
        txts = [w[0] for w in g]
        if mode == "line":
            cx, cy = _tpl_pos(size, width, height, o, bottom)
            rows = _tpl_rows(txts, font, size, look, width * float(look["wrap"]))
            nrows = len(rows)
            lh = size * float(look["line_gap"])
            ys = _tpl_row_y(cy, nrows, lh, o)
            exit_ms = int(look["exit"] or 0)
            stagger = float(look["stagger"] or 0.0) if nrows > 1 else 0.0
            fade = ("\\fad(0,%d)" % exit_ms) if exit_ms > 0 else ""
            if box_col:
                pad = size * look["box_pad"]
                bw = max(_tpl_width([txts[i] for i in r], font, size, look) for r in rows) + 2 * pad
                bh = (nrows - 1) * lh + size * 1.24 + 2 * pad
                by = (min(ys) + max(ys)) / 2.0
                lines.append("Dialogue: 0,%s,%s,B,,0,0,0,,%s{\\an7\\pos(%d,%d)\\bord0\\shad0%s\\p1}%s" % (
                    _ts(s0), _ts(e), IN, round(cx - bw / 2), round(by - bh / 2), fade,
                    _pill(bw, bh, size * look["box_r"])))
            if look["hl"] == "fill" and nrows == 1:
                # one line for the whole phrase: \kf sweeps the colour across
                parts, t = [], s0
                for w, x in zip(g, txts):
                    lead = max(0.0, w[1] - t)
                    if lead >= 0.01:
                        parts.append("{\\k%d}" % round(lead * 100))
                    parts.append("{\\kf%d}%s " % (max(1, round((w[2] - w[1]) * 100)), x.lstrip(EM)))
                    t = w[2]
                body = "".join(parts).strip()
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)}%s" % (
                    _ts(s0), _ts(e), IN, round(cx), round(cy), body))
                continue
            pieces = _tpl_words(txts, look, tcol_a, acol_a)
            for r, row in enumerate(rows):
                y = round(ys[r])
                shown = s0 + stagger * r
                if shown > e - 0.05:                  # a very short cue: no room to stagger
                    shown, y = s0, round(cy)
                pos = "{\\an5\\pos(%d,%d)%s}" % (round(cx), y, fade)
                if look["hl"] == "none":
                    lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s%s" % (
                        _ts(shown), _ts(e), IN + pos, "", _row_text(pieces, row, acol_a)))
                    continue
                # the spoken word is marked: the lines are drawn again per word
                for st, en, spoken in _row_spans(row, g, e, shown):
                    body = _row_text(pieces, row, acol_a, spoken)
                    lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s%s" % (
                        _ts(st), _ts(en),
                        (IN + pos) if st <= shown + 0.001 else (_cont(st - shown) + pos), "", body))
        elif mode == "reveal":
            cx, cy = _tpl_pos(size, width, height, o, bottom)
            parts = []
            for w, x in zip(g, txts):
                t = max(0, int(round((w[1] - s0) * 1000)))
                parts.append("{\\alpha&HFF&\\t(%d,%d,\\alpha&H00&)}%s" % (t, t + 140, x.lstrip(EM)))
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)\\fad(0,90)}%s" % (
                _ts(s0), _ts(e), IN, round(cx), round(cy), " ".join(parts)))
        elif mode == "word":
            cx, cy = _tpl_pos(size, width, height, o, bottom)
            for i, w in enumerate(g):
                x = w[0]
                big = x.startswith(EM)
                col = acol_a if big else tcol_a
                tag = "{\\1c%s&}" % col
                if big:
                    tag += "{\\fscx%d\\fscy%d}" % (EMPH_SCALE, EMPH_SCALE)
                anim = ("{\\fad(90,70)\\fscx78\\fscy78\\t(0,200,0.6,\\fscx104\\fscy104)"
                        "\\t(200,300,1.4,\\fscx100\\fscy100)}")
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)}%s%s%s" % (
                    _ts(s0), _ts(e), IN + anim, round(cx), round(cy), tag, x.lstrip(EM),
                    "{\\fscx100\\fscy100}" if big else ""))
        elif mode == "chip":
            places = _place(txts, font, size, width, height, o, bottom, gap=0.9)
            pad = size * look["box_pad"]
            for i, x in enumerate(txts):
                cx, cy, tw = places[i]
                pw = tw + 2 * pad
                ph = size * 1.10
                lines.append("Dialogue: 0,%s,%s,B,,0,0,0,,%s{\\an7\\pos(%d,%d)\\bord0\\shad0\\fad(110,80)\\p1}%s" % (
                    _ts(s0), _ts(e), IN if i == 0 else _cont(0),
                    round(cx - pw / 2), round(cy - ph / 2), _pill(pw, ph, ph * 0.32)))
            for i, w in enumerate(g):
                ws = s0 if i == 0 else w[1]
                we = g[i + 1][1] if i + 1 < len(g) else e
                if we <= ws:
                    continue
                cx, cy, tw = places[i]
                pw = tw + 2 * pad
                ph = size * 1.10
                lines.append("Dialogue: 1,%s,%s,C,,0,0,0,,%s{\\an7\\pos(%d,%d)\\bord0\\shad0\\p1}%s" % (
                    _ts(ws), _ts(we), _cont(ws - s0),
                    round(cx - pw / 2), round(cy - ph / 2), _pill(pw, ph, ph * 0.32)))
            for i, x in enumerate(txts):
                cx, cy, tw = places[i]
                lines.append("Dialogue: 2,%s,%s,S,,0,0,0,,%s{\\an5\\pos(%d,%d)\\fad(110,80)}%s" % (
                    _ts(s0), _ts(e), IN if i == 0 else _cont(0), round(cx), round(cy), x.lstrip(EM)))
        elif mode == "reels":
            lines += _tpl_reels(g, txts, font, size, look, width, height, o, bottom, tcol_a, acol_a, s0, e)
        elif mode == "kinetic":
            lines += _tpl_kinetic(g, txts, font, size, look, width, height, o, bottom, tcol_a, acol_a, s0, e)
        else:  # arch
            places = _tpl_arch(txts, font, size, width, height, o, look, bottom)
            for i, w in enumerate(g):
                ws = s0 if i == 0 else w[1]
                we = g[i + 1][1] if i + 1 < len(g) else e
                if we <= ws:
                    continue
                cells = []
                for j, x in enumerate(txts):
                    cx, cy, tw, rot = places[j]
                    col = acol_a if j == i else tcol_a
                    cells.append("{\\1c%s&\\an5\\pos(%d,%d)\\frz%.2f}%s" % (
                        col, round(cx), round(cy), rot, x.lstrip(EM)))
                body = " ".join(cells)
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (
                    _ts(ws), _ts(we), (IN + "{\\an5}") if i == 0 else _cont(ws - s0), body))
    if look["glow"]:
        # the glow layer: the same text, blurred and thick-outlined, behind the
        # words (the same trick the neon style uses)
        blur = size * 0.18
        halo = []
        for line in lines:
            head, sep, text = line.partition(",,0,0,0,,")
            if not sep or not head.endswith(",S"):
                continue
            # the phrase's start / redraw mark stays in FRONT (1.73): the
            # entrance then animates the glow too, and the mark itself is
            # removed (before, it was drawn as a box and a number)
            m = _CONT.match(text)
            mark = m.group(0) if m else (IN if text.startswith(IN) else "")
            halo.append(head[:-2] + ",G" + sep + mark + "{\\blur%.1f}" % blur + text[len(mark):])
        lines = halo + lines
    return lines, "\n".join(styles)


TAG_TEXT = "Amharic Captions Pro"


def _tag_line(width, height, start, end):
    """The free version's small tag in the top corner (paid: none)."""
    size = max(12, round(min(width, height) * 0.028))
    return ("Dialogue: 5,%s,%s,S,,0,0,0,,{\\an9\\pos(%d,%d)\\fs%d\\bord%.1f\\shad0\\1c&H00FFFFFF&\\3c&H00000000&"
            "\\alpha&H30&\\fn%s}%s") % (_ts(start), _ts(end), width - round(width * 0.03), round(height * 0.03),
                                       size, size * 0.08, FONT, TAG_TEXT)


def plan(cues):
    """(t0, duration, words shifted to t0): the overlay covers only the
    captions (from a moment before the first to a moment after the last)."""
    words = words_from_cues(cues)
    if not words:
        return 0.0, 0.0, []
    t0 = max(0.0, words[0][1] - 0.25)
    dur = words[-1][2] - t0 + 0.6
    return t0, dur, [(w[0], w[1] - t0, w[2] - t0) for w in words]


def _overlay_codec(job):
    """ffmpeg codec args for the transparent caption layer (.mov).

    Windows: QuickTime Animation (qtrle, argb) - Premiere on Windows shows it
    right. Mac: ProRes 4444 with alpha - Premiere on Apple Silicon decoded
    qtrle as smeared streaks (customer screenshot, 1.16.7). job["codec"]
    ("qtrle" / "prores") overrides, for tests."""
    want = job.get("codec") or ("prores" if sys.platform == "darwin" else "qtrle")
    if want == "prores" and _has_encoder(job["ffmpeg"], "prores_ks"):
        return ["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
                "-alpha_bits", "16", "-vendor", "apl0"]
    return ["-c:v", "qtrle", "-pix_fmt", "argb"]


def _caption_band(ffmpeg, tmp, w, h, dur):
    """The preview shows only the strip of the frame where the captions are
    (wide and short), so it is small in the panel and the words are big.
    A quick pass draws the captions alone to find that strip (any style, any
    position); returns ffmpeg's crop for it, or "" to keep the whole frame."""
    import subprocess
    try:
        raw = subprocess.run([ffmpeg, "-v", "error", "-f", "lavfi", "-i",
                              "color=c=black@0.0:s=%dx%d:r=8:d=%.3f,format=rgba" % (w, h, dur),
                              "-vf", "subtitles=band.ass:fontsdir=fonts:alpha=1,alphaextract",
                              "-f", "rawvideo", "-pix_fmt", "gray", "-"], cwd=tmp, capture_output=True, timeout=60).stdout
    except Exception:
        return ""
    n = w * h
    rows = [False] * h
    cols = bytearray(w)
    for k in range(len(raw) // n):
        f = raw[k * n:(k + 1) * n]
        for y in range(h):
            line = f[y * w:(y + 1) * w]
            if max(line) > 40:
                rows[y] = True
                for x in range(w):
                    if line[x] > 40:
                        cols[x] = 1
    ink = [y for y in range(h) if rows[y]]
    if not ink:
        return ""
    xs = [x for x in range(w) if cols[x]]
    # a 3:1 box around the captions, drawn back at the full preview width. The
    # zoom is fixed per frame shape (landscape captions are small, so they are
    # zoomed more) - it grows only when the captions would not fit - so the
    # Size option still shows in the preview.
    pad = round(min(w, h) * 0.05)
    bw = max(xs[-1] - xs[0] + 2 * pad, (ink[-1] - ink[0] + 2 * pad) * 3, w * (1.0 if h > w else 0.45))
    bw = min(w, bw)
    bh = round(bw / 3.0)
    if bh >= h * 0.9:
        return ""
    bw, bh = int(bw) // 2 * 2, int(bh) // 2 * 2
    x0 = int(min(max(0, (xs[0] + xs[-1]) / 2.0 - bw / 2.0), w - bw)) // 2 * 2
    y0 = int(min(max(0, (ink[0] + ink[-1]) / 2.0 - bh / 2.0), h - bh)) // 2 * 2
    out_h = int(round(w / 3.0)) // 2 * 2
    return ",crop=%d:%d:%d:%d,scale=%d:%d:flags=lanczos" % (bw, bh, x0, y0, w, out_h)


def render(job, progress=None):
    """Render styled captions with ffmpeg. job: {cues, style, width, height,
    fps, out, ffmpeg, fonts, mode: "overlay" | "burn" | "script", video, tag}.
    overlay: a transparent QuickTime Animation .mov covering the captions only;
    returns {t0, duration}. burn: the video with the captions drawn in (MP4).
    script (1.25.0): only the ASS script, written to out (width, height and
    duration given) - the Studio draws it in its own single render.
    The ASS script and the fonts sit in a temp folder that ffmpeg runs in, so
    no Windows path ever has to be escaped inside the filter."""
    import shutil
    import subprocess
    import tempfile
    style, mode = job["style"], job.get("mode", "overlay")
    if mode == "burn" and not (job.get("width") and job.get("height")):
        pw, ph, pdur = probe(job["ffmpeg"], job["video"])
        job = dict(job, width=pw, height=ph, duration=job.get("duration") or pdur)
    w, h = int(job["width"]), int(job["height"])
    fps = float(job.get("fps") or 30)
    if mode in ("burn", "script"):
        t0, words = 0.0, words_from_cues(job["cues"])
        dur = float(job.get("duration") or (words[-1][2] if words else 0))
    else:
        t0, dur, words = plan(job["cues"])
    if mode == "preview":
        # A few seconds of the first captions, small, on a neutral background:
        # an animated picture the panel can show while the editor customizes.
        words = [x for x in words if x[1] < PREVIEW_SECS]
        dur = min(PREVIEW_SECS + 0.4, (words[-1][2] + 0.5) if words else 0)
        scale = PREVIEW_PX / float(w)          # the full width: only the caption strip is kept
        w, h = max(2, int(w * scale) // 2 * 2), max(2, int(h * scale) // 2 * 2)
        fps = 15
    if not words:
        raise ValueError("no captions to style")
    global _SPAN_LOG
    _SPAN_LOG = []
    try:
        script = build(words, style, w, h, opts=job.get("opts"))
        spans = sorted((round(a, 3), round(b, 3)) for a, b in _SPAN_LOG)
    finally:
        _SPAN_LOG = None
    captions_only = script
    if job.get("tag"):
        script += _tag_line(w, h, 0, dur) + "\n"
    if mode == "script":
        with open(job["out"], "w", encoding="utf-8") as f:
            f.write(script)
        return {"t0": 0.0, "duration": round(dur, 3), "out": job["out"]}
    used_video = False          # preview over the real footage (falls back to the gradient)
    tmp = tempfile.mkdtemp(prefix="amh_style_")
    try:
        with open(os.path.join(tmp, "c.ass"), "w", encoding="utf-8") as f:
            f.write(script)
        with open(os.path.join(tmp, "band.ass"), "w", encoding="utf-8") as f:
            f.write(captions_only)          # the preview strip is found without the free tag
        os.makedirs(os.path.join(tmp, "fonts"))
        for name in os.listdir(job["fonts"]):
            if name.lower().endswith((".ttf", ".otf")):
                shutil.copy(os.path.join(job["fonts"], name), os.path.join(tmp, "fonts", name))
        out = os.path.abspath(job["out"])
        if mode == "burn":
            cmd = [job["ffmpeg"], "-y", "-v", "error", "-i", os.path.abspath(job["video"]),
                   "-vf", "subtitles=c.ass:fontsdir=fonts", "-c:v", "libx264", "-preset", "veryfast",
                   "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart"]
        elif mode == "preview":
            bg = "gradients=s=%dx%d:c0=0x2a3646:c1=0x0b1110:x0=0:y0=0:x1=%d:y1=%d:speed=0:r=%d:d=%.3f" % (w, h, w, h, fps, dur)
            webp = _has_encoder(job["ffmpeg"], "libwebp_anim")
            # The editor's own footage behind the captions when we know it
            # (1.16.14): job["video"] + job["videoOffset"] (source seconds =
            # caption seconds + offset). Any trouble -> the plain background.
            src_in = ["-f", "lavfi", "-i", bg]
            pre = ""
            vid = job.get("video")
            if vid and os.path.isfile(vid):
                used_video = True
                start = max(0.0, t0 + float(job.get("videoOffset") or 0))
                src_in = ["-ss", "%.3f" % start, "-t", "%.3f" % dur, "-i", os.path.abspath(vid), "-an"]
                pre = ("scale=%d:%d:force_original_aspect_ratio=increase,crop=%d:%d,fps=%d,setsar=1,"
                       "eq=brightness=-0.06,format=yuv420p,") % (w, h, w, h, fps)
            cmd = [job["ffmpeg"], "-y", "-v", "error"] + src_in + [
                   "-vf", pre + "subtitles=c.ass:fontsdir=fonts" + _caption_band(job["ffmpeg"], tmp, w, h, dur) +
                   ("" if webp else ",split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse")]
            cmd += (["-c:v", "libwebp_anim", "-loop", "0", "-quality", "72", "-compression_level", "3", "-f", "webp"] if webp
                    else ["-loop", "0", "-f", "gif"])
            out = os.path.splitext(out)[0] + (".webp" if webp else ".gif")
        else:
            cmd = [job["ffmpeg"], "-y", "-v", "error", "-f", "lavfi",
                   "-i", "color=c=black@0.0:s=%dx%d:r=%s:d=%.3f,format=rgba" % (w, h, ("%.5f" % fps).rstrip("0").rstrip("."), dur),
                   "-vf", "subtitles=c.ass:fontsdir=fonts:alpha=1"] + _overlay_codec(job)
        cmd += ["-progress", "pipe:1", "-nostats", out]
        proc = subprocess.Popen(cmd, cwd=tmp, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, encoding="utf-8", errors="replace")
        for line in proc.stdout:
            if line.startswith("out_time_us=") and progress and dur > 0:
                try:
                    progress(min(0.99, int(line.split("=")[1]) / 1e6 / dur))
                except ValueError:
                    pass
        err = proc.stderr.read()
        if proc.wait() != 0 or not os.path.exists(out) or (used_video and os.path.getsize(out) < 200):
            if not used_video:
                raise RuntimeError("ffmpeg could not draw the styled captions: " + err.strip()[-300:])
        else:
            return {"t0": round(t0, 3), "duration": round(dur, 3), "out": out, "spans": [list(x) for x in spans]}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    # the footage could not be read (audio-only file, odd codec): plain background
    return render(dict(job, video=None), progress)


PREVIEW_SECS = 4.5      # the preview shows the first seconds of captions
PREVIEW_PX = 480        # its long side, in pixels


def _has_encoder(ffmpeg, name):
    import subprocess
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, timeout=20,
                             universal_newlines=True, encoding="utf-8", errors="replace").stdout
        return (" %s " % name) in out
    except Exception:
        return False


def probe(ffmpeg, video):
    """(width, height, seconds) of a video, read from ffmpeg's own report
    (the bundled runtime has no ffprobe). Rotated phone videos report the
    turned size."""
    import subprocess
    err = subprocess.run([ffmpeg, "-hide_banner", "-i", video], capture_output=True, universal_newlines=True,
                         encoding="utf-8", errors="replace").stderr
    m = re.search(r"Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})", err)
    if not m:
        raise RuntimeError("could not read the video size")
    w, h = int(m.group(1)), int(m.group(2))
    if re.search(r"rotate\s*:\s*-?(90|270)|rotation of -?(90|270)", err):
        w, h = h, w
    d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    secs = int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3)) if d else 0.0
    return w, h, secs


def supported(ffmpeg):
    """True when this ffmpeg can draw ASS captions (libass)."""
    import subprocess
    try:
        out = subprocess.run([ffmpeg, "-hide_banner", "-filters"], capture_output=True, timeout=20,
                             universal_newlines=True, encoding="utf-8", errors="replace").stdout
        return " subtitles " in out
    except Exception:
        return False


if __name__ == "__main__":
    # python amh_styles.py render job.json  -> "[style] <0..1>" lines, then one JSON line
    if len(sys.argv) == 3 and sys.argv[1] == "render":
        try:
            job = json.load(open(sys.argv[2], encoding="utf-8"))
            res = render(job, lambda x: print("[style] %.3f" % x, flush=True))
            print(json.dumps(dict(res, ok=True)), flush=True)
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)
            sys.exit(1)
    if len(sys.argv) == 3 and sys.argv[1] == "install-fonts":
        try:
            print(json.dumps(dict(install_fonts(sys.argv[2]), ok=True)), flush=True)
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)
            sys.exit(1)
    if len(sys.argv) == 3 and sys.argv[1] == "supported":
        print(json.dumps({"ok": supported(sys.argv[2])}))
        sys.exit(0)
    if len(sys.argv) == 6:
        ws = [tuple(w) for w in json.load(open(sys.argv[1], encoding="utf-8"))]
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            f.write(build(ws, sys.argv[2], int(sys.argv[4]), int(sys.argv[5])))
        sys.exit(0)
    print(__doc__)
