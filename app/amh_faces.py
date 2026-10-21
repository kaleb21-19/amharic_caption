"""Where the speaker's face is, a few times a second (Amharic Captions Studio,
📱 Wide -> TikTok, 1.63).

    python amh_faces.py <ffmpeg> <video> <width> <height> <fps> [start end]

Prints "[faces] 0.42" progress lines, then one JSON line:
    {"ok": true, "fps": 2, "faces": [[t, cx, cy, fw, fh, score] | [t], ...]}
t = seconds in the file; cx, cy = the face's centre, fw, fh = its size, all
0-1 of the picture; [t] alone = no face in that frame.

The detector is the "Ultra-Light-Fast-Generic-Face-Detector-1MB" model
(version-RFB-320.onnx, MIT license, faces/LICENSE), run by the onnxruntime
that the speech engine already ships. Frames come from ffmpeg at 320x240
(letterboxed), so a minute of video takes a few seconds; nothing is written
to disk.
"""
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = os.path.join(HERE, "faces", "version-RFB-320.onnx")
IW, IH = 320, 240


def nms(boxes, scores, iou=0.3, top=5):
    order = scores.argsort()[::-1]
    keep = []
    while order.size and len(keep) < top:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(boxes[i, 0], boxes[order[1:], 0])
        yy1 = np.maximum(boxes[i, 1], boxes[order[1:], 1])
        xx2 = np.minimum(boxes[i, 2], boxes[order[1:], 2])
        yy2 = np.minimum(boxes[i, 3], boxes[order[1:], 3])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        area = lambda b: (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
        o = inter / np.maximum(1e-9, area(boxes[i]) + area(boxes[order[1:]]) - inter)
        order = order[1:][o < iou]
    return keep


def main(argv):
    ffmpeg, video, w, h, fps = argv[0], argv[1], int(argv[2]), int(argv[3]), float(argv[4])
    start = float(argv[5]) if len(argv) > 5 else 0.0
    end = float(argv[6]) if len(argv) > 6 else None
    import onnxruntime as ort
    opts = ort.SessionOptions()
    opts.log_severity_level = 3
    opts.intra_op_num_threads = 2
    sess = ort.InferenceSession(MODEL, opts, providers=["CPUExecutionProvider"])
    # where the picture sits inside the letterboxed 320x240 frame
    k = min(IW / max(1, w), IH / max(1, h))
    cw, ch = w * k, h * k
    ox, oy = (IW - cw) / 2, (IH - ch) / 2
    cmd = [ffmpeg, "-v", "error", "-nostdin"]
    if start > 0:
        cmd += ["-ss", "%.3f" % start]
    cmd += ["-i", video]
    if end is not None:
        cmd += ["-t", "%.3f" % max(0.1, end - start)]
    cmd += ["-an", "-vf", "fps=%g,scale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2,format=rgb24" % (fps, IW, IH, IW, IH),
            "-f", "rawvideo", "-"]
    flags = 0x08000000 if os.name == "nt" else 0          # no console window
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, creationflags=flags)
    size = IW * IH * 3
    total = ((end if end is not None else start + 1) - start) * fps
    out, n = [], 0
    while True:
        buf = p.stdout.read(size)
        if not buf or len(buf) < size:
            break
        t = round(start + n / fps, 3)
        img = np.frombuffer(buf, np.uint8).reshape(IH, IW, 3).astype(np.float32)
        x = ((img - 127.0) / 128.0).transpose(2, 0, 1)[None]
        scores, boxes = sess.run(None, {"input": x})
        s = scores[0, :, 1]
        m = s > 0.7
        face = [t]
        if m.any():
            b, sc = boxes[0][m], s[m]
            keep = nms(b, sc)
            # the biggest clear face is the speaker
            best = max(keep, key=lambda i: (b[i, 2] - b[i, 0]) * (b[i, 3] - b[i, 1]) * sc[i])
            x1, y1, x2, y2 = b[best] * np.array([IW, IH, IW, IH])
            cx, cy = ((x1 + x2) / 2 - ox) / cw, ((y1 + y2) / 2 - oy) / ch
            face = [t, round(float(np.clip(cx, 0, 1)), 4), round(float(np.clip(cy, 0, 1)), 4),
                    round(float((x2 - x1) / cw), 4), round(float((y2 - y1) / ch), 4), round(float(sc[best]), 3)]
        out.append(face)
        n += 1
        if end is not None and n % 4 == 0:
            print("[faces] %.3f" % min(1.0, n / max(1.0, total)), flush=True)
    p.wait()
    print(json.dumps({"ok": True, "fps": fps, "faces": out}), flush=True)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as e:  # one JSON line either way
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        sys.exit(1)
