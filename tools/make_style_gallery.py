#!/usr/bin/env python3
"""Render every caption style and template to a short video, so the editor can
see the looks before choosing one (and the panel's thumbnails come from here).

  python tools/make_style_gallery.py --out %TEMP%\style_gallery
  python tools/make_style_gallery.py --thumbs      (panel/img/styles/*.jpg)

Needs ffmpeg with libass (the product's own ffmpeg is used when it is there).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, REPO)
import amh_styles as A  # noqa: E402

CUES = [
    ("ሰላም ሁሉም", 0.4, 1.3),
    ("እንኳን ደህና መጡ", 1.4, 2.6),
    ("ዛሬ ገና አማርኛው ብዙ ነው", 2.7, 4.3),
    ("በ TikTok ብዙ ሰዎች እየተጠበቁ ናቸው", 4.4, 6.2),
]
# one word for the panel's little pictures
THUMB_CUES = [("ትንብና", 0.4, 6.0)]


def find_ffmpeg():
    cand = os.environ.get("AMH_FFMPEG")
    if cand and os.path.isfile(cand):
        return cand
    win = os.path.join(os.environ.get("APPDATA", ""), "Adobe", "CEP", "extensions",
                       "com.amharic.captions", "runtime", "bin", "ffmpeg.exe")
    if os.path.isfile(win):
        return win
    mac = os.path.expanduser("~/Library/Application Support/Adobe/CEP/extensions/"
                              "com.amharic.captions/runtime/bin/ffmpeg")
    if os.path.isfile(mac):
        return mac
    return shutil.which("ffmpeg")


def background(ffmpeg, out, w, h, dur):
    """A quiet neutral background (a soft vertical gradient), so the captions
    can be judged as they would look on a video."""
    cmd = [ffmpeg, "-y", "-v", "error", "-f", "lavfi",
           "-i", "gradients=s=%dx%d:d=%.2f:c0=0x2b3040:c1=0x0d1017:x0=0:y0=0:x1=0:y1=1" % (w, h, dur),
           "-pix_fmt", "yuv420p", out]
    subprocess.run(cmd, check=True)
    return out


def render_one(ffmpeg, fonts, style, out, w, h, dur, cues=None):
    bg = out + ".bg.mp4"
    background(ffmpeg, bg, w, h, dur)
    job = {"cues": cues or CUES, "style": style, "width": w, "height": h, "fps": 25,
           "out": out, "ffmpeg": ffmpeg, "fonts": fonts, "mode": "burn",
           "video": bg, "duration": dur}
    try:
        A.render(job)
    finally:
        if os.path.isfile(bg):
            os.remove(bg)
    return out


def thumb(ffmpeg, fonts, sid, out, at=2.2):
    """A 300x150 picture of the look (the panel's button): one word, cropped
    tight around the caption, so the look is easy to recognise - like the
    editor sees it on the video."""
    vid = out.replace(".jpg", ".thumb.mp4")
    render_one(ffmpeg, fonts, sid, vid, 960, 540, 6.5, cues=THUMB_CUES)
    w, h = 960, 540
    raw = subprocess.run([ffmpeg, "-v", "error", "-ss", str(at), "-i", vid, "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
    box = "crop=440:220:260:300"          # the caption's place in a 16:9 frame
    if len(raw) >= w * h:
        pix = sorted(raw[::7])                      # every 7th pixel is enough
        med = pix[len(pix) // 2]
        lim = max(med + 28, 80)
        xs, ys = [], []
        for y in range(h):
            row = raw[y * w:(y + 1) * w]
            if max(row) > lim:
                ys.append(y)
                xs.extend(x for x in range(0, w, 2) if row[x] > lim)
        if xs and ys:
            x0, x1, y0, y1 = min(xs), max(xs), ys[0], ys[-1]
            cw = max(int((x1 - x0) * 1.08), 240)
            ch = int(cw / 2.0)
            cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
            x0, y0 = max(0, cx - cw // 2), max(0, cy - ch // 2)
            cw, ch = min(cw, w - x0), min(ch, h - y0)
            box = "crop=%d:%d:%d:%d" % (cw // 2 * 2, ch // 2 * 2, x0 // 2 * 2, y0 // 2 * 2)
    subprocess.run([ffmpeg, "-y", "-v", "error", "-ss", str(at), "-i", vid, "-frames:v", "1",
                    "-vf", "%s,scale=300:150:flags=lanczos" % box, "-q:v", "3", out], check=True)
    if os.path.isfile(vid):
        os.remove(vid)


def html(out, rows):
    body = ["<html><head><meta charset='utf-8'><title>Amharic Captions Pro - styles</title>",
            "<style>body{background:#14161c;color:#e8e8ee;font:16px/1.5 system-ui;margin:24px}",
            "h2{font-size:18px;margin:26px 0 8px;color:#8ab4ff}",
            ".row{display:flex;flex-wrap:wrap;gap:14px}",
            "figure{margin:0;width:220px}video{width:220px;background:#000;border-radius:8px;display:block}",
            "figcaption{font-size:13px;color:#aab;margin-top:4px}</style></head><body>",
            "<h1>Caption styles and templates</h1>"]
    for title, items in rows:
        body.append("<h2>%s</h2><div class='row'>" % title)
        for name, vid in items:
            body.append("<figure><video src='%s' autoplay loop muted playsinline></video>"
                        "<figcaption>%s</figcaption></figure>" % (vid, name))
        body.append("</div>")
    body.append("</body></html>")
    path = os.path.join(out, "index.html")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(body))
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(tempfile.gettempdir(), "style_gallery"))
    ap.add_argument("--thumbs", action="store_true", help="write panel/img/styles/<id>.jpg")
    ap.add_argument("--only", default="all", help="all | templates | styles")
    ap.add_argument("--width", type=int, default=540)
    ap.add_argument("--height", type=int, default=960)
    args = ap.parse_args()
    ffmpeg = find_ffmpeg()
    if not ffmpeg or not A.supported(ffmpeg):
        sys.exit("no ffmpeg with libass - set AMH_FFMPEG")
    fonts = os.path.join(REPO, "tools", "fonts")
    styles = [s for s in A.STYLES if s != "plain"]
    templates = list(A.template_ids())
    if args.only == "templates":
        styles = []
    elif args.only == "styles":
        templates = []
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)
    rows = []
    made = []
    for group, ids in (("Styles", styles), ("Templates", templates)):
        items = []
        for sid in ids:
            name = A.TEMPLATES[sid]["name"] if sid in A.TEMPLATES else sid
            vid = os.path.join(out, "%s.mp4" % sid)
            print("  rendering %s ..." % sid)
            render_one(ffmpeg, fonts, sid, vid, args.width, args.height, 6.5)
            items.append((name, "%s.mp4" % sid))
            made.append((sid, vid))
        if items:
            rows.append((group, items))
    page = html(out, rows)
    if args.thumbs:
        tdir = os.path.join(REPO, "panel", "img", "styles")
        os.makedirs(tdir, exist_ok=True)
        for sid, vid in made:
            print("  thumbnail %s.jpg" % sid)
            thumb(ffmpeg, fonts, sid, os.path.join(tdir, "%s.jpg" % sid))
    print("\nGallery: %s" % page)
    print("Videos:  %s" % out)


if __name__ == "__main__":
    main()
