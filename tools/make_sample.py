"""S3: the Studio's sample video - 6 Common Voice Amharic sentences (CC0) over a
background ffmpeg draws, with captions written from the clips' own transcripts
(timed from the audio). Output: app/sample/amharic_sample.mp4 + .json (cues).

  AMH_FFMPEG=path/to/ffmpeg python tools/make_sample.py
"""
import io, json, os, subprocess, sys, tempfile, wave
import numpy as np

WT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FF = os.environ.get("AMH_FFMPEG", "ffmpeg")   # ffmpeg 6+ (the gradients source)
FR = os.path.join(WT, "tools", "test", "fixtures_real")
OUT = os.path.join(WT, "app", "sample")
TMP = tempfile.mkdtemp(prefix="amh_sample_")
os.makedirs(OUT, exist_ok=True)
os.makedirs(TMP, exist_ok=True)
# (clip id, caption text as written - the Common Voice transcript, punctuation tidied)
CLIPS = [
    ("37890164", "አንድ አባት ሶስት ልጆች ነበሩት።"),
    ("37890165", "ሲለው የተለያየ ምግብ አቀረበለት።"),
    ("38629723", "ነገር ግን ጣፋጭ ትወድ ነበር።"),
    ("39362701", "በአራተኛውም ቀን ይህንኑ አደረገ።"),
    ("37952732", "መንገዱ ግን አልጋ በአልጋ አልነበረም።"),
    ("39362746", "አላሾፈም፣ እውነቱን ነው፤ እኔ ፈላስፋ አይደለሁም።"),
]
SR = 16000


def read(p):
    w = wave.open(p)
    assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2, p
    return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def speech_bounds(x):
    """First / last 20 ms frame louder than 8% of the clip's loudest."""
    f = 320
    n = len(x) // f
    e = np.sqrt((x[: n * f].reshape(n, f) ** 2).mean(axis=1))
    on = np.where(e > 0.08 * e.max())[0]
    return on[0] * f, (on[-1] + 1) * f


parts, cues, t = [], [], 0.6
parts.append(np.zeros(int(0.6 * SR), np.float32))
for cid, text in CLIPS:
    x = read(os.path.join(FR, "cv_common_voice_am_%s.wav" % cid))
    a, b = speech_bounds(x)
    a, b = max(0, a - int(0.12 * SR)), min(len(x), b + int(0.18 * SR))
    seg = x[a:b]
    seg = seg / max(1e-6, np.abs(seg).max()) * 0.7          # even loudness across speakers
    cues.append({"start": round(t + 0.06, 3), "end": round(t + len(seg) / SR - 0.08, 3), "text": text})
    parts.append(seg)
    t += len(seg) / SR
    gap = 0.45
    parts.append(np.zeros(int(gap * SR), np.float32))
    t += gap
audio = np.concatenate(parts)
wav = os.path.join(TMP, "sample.wav")
with wave.open(wav, "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())
dur = len(audio) / SR
mp4 = os.path.join(OUT, "amharic_sample.mp4")
vf = ("gradients=s=720x1280:c0=0x0b2a20:c1=0x1d6b4c:c2=0x0f3b52:nb_colors=3:speed=0.002:r=30,format=yuv420p[bg];"
      "[0:a]showwaves=s=560x200:mode=cline:scale=sqrt:draw=full:colors=0xC8F7DC:rate=30,colorchannelmixer=aa=0.7,format=rgba[wv];"
      "[bg][wv]overlay=x=80:y=440:shortest=1:format=auto,format=yuv420p[v]")
subprocess.check_call([FF, "-v", "error", "-y", "-i", wav, "-filter_complex", vf, "-map", "[v]", "-map", "0:a",
                       "-t", "%.3f" % dur, "-c:v", "libx264", "-preset", "slow", "-crf", "30", "-g", "60",
                       "-c:a", "aac", "-b:a", "64k", "-ar", "44100", "-movflags", "+faststart", mp4])
io.open(os.path.join(OUT, "amharic_sample.json"), "w", encoding="utf-8", newline="\n").write(
    json.dumps({"source": "Mozilla Common Voice Amharic (CC0 1.0), clips " + ", ".join(c for c, _ in CLIPS),
                "duration": round(dur, 3), "cues": cues}, ensure_ascii=False, indent=1) + "\n")
print("dur %.1f s, %d cues, mp4 %.0f KB" % (dur, len(cues), os.path.getsize(mp4) / 1024))
