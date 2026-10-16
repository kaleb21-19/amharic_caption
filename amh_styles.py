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
}


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


def _phrases(words, size):
    """Groups of up to `size` words; a long pause starts a new group."""
    out, cur = [], []
    for w in words:
        if cur and (len(cur) >= size or w[1] - cur[-1][2] > GAP_HOLD):
            out.append(cur)
            cur = []
        cur.append(w)
    if cur:
        out.append(cur)
    return out


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
ANIMS = ("auto", "none", "fade", "slide", "drop", "pop", "zoom", "blur")


def _ass_color(hexrgb, default):
    """'#RRGGBB' -> ASS '&H00BBGGRR' (default when missing or not a colour)."""
    m = re.match(r"^#?([0-9a-fA-F]{6})$", str(hexrgb or ""))
    if not m:
        return default
    v = m.group(1).upper()
    return "&H00%s%s%s" % (v[4:6], v[2:4], v[0:2])


def options(opts):
    """Clean customize options: colour (the highlight), text, size s/m/l/xl,
    pos bottom/middle/top/safe, words 1-5 (0 = the style's own), box,
    font (an id of FONTS), anim (an entrance of ANIMS)."""
    o = opts or {}
    words = o.get("words")
    try:
        words = int(words)
    except (TypeError, ValueError):
        words = 0
    return {
        "color": _ass_color(o.get("color"), None),
        "text": _ass_color(o.get("text"), None),
        "size": o.get("size") if o.get("size") in SIZES else "m",
        "pos": o.get("pos") if o.get("pos") in POSITIONS else "bottom",
        "words": words if 1 <= words <= 5 else 0,
        "box": bool(o.get("box")),
        "font": o.get("font") if o.get("font") in FONTS else "sans",
        "anim": o.get("anim") if o.get("anim") in ANIMS else "auto",
        "emph": "off" if o.get("emph") == "off" else "auto",
    }


def _apply_layout(script, style, width, height, o):
    """Position and box on the finished script (style lines + \\pos tags)."""
    h = float(height)
    portrait = height > width
    pos = o["pos"]
    out = []
    for line in script.split("\n"):
        if line.startswith("Style: "):
            f = line[7:].split(",")
            # f: 0 Name,1 Font,2 Size,3 Prim,4 Sec,5 Outline,6 Back,7 Bold,8 It,9 Und,10 Strike,
            #    11 ScX,12 ScY,13 Spacing,14 Angle,15 BorderStyle,16 Outline,17 Shadow,18 Align,
            #    19 ML,20 MR,21 MV,22 Enc
            if pos == "middle":
                f[18], f[21] = "5", "0"
            elif pos == "top":
                f[18], f[21] = "8", str(round(h * 0.08))
            elif pos == "safe":
                f[18], f[21] = "2", str(round(h * (0.30 if portrait else 0.16)))
            if o["box"] and style not in NO_BOX:
                size = float(f[2])
                f[15], f[5], f[16], f[17] = "3", "&H40000000", "%.1f" % (size * 0.28), "0"
            line = "Style: " + ",".join(f)
        elif line.startswith("Dialogue") and "\\pos(" in line and pos != "bottom" and style not in SELF_PLACED:
            y = {"middle": 0.50, "top": 0.18, "safe": 0.62 if portrait else 0.70}[pos]
            line = re.sub(r"\\pos\((\d+),\d+\)", lambda m: "\\pos(%s,%d)" % (m.group(1), round(h * y)), line, count=1)
        out.append(line)
    return "\n".join(out)


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
    if style not in STYLES:
        raise ValueError("unknown style: %s" % style)
    o = options(opts)
    if font == FONT:
        font = FONTS[o["font"]]
    K = SIZES[o["size"]]
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
        groups = _phrases(words, NW or 3)
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
        groups = _phrases(words, NW or 3)
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
        groups = _phrases(words, NW or 3)
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
        groups = _phrases(words, NW or 1)
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
        groups = _phrases(words, NW or 3)
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
        groups = _phrases(words, NW or 2)
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
        groups = _phrases(words, NW or 3)
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
        groups = _phrases(words, NW or 7)
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
        groups = _phrases(words, NW or 4)
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
        groups = _phrases(words, NW or 2)
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
        groups = _phrases(words, NW or 2)
        for g, (s0, e) in zip(groups, _spans(groups)):
            anim = "{\\fad(110,90)\\yshad0\\xshad0\\t(0,200,0.6,\\xshad%.1f\\yshad%.1f)}" % (size * 0.10, size * 0.10)
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), IN + anim, " ".join(w[0] for w in g)))
    elif style == "cinema":
        size = round(K * h * (0.034 if portrait else 0.042))
        mv = round(h * (0.12 if portrait else 0.07))
        st = "Style: S,%s,%d,&H00F0F0F0,&H00F0F0F0,&H00000000,&H96000000,0,0,0,0,100,100,2.5,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, size * 0.04, size * 0.08, round(width * 0.10), round(width * 0.10), mv)
        groups = _phrases(words, NW or 6)
        for g, (s0, e) in zip(groups, _spans(groups)):
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,\x02{\\fad(260,220)\\blur0.8}%s" % (_ts(s0), _ts(e), " ".join(w[0] for w in g)))
    elif style == "pop":
        size = round(K * h * (0.072 if portrait else 0.085))
        mv = round(h * (0.28 if portrait else 0.12))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.10, size * 0.05, round(width * 0.05), round(width * 0.05), mv)
        groups = _phrases(words, NW or 2)
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
        groups = _phrases(words, NW or 5)
        for g, (s, e) in zip(groups, _spans(groups)):
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,\x02{\\fad(140,120)}%s" % (_ts(s), _ts(e), " ".join(w[0] for w in g)))
    lines = _entrances(lines, o["anim"], st, width, height)
    lines = _emphasis_tags(lines, st)
    script = _header(width, height, st) + "\n".join(_smooth_fades(lines)) + "\n"
    # colours: the highlight (yellow / green / cyan in the styles) and the text
    if o["color"] and style != "habesha":
        for c in (YELLOW, LIME, CYAN, VIOLET, SPOT):
            script = script.replace(c, o["color"])
    if o["text"]:
        script = script.replace(WHITE, o["text"])
    return _apply_layout(script, style, width, height, o)


_FAD = re.compile(r"\\fad\((\d+),(\d+)\)")

IN = "\x02"                    # marks the line where a phrase appears
_CONT = re.compile("\x03(\\d+)\x04")


def _cont(secs):
    """Marks a redraw of a phrase that appeared `secs` ago (word-by-word
    styles draw the same phrase again for every word)."""
    return "\x03%d\x04" % max(0, int(round(secs * 1000)))


def _anim_spec(anim, size, width, height):
    """(fade-in ms, start tags, [(t1, t2, accel, end tags)]) of an entrance.
    Slides ease out: the text turns a tiny angle around a point far to the
    left, so it moves straight up/down (libass \\move cannot ease)."""
    if anim == "fade":
        return 220, "", []
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
    size = float(st.split("\n")[0][7:].split(",")[2])
    fade_in, start, steps = _anim_spec(anim, size, width, height)
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
        if anim == "blur":
            tags = tags.replace("\\blur%s", "\\blur%g" % (base + 10), 1).replace("\\blur%s", "\\blur%g" % base, 1) \
                if off < total else tags + ("\\blur%g" % base if base else "")
        elif base:
            tags += "\\blur%g" % base
        out.append(head + ",,0,0,0,," + ("{" + block + tags + "}" if block + tags else "") + rest)
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
    row_h = size * 1.18
    block_h = row_h * len(rows)
    h = float(height)
    portrait = height > width
    if o["pos"] == "middle":
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
    groups = _phrases(words, NW or {"glide": 3, "spotlight": 4, "bounce": 3}[style])
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
    fps, out, ffmpeg, fonts, mode: "overlay" | "burn", video, tag}.
    overlay: a transparent QuickTime Animation .mov covering the captions only;
    returns {t0, duration}. burn: the video with the captions drawn in (MP4).
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
    if mode == "burn":
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
    script = build(words, style, w, h, opts=job.get("opts"))
    captions_only = script
    if job.get("tag"):
        script += _tag_line(w, h, 0, dur) + "\n"
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
            return {"t0": round(t0, 3), "duration": round(dur, 3), "out": out}
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
    if len(sys.argv) == 3 and sys.argv[1] == "supported":
        print(json.dumps({"ok": supported(sys.argv[2])}))
        sys.exit(0)
    if len(sys.argv) == 6:
        ws = [tuple(w) for w in json.load(open(sys.argv[1], encoding="utf-8"))]
        with open(sys.argv[3], "w", encoding="utf-8") as f:
            f.write(build(ws, sys.argv[2], int(sys.argv[4]), int(sys.argv[5])))
        sys.exit(0)
    print(__doc__)
