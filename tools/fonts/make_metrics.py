"""Letter widths of the caption fonts -> metrics.json (shipped with the fonts).

The modern caption styles place every word themselves (a highlight that
glides from word to word, a word that grows without pushing the others), so
they need each word's width exactly as libass will draw it. libass sizes a
font so that usWinAscent + usWinDescent = the ASS font size; one font unit is
then size / (usWinAscent + usWinDescent) pixels (checked against real
renders in tools/test/test_styles.py).

Run after changing a font (needs fontTools, a developer tool only):
  python tools/fonts/make_metrics.py
"""
import json
import os

from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
# (family name in the font, bold?, file libass uses for it)
FACES = [
    ("Noto Sans Ethiopic", 0, "NotoSansEthiopic-Regular.ttf"),
    ("Noto Sans Ethiopic", 1, "NotoSansEthiopic-Bold.ttf"),
    ("Menbere", 0, "Menbere-Regular.ttf"),
    ("Menbere", 1, "Menbere-Bold.ttf"),
    ("Noto Serif Ethiopic", 0, "NotoSerifEthiopic-Regular.ttf"),
    ("Noto Serif Ethiopic", 1, "NotoSerifEthiopic-Bold.ttf"),
    ("Abyssinica SIL", 0, "AbyssinicaSIL-Regular.ttf"),
    ("Abyssinica SIL", 1, "AbyssinicaSIL-Regular.ttf"),   # no bold file: libass thickens it
]


def main():
    out = {}
    for family, bold, fname in FACES:
        f = TTFont(os.path.join(HERE, fname))
        o = f["OS/2"]
        hmtx = f["hmtx"]
        adv = {}
        for cp, g in sorted(f.getBestCmap().items()):
            if cp < 0x10000:
                adv[str(cp)] = hmtx[g][0]
        widths = sorted(adv.values())
        # where Ethiopic letters really are (font units above the baseline):
        # the highlight box is centred on the letters, not on the line box
        gs = f.getGlyphSet()
        from fontTools.pens.boundsPen import BoundsPen
        tops, bottoms = [], []
        for cp in range(0x1200, 0x1380):
            g = f.getBestCmap().get(cp)
            if g:
                pen = BoundsPen(gs)
                gs[g].draw(pen)
                if pen.bounds:
                    bottoms.append(pen.bounds[1])
                    tops.append(pen.bounds[3])
        tops.sort()
        bottoms.sort()
        out["%s|%d" % (family, bold)] = {
            "em": o.usWinAscent + o.usWinDescent,      # font units per ASS font size
            "ascent": o.usWinAscent,
            "descent": o.usWinDescent,
            "fallback": widths[len(widths) // 2],
            "ink_top": tops[len(tops) // 2],
            "ink_bottom": bottoms[len(bottoms) // 2],
            "adv": adv,
        }
    with open(os.path.join(HERE, "metrics.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"), sort_keys=True)
    print("metrics.json: %d faces, %d bytes" % (len(out), os.path.getsize(os.path.join(HERE, "metrics.json"))))


if __name__ == "__main__":
    main()
