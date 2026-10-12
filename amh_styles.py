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

Styles:
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
import re
import sys

STYLES = ("karaoke", "fill", "highlight", "bold", "podcast", "reveal", "typewriter", "pop", "word", "impact",
          "neon", "retro", "habesha", "cinema", "clean")
YELLOW = "&H0000E5FF"
BLACK = "&H00000000"
GREEN = "&H0071CC2E"
RED = "&H004A44F0"
CYAN = "&H00FFF04D"
LIME = "&H0014FF39"
WHITE = "&H00FFFFFF"
GAP_HOLD = 0.6     # a pause shorter than this keeps the phrase on screen
MIN_SHOW = 0.45    # a phrase shows at least this long
FONT = "Noto Sans Ethiopic"


def _ts(t):
    t = max(0.0, float(t))
    cs = int(round(t * 100))
    return "%d:%02d:%02d.%02d" % (cs // 360000, cs // 6000 % 60, cs // 100 % 60, cs % 100)


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
NO_BOX = ("highlight", "neon", "retro", "clean")


def _ass_color(hexrgb, default):
    """'#RRGGBB' -> ASS '&H00BBGGRR' (default when missing or not a colour)."""
    m = re.match(r"^#?([0-9a-fA-F]{6})$", str(hexrgb or ""))
    if not m:
        return default
    v = m.group(1).upper()
    return "&H00%s%s%s" % (v[4:6], v[2:4], v[0:2])


def options(opts):
    """Clean customize options: colour (the highlight), text, size s/m/l/xl,
    pos bottom/middle/top/safe, words 1-5 (0 = the style's own), box."""
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
        elif line.startswith("Dialogue") and "\\pos(" in line and pos != "bottom":
            y = {"middle": 0.50, "top": 0.18, "safe": 0.62 if portrait else 0.70}[pos]
            line = re.sub(r"\\pos\((\d+),\d+\)", lambda m: "\\pos(%s,%d)" % (m.group(1), round(h * y)), line, count=1)
        out.append(line)
    return "\n".join(out)


def build(words, style, width, height, font=FONT, opts=None):
    """The ASS script for `words` [(text, start, end)] in `style`, for a
    frame of width x height (sizes scale with the frame), customized by
    `opts` (see options())."""
    if style not in STYLES:
        raise ValueError("unknown style: %s" % style)
    o = options(opts)
    K = SIZES[o["size"]]
    NW = o["words"]
    words = [(_clean(w[0]), float(w[1]), float(w[2])) for w in words if _clean(w[0])]
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
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s), _ts(e), intro, "".join(parts).strip()))
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
                    _ts(ws), _ts(we), intro if i == 0 else "", txt))
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
                    _ts(ws), _ts(we), "{\\fad(120,0)}" if i == 0 else "", txt))
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
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,{\\fad(0,90)}%s" % (_ts(s0), _ts(e), " ".join(parts)))
    elif style == "word":
        size = round(K * h * (0.085 if portrait else 0.095))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,5,%d,%d,0,1" % (
            font, size, WHITE, WHITE, size * 0.10, size * 0.05, round(width * 0.05), round(width * 0.05))
        groups = _phrases(words, NW or 1)
        for k, (g, (s0, e)) in enumerate(zip(groups, _spans(groups))):
            col = YELLOW if k % 3 == 2 else WHITE
            anim = ("{\\1c%s&\\pos(%d,%d)\\fscx86\\fscy86\\t(0,160,0.6,\\fscx106\\fscy106)"
                    "\\t(160,260,1.3,\\fscx100\\fscy100)}") % (col, width // 2, round(h * (0.62 if portrait else 0.75)))
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), anim, g[0][0]))
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
            lines.append("Dialogue: 0,%s,%s,H,,0,0,0,,{%s\\blur16\\fad(0,140)}%s" % (_ts(s0), _ts(e), flick.replace("H20", "H70").replace("H00&)", "H60&)"), txt))
            lines.append("Dialogue: 1,%s,%s,G,,0,0,0,,{%s\\blur5\\fad(0,140)}%s" % (_ts(s0), _ts(e), flick, txt))
            lines.append("Dialogue: 2,%s,%s,S,,0,0,0,,{%s\\blur0.6\\fad(0,140)}%s" % (_ts(s0), _ts(e), flick, txt))
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
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), anim, " ".join(parts)))
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
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(ws), _ts(we), intro, txt))
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
                lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(ws), _ts(we), "{\\fad(150,0)}" if i == 0 else "", txt))
    elif style == "typewriter":
        size = round(K * h * (0.046 if portrait else 0.056))
        mv = round(h * (0.24 if portrait else 0.10))
        st = "Style: S,%s,%d,%s,%s,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.08, size * 0.04, round(width * 0.06), round(width * 0.06), mv)
        groups = _phrases(words, NW or 4)
        for g, (s0, e) in zip(groups, _spans(groups)):
            parts = []
            for w in g:
                t0 = max(0, int(round((w[1] - s0) * 1000)))
                step = max(25, int(round((w[2] - w[1]) * 1000 / max(1, len(w[0])))))
                parts.append("".join("{\\alpha&HFF&\\t(%d,%d,\\alpha&H00&)}%s" % (t0 + k * step, t0 + k * step + 30, ch)
                                     for k, ch in enumerate(w[0])))
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,{\\fad(0,100)}%s" % (_ts(s0), _ts(e), " ".join(parts)))
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
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), anim, " ".join(w[0] for w in g)))
    elif style == "retro":
        size = round(K * h * (0.060 if portrait else 0.070))
        mv = round(h * (0.25 if portrait else 0.11))
        st = "Style: S,%s,%d,&H00F2F7FF,&H00F2F7FF,&H00202020,&H00335CD6,-1,0,0,0,100,100,1,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, size * 0.06, size * 0.13, round(width * 0.05), round(width * 0.05), mv)
        groups = _phrases(words, NW or 2)
        for g, (s0, e) in zip(groups, _spans(groups)):
            anim = "{\\fad(110,90)\\yshad0\\xshad0\\t(0,200,0.6,\\xshad%.1f\\yshad%.1f)}" % (size * 0.10, size * 0.10)
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s0), _ts(e), anim, " ".join(w[0] for w in g)))
    elif style == "cinema":
        size = round(K * h * (0.034 if portrait else 0.042))
        mv = round(h * (0.12 if portrait else 0.07))
        st = "Style: S,%s,%d,&H00F0F0F0,&H00F0F0F0,&H00000000,&H96000000,0,0,0,0,100,100,2.5,0,1,%.1f,%.1f,2,%d,%d,%d,1" % (
            font, size, size * 0.04, size * 0.08, round(width * 0.10), round(width * 0.10), mv)
        groups = _phrases(words, NW or 6)
        for g, (s0, e) in zip(groups, _spans(groups)):
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,{\\fad(260,220)\\blur0.8}%s" % (_ts(s0), _ts(e), " ".join(w[0] for w in g)))
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
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,%s%s" % (_ts(s), _ts(e), anim, " ".join(w[0] for w in g)))
    else:  # clean
        size = round(K * h * (0.042 if portrait else 0.050))
        mv = round(h * (0.16 if portrait else 0.07))
        st = "Style: S,%s,%d,%s,%s,&H50000000,&H50000000,0,0,0,0,100,100,0,0,3,%.1f,0,2,%d,%d,%d,1" % (
            font, size, WHITE, WHITE, size * 0.30, round(width * 0.07), round(width * 0.07), mv)
        groups = _phrases(words, NW or 5)
        for g, (s, e) in zip(groups, _spans(groups)):
            lines.append("Dialogue: 0,%s,%s,S,,0,0,0,,{\\fad(140,120)}%s" % (_ts(s), _ts(e), " ".join(w[0] for w in g)))
    script = _header(width, height, st) + "\n".join(_smooth_fades(lines)) + "\n"
    # colours: the highlight (yellow / green / cyan in the styles) and the text
    if o["color"] and style != "habesha":
        for c in (YELLOW, LIME, CYAN):
            script = script.replace(c, o["color"])
    if o["text"]:
        script = script.replace(WHITE, o["text"])
    return _apply_layout(script, style, width, height, o)


_FAD = re.compile(r"\\fad\((\d+),(\d+)\)")


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
        scale = PREVIEW_PX / float(max(w, h))
        w, h = max(2, int(w * scale) // 2 * 2), max(2, int(h * scale) // 2 * 2)
        fps = 15
    if not words:
        raise ValueError("no captions to style")
    script = build(words, style, w, h, opts=job.get("opts"))
    if job.get("tag"):
        script += _tag_line(w, h, 0, dur) + "\n"
    tmp = tempfile.mkdtemp(prefix="amh_style_")
    try:
        with open(os.path.join(tmp, "c.ass"), "w", encoding="utf-8") as f:
            f.write(script)
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
            cmd = [job["ffmpeg"], "-y", "-v", "error", "-f", "lavfi", "-i", bg,
                   "-vf", "subtitles=c.ass:fontsdir=fonts" + ("" if webp else ",split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse")]
            cmd += (["-c:v", "libwebp_anim", "-loop", "0", "-quality", "72", "-compression_level", "3", "-f", "webp"] if webp
                    else ["-loop", "0", "-f", "gif"])
            out = os.path.splitext(out)[0] + (".webp" if webp else ".gif")
        else:
            cmd = [job["ffmpeg"], "-y", "-v", "error", "-f", "lavfi",
                   "-i", "color=c=black@0.0:s=%dx%d:r=%s:d=%.3f,format=rgba" % (w, h, ("%.5f" % fps).rstrip("0").rstrip("."), dur),
                   "-vf", "subtitles=c.ass:fontsdir=fonts:alpha=1", "-c:v", "qtrle", "-pix_fmt", "argb"]
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
        if proc.wait() != 0 or not os.path.exists(out):
            raise RuntimeError("ffmpeg could not draw the styled captions: " + err.strip()[-300:])
        return {"t0": round(t0, 3), "duration": round(dur, 3), "out": out}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


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
