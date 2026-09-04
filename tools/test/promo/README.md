# Amharic Captions — Promo script & transcription workflow

## 1. Promo script (Amharic) — read/paste into an online Amharic TTS
Goal: ~15–20 seconds, simple words the ASR recognizes well, ends with a call to action.

አማርኛ ካፕሽንስ — ለPremiere Pro የአማርኛ ትርጉም አድራጊ።
ቪዲዮዎን ያስገቡ። ትርጉም ይፈጥሩ። በደቂቃዎች ውስጥ ወዲያውኑ ዝግጁ ነው።
በመሣሪያዎ ላይ ብቻ ይሠራል። በይነመረብ አያስፈልግም።
ዛሬውኑ በTelegram ይጀምሩ — @AmharicCaptionsBot።

(A short English run-through you can optionally include in a second take:
Amharic captions — made for Premiere Pro. Import your video, generate captions,
and it's ready in minutes. Fully on-device. No internet needed. Start today on
Telegram — @AmharicCaptionsBot.)

## 2. Workflow after you generate the audio
Place the generated audio here (e.g. promo.wav / promo.mp3) as:
    tools/test/promo/promo.mp3

Then I will:
- convert it to 16 kHz mono WAV (ffmpeg)
- run it through the product's own transcriber (ethio_srt.py)
- output the SRT captions = the "transcribed promo"
- combine into a short promo video/graphics when you want

## 3. Tips for the TTS
- Pick a clear, natural Amharic voice (e.g. Google Translate TTS, Azure neural,
  ElevenLabs if Amharic supported).
- Download as WAV or MP3 (44.1k/48k fine; I'll resample).
- Keep it one clean take so word boundaries are clear for the ASR.
