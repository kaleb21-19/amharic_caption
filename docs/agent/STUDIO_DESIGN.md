# Amharic Captions Studio — design (owner-approved direction, 2026-10-18)

The desktop app (CapCut / DaVinci users). Modern, professional, easy. Every
Studio change follows this page; change the page first if the design changes.
Research basis: Descript (script-first, selection toolbar, AI tools in one
sidebar), CapCut desktop / Submagic (drop → captions in seconds, one screen),
Premiere text panel. The Premiere/AE panel is NOT this design (it stays a panel).

## 1. Principles
1. **One screen, no wizard.** Drop a video → the workspace opens at once and
   works. No "Step 1 / 2 / 3", no options before transcription.
2. **Decide later, never redo.** Everything that shapes captions (words per
   caption, line length, style) changes instantly AFTER transcription — from
   the words' times — never by transcribing again.
3. **Act where you look.** Select words → the actions appear right there
   (★ Pop · ✂ Cut · ✎ Fix · ▶ Play). No hidden menus for daily actions.
4. **One place per kind of thing.** Text left, picture middle, settings right
   (tabs), time bottom, Export top-right. Nothing floats elsewhere.
5. **Never lose work.** Autosave always ("✓ Saved" in the top bar), undo for
   everything, the original video is never changed.
6. **Calm by default.** Show only what works here and now (no disabled
   "coming soon"); one accent colour; warnings only when there is something
   to do.
7. **Amharic first**, polite form, English one tap away.
8. **Every PC.** Smooth on weak PCs (light preview, GPU encode when present,
   honest time estimates); never block, explain.

## 2. Screens and states
**Home** — logo + name, one large drop area ("Drop a video here · or choose"),
Recent projects grid (name, length, captions, last opened; missing video
greyed). Top-right: license chip, language. Nothing else.

**Workspace** (one screen):
```
┌ top bar: ⌂ · name / project · ↶ · ✓ Saved ··········· license · EN · [⬆ Export] ┐
│ LEFT: text (captions)  │  MIDDLE: video + caption  │  RIGHT: tabs (🎨 Style · Aa Captions · …) │
├──────────────────────── BOTTOM: timeline (wave, caption blocks, playhead) ─────────────┤
```
States inside the workspace:
- **Transcribing** — video plays already; the text area shows progress
  ("Listening… 34 %", Cancel) and fills as parts finish (long videos).
- **Ready** — normal editing.
- **Problem** — one calm banner in the text area: what happened, what to do,
  [Try again] [Send report]. Never a dead end.
- **Free trial / no license** — the chip says what is left; when the minutes
  are needed, a sheet explains the one step (Telegram) — the work stays open.

## 3. Panels
- **Text (left)** — 1.18.0: the caption list, cleaned up. 1.18.x: Script view
  (flowing text, times at paragraph starts, orange = doubtful, yellow = ★,
  red struck = ✂, green = now; selection toolbar).
- **Video (middle)** — the real caption on the picture, play controls, time,
  full screen; later 9:16 / 16:9 framing.
- **Right tabs** — only tabs that work here: 🎨 Style (styles grid + size,
  position, font, animation), Aa Captions (words per caption 1–5, line length,
  instantly), ✂ Clean up (1.19.0: non-destructive — playback skips the ticked parts,
  red stripes on the timeline, the cut happens on export), later 🔍 Zoom (owner: not yet), 🔊 Sound.
- **Timeline (bottom)** — ruler, sound wave, caption blocks (drag edges),
  playhead; later cut ranges (red stripes) and zooms (yellow marks).
- **Top bar** — ⌂ Home, project name, ↶ Undo, ✓ Saved, license chip, language,
  ⬆ Export (primary, always visible).

## 4. Export (one sheet)
Cards: **Subtitles (.srt)** for CapCut / DaVinci (with "Open in …" steps) ·
**Video with captions (MP4)** in the chosen style · later: transparent
captions layer (.mov), DaVinci timeline, platform presets (YouTube, TikTok,
Reels, Telegram), several at once in a queue. Saved next to the video by
default (Documents if that folder is read-only); progress inside the sheet;
"Show in folder" at the end.

## 5. Keys (shown in tooltips and in a "?" sheet)
Space/K play-pause · J/L ±1 s (Shift ±5) · ←/→ one frame (Shift 1 s) ·
Home/End · Ctrl+Z undo · Ctrl+B ★ · Ctrl+D ✂ · Ctrl+↓/↑ next/previous caption ·
Ctrl+E Export.

## 6. Look
8 px spacing grid; three text sizes; one accent (the green); dark only; focus
rings on everything; 150 ms transitions; icons + short words, never icons alone.

## 7. The editor (1.20.0 →)
The Studio is a real editor (CapCut-like layout, our captions inside):
media left (📁), canvas middle (format 16:9 / 9:16 / 1:1 / 4:5, drag to place),
settings right (⚙ Clip, 🎨 Style, Aa Captions, ✂ Clean up), multi-track
timeline bottom. Rules:
- **The edit is data** (project `edit`: fmt, media, clips); the preview plays it,
  the export renders it in one ffmpeg pass — what you see is what you get.
- **Captions belong to the source files**; the edit's captions are derived and
  every change goes back (never lose a fixed word).
- **Everything undoable, redo too.**
- Order: 1.20 timeline · 1.21 overlay track (B-roll, photos, logo) · 1.22 text
  & lower thirds · 1.23 sound (music, ducking, fades, noise, loudness) — done ·
  1.24 transitions, speed, colour — done · 1.25 export presets, GPU, queue — done · 1.26 Amharic typing (selam → ሰላም) — done · 1.27 editable styled captions in Premiere (clips per phrase) · 1.28 12 Amharic fonts + install on this PC · parked: real Premiere text (MOGRT: no reliable text API yet).


## 8. Studio Pro for CapCut / DaVinci users (1.45.0, owner: "a real studio, very professional")
Most Studio users edit in CapCut or DaVinci: the Studio's job is to put
perfect, editable Amharic captions INTO their editor, beautifully.
- **No first-run wizard** in the Studio (principle 1): the home opens at once.
- **Home = picture cards.** Recent projects show a frame of their video
  (made once, kept in Studio/thumbs). "Your CapCut projects" show CapCut's own
  cover picture; one hint at the top, not one per project.
- **The editor's goal is the main button.** The editor picked "Which editor?"
  → the top-right primary button is "✂️ Send to CapCut" / "🎞️ Send to
  DaVinci" (one click: a new CapCut project, or the DaVinci script ready);
  ⬆ Export stays next to it for the other outputs.
- **No surprises.** For CapCut / DaVinci users the Style tab says what reaches
  their editor (font, size, colour, outline/box, position) and what stays in
  the MP4 only (the movement: Bounce, Karaoke…; in CapCut pick an animation
  for one caption → all, 1.37).
