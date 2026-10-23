# Two-line caption animation — how the professionals do it

Research note for Amharic Captions Pro, October 2026. It explains how professional
two-line text animation is actually built, with sources, and then how our
"Two Line" template (`amh_styles.py` → `TEMPLATES["duo"]`) applies it in libass.
Everything below is either quoted from an official guideline or marked as
observed practice in social-caption tools.

---

## 1. What "two lines" really means

A two-line caption is **one caption that happens to fold**, not two captions. The
rules the broadcast world uses:

| Rule | Source |
|---|---|
| At most **2 lines** (16:9, 4:3, 1:1); 3 only for 9:16 | BBC Subtitle Guidelines v1.2.5 (Mar 2026) |
| A line should use at most **68 %** of a 16:9 frame's width (90 % of a vertical frame) | BBC, *Line length* |
| At most 2 lines, minimum 5/6 s, maximum 7 s per subtitle | Netflix Timed Text Style Guide |
| Break **at a natural point**: after punctuation; never between article + noun, adjective + noun, preposition + phrase, conjunction + clause, pronoun + verb, or inside a complex verb | BBC *Line breaks*, Netflix *Line breaks* |
| Reading speed 160–180 wpm → about **0.3 s per word**; a 4-word caption needs ≥ 1.2 s | BBC, *Reading speed* |
| Leave ≥ 1 s (preferably 1.5 s) of empty screen between captions, otherwise the result looks "jerky" | BBC, *Gaps between subtitles* |
| The caption appears **when the speech starts** and leaves roughly when it ends | BBC, *Timing* |
| One line of text is about **8 % of the frame height**; give the block a stable place | BBC, *Line height / position* |

For motion design the same idea holds: the two lines are a **single typographic
block** that happens to arrive in two beats. Never let the second line push the
first one around — the block's final position must be settled fast.

## 2. The animation techniques

| Technique | How it is built | Where it looks right |
|---|---|---|
| **Line-by-line reveal** | Two separate text layers, second one delayed 1–3 frames; each fades + slides | subtitle/caption stacks, lower thirds |
| **Mask reveal (wipe/curtain)** | Text is masked by a shape; the mask (not the text) is animated, so letters appear to be "uncovered" | editorial titles, Apple/Netflix-style brand cards |
| **Slide + settle** | Position keyframes with ease-out; distance small (10–30 px); often 1–3 % overshoot | captions on social video |
| **Fade only** | Opacity 0→100 in 4–8 frames, no motion | documentaries, anything with a moving background |
| **Scale / pop** | Scale 70–95 % → 100 % with a back-ease; used per word for "beat" captions | CapCut / MrBeast / Hormozi style |
| **Word-by-word stagger** | Same text layer, per-word animators (AE text animators + range selector; CSS `animation-delay`) | short-form, karaoke/highlight captions |
| **Kinetic typography** | Whole sentence animated with per-character or per-word offsets, rotation and masking | ads, explainers, music videos |

In After Effects all of these are **one** mechanism: a text layer plus *text
animators* (Position / Opacity / Scale / Rotation) driven by a **range selector**
whose start/end percentages are keyframed, or by separate layers when masking is
needed (Adobe, *Animating text in After Effects*). In CSS/web video the same
thing is a `transform` + `opacity` + `clip-path` transition. In ASS/libass the
same thing is `\move`, `\fad`, `\t(...)`, `\clip`, `\frz`, `\blur` on one line of
`Dialogue:` per line of text (Aegisub, *ASS override tags*).

## 3. Two-line timing logic

The professional pattern for a folded caption:

```
line 1:  |-- fade in 160-200 ms, slide 8-20 px --|------ hold ------|- fade out -|
line 2:        |-- same, delayed 80-120 ms ------|------ hold ------|- fade out -|
```

* **Entrance 160–260 ms.** Nielsen Norman Group's animation-duration study puts
  UI motion at 100–500 ms, with 200–300 ms for a "substantial" change, and says
  entrances can be slightly longer than exits. A caption is read, not admired, so
  170–250 ms is the sweet spot; longer feels sluggish, shorter reads as a jump cut.
* **Stagger 60–120 ms.** One or two beats of the same motion. Below ~50 ms the
  two lines look like they flicker; above ~150 ms the reader waits for the text.
* **Exit 80–120 ms**, both lines together — an exit that is slower than the
  entrance keeps attention on the frame, not on the text.
* **Never split the attention**: the second line must be *inside the same visual
  block* (same weight, same leading), otherwise the eye reads it as a new caption.
* **The block appears early.** Word-by-word reveal is a stylistic choice for
  short-form; for readability the whole 2-line block should be up within
  ~250 ms so the viewer can read ahead (BBC: the subtitle appears at speech
  onset, not word by word).
* **Hold** = the cue duration (≥ 0.3 s per word, ≥ 1 s in practice). Both lines
  leave at the same moment.

## 4. Easing, masks, motion blur — the mechanics

* **Easing.** Motion should decelerate into place (ease-out) for entrances and
  accelerate away (ease-in) for exits — this is the "slow in, slow out" principle
  from traditional animation (Thomas & Johnston, *The Illusion of Life*, 1981) and
  it is why NN/g recommends ease-out for things that appear. Typical curves:
  `cubic-bezier(0.215, 0.61, 0.355, 1)` (easeOutCubic) or
  `cubic-bezier(0.23, 1, 0.32, 1)` (easeOutQuint) for a snappier settle
  (easings.net).
* **In ASS there is no easing on `\move`.** Aegisub's documentation is explicit:
  `\move` runs at constant speed, and `\t(t1,t2,accel,tags)` is the easing
  control, where `accel = 1` is linear, values **below 1 start fast and slow down**
  (ease-out) and values above 1 start slow and speed up (ease-in). Two practical
  consequences for us:
  1. animate `\frz` around a far-away rotation origin (`\org`) to get an eased
     vertical slide — that is what our engine already does (`_anim_spec`, "slide");
  2. if a linear `\move` is used at all, keep it short (≤ 200 ms, ≤ 20 px) so the
     missing easing cannot be seen.
* **Masks.** A rectangular `\clip`/`\iclip` **can** be animated with `\t`, a
  vector clip cannot (Aegisub). Mask reveals are therefore possible in libass,
  but any clip that does not open fully leaves text hidden — with paying
  customers we prefer the `\move` + `\fad` route, which always ends in a readable
  state.
* **Motion blur.** ASS has no motion-blur tag. The professional substitute is a
  short Gaussian blur that resolves: `\blur6\t(0,160,\blur0)` (Aegisub: `\blur`
  is a Gaussian edge blur; `\be` is the old, discouraged box blur).
* **Opacity** is `\alpha`/`\1a` or `\fad(in,out)`; Aegisub warns that fade-in +
  fade-out must be shorter than the line's duration, because `\fad` never
  extends an event.
* **Scale** must be animated with `\fscx/\fscy`, not `\fs` (font size re-layouts
  the line and makes it jump).

## 5. Typography and visual quality (what separates pro from amateur)

* **Weight**: captions that will be read over moving video use a heavy weight
  (Bold/Black) and often an outline or a box for contrast; editorial/cinematic
  looks use a light or regular weight with generous spacing.
* **Leading** for a 2-line caption: about **1.10–1.25 × the font size** (tighter
  than body text: MDN notes `line-height: normal` ≈ 1.2 and WCAG suggests ≥ 1.5
  for *paragraphs* — captions are not paragraphs, they are a sign). Too tight and
  the outlines of the two lines touch; too loose and the block falls apart.
* **Hierarchy**: if the two lines differ in weight or colour, the first line is
  the "loud" one and the second is the continuation — never compete.
* **Alignment**: centre for balanced phrases; left for long, subtitle-like text
  (BBC/Netflix subtitles are left-aligned in most languages, centred is the
  social-video norm).
* **Stable position**: the block must not move between captions (the "jumping
  caption" problem). A two-line block grows **upwards** from the bottom safe area
  in subtitling, so the last line always sits where a single line would.
* **Restraint**: frequent animation should be short and subtle (NN/g). A caption
  that moves on every word makes reading harder, not easier.

## 6. Real examples, and what is actually happening

| Example | What you see | What is really happening |
|---|---|---|
| BBC / Netflix subtitles | plain text, hard cuts | no animation at all; readability rules (2 lines, breaks, 0.3 s/word) do the work |
| CapCut / Submagic / MrBeast-style captions | one or two lines, big bold, word lights up | 3–5 word groups, spoken word in an accent colour, 1–2 lines, small pop or none |
| Apple / Netflix brand title cards | line rises out of nothing | text masked by a shape; the mask is animated, the text stands still |
| Kinetic typography ads | words fly, rotate, scale on the beat | per-word/per-character animators with staggered delays, strong ease-out, often motion blur baked in AE |
| Documentaries | soft fade in/out | opacity only, 150–300 ms, no movement (keeps eyes on the image) |

The important observation for us: **the popular "caption" looks are mostly
typography + one accent colour, not complex motion.** Motion is 150–250 ms and
subtle; the "wow" comes from the font, the outline/shadow, and the block sitting
perfectly still.

## 7. Step by step — recreate a professional 2-line entrance

### In After Effects
1. Type the phrase on two lines (`Shift+Enter`), one text layer, centred.
2. Set leading so the two lines nearly touch the outline (≈1.15 × size).
3. Add an **Animator → Position** with a Range Selector limited to line 1
   (advanced → "Based on: Lines"), values: Y +20 px, Opacity 0 %.
4. Keyframe the selector's End from 0 % to 100 % in **8 frames** (at 25 fps =
   320 ms), Easy Ease (or `easeOutCubic` via a keyframe assistant).
5. Duplicate the animator for line 2, offset the keyframes by **2–3 frames**
   (80–120 ms).
6. Add a **Blur** animator (2–4 px) on the same range, keyframed to 0 at the end
   — the motion-blur substitute.
7. Out: one Opacity keyframe pair at the end of the cue, 3 frames.

### In CSS (website previews, HTML overlays)
```css
.line { opacity: 0; transform: translateY(14px); }
.line.in { opacity: 1; transform: none; transition: opacity 170ms linear, transform 220ms cubic-bezier(.215,.61,.355,1); }
.line:nth-child(2).in { transition-delay: 90ms; }
```

### In ASS/libass (what our engine emits for a stacked look)
```
; line 1 - appears now, eased slide up, 170 ms fade
Dialogue: 0,0:00:06.20,0:00:06.40,S,,0,0,0,,{\an5\pos(540,1338)\fad(170,0)\org(-21600,960)\frz-0.1464\t(0,300,0.45,\frz0)}line 1
; line 2 - same entrance, 90 ms later, its own line box
Dialogue: 0,0:00:06.29,0:00:07.23,S,,0,0,0,,{\an5\pos(540,1418)\fad(170,0)\org(-21600,960)\frz-0.1464\t(0,300,0.45,\frz0)}line 2
```
The `\org` + `\frz` pair turns a linear `\move` into an eased vertical slide: the
text rotates by a tiny angle around a point ~20 frame-widths to the left, so it
travels straight up but with the acceleration curve of `\t`.

## 8. Common mistakes (and how we avoid them)

| Mistake | Why it hurts | Our rule |
|---|---|---|
| Second line appears too late (> 200 ms) | the viewer starts reading line 1, then the block moves under their eyes | stagger 90 ms |
| Two lines at different weights/sizes | reads as two captions | one style for the whole block |
| Lines too close (leading ≤ 1.0) | outlines merge into a blob | leading ≥ 1.14 × size, checked by a test |
| Block grows downwards | the last line enters the safe margin / platform UI | bottom-anchored blocks grow upwards |
| Orphan line ("…and" alone) | looks like a mistake | break cost punishes a one-word second line |
| Breaking after a preposition / before a conjunction | unreadable in Amharic and English | break points penalised with word lists (`_L_NO_START` / `_L_NO_END`) |
| Linear motion | looks mechanical | eased `\frz`+`\org` slide, or a very short move |
| Long caption shrunk per cue | font size changes between captions = jumping text | wrap first, one size per template |
| Animating every word | unreadable at speed | only the spoken word changes colour |
| No exit | captions pop off | 90 ms fade-out, both lines together |

## 9. What we built ("Two Line" template)

`TEMPLATES["duo"]` — a data recipe drawn by the shared template renderer:

| Setting | Value | Why |
|---|---|---|
| `rows` | 2 | the phrase may fold on two animated lines |
| `wrap` | 0.72 of the frame width | lines never run edge to edge; 5-word phrases fold naturally |
| `line_gap` | 1.16 × size | enough air that the outlines never touch |
| `stagger` | 0.09 s | inside the 60–120 ms pro range |
| `exit` | 90 ms | both lines fade out together |
| `anim` | `slide` (170 ms fade, 300 ms eased slide) | ease-out entrance per line |
| `hl` | `colour`, accent `#FFD84D` | the spoken word lights up, on whichever line it is |
| `words` | 5 | subtitle-sized phrases |

Behaviour details that matter:

* **Wrap only when needed.** A short phrase stays on one line (a two-line look
  that always breaks is a gimmick); the break goes to the most balanced natural
  point. Never before `እና / ግን / ወይም …`, never after `በ / ለ / የ / ከ …`, never
  leaving one word alone.
* **One block, one place.** The second line is placed at `cy + 1.16 × size` and
  the first at `cy` — the block is bottom-anchored, so it grows upwards and the
  lower line sits exactly where a one-line caption would.
* **Read ahead.** Line 2 is on screen from ~90 ms, not from its first word, so the
  viewer reads the whole phrase before it is spoken; the accent still follows the
  voice (karaoke) on both lines.
* **Redraws keep the entrance.** Word-by-word redraws continue the animation with
  `_cont(ms)` instead of restarting it, so the text never jumps.
* **Boxes** (if a stacked look uses one) are a single pill behind both lines, not
  one box per line.
* **No regression.** All 18 old styles and the other 13 templates are byte-for-byte
  identical (checked against `origin/main` over 18 styles × 2 word sets × 8 option
  sets × 2 frame shapes → 0 differences), and the new path only runs when
  `rows > 1`.

Limitation, stated plainly: libass has **no motion blur**, so a fast entrance can
never be as smooth as After Effects. We compensate with a short fade (170 ms) and
a small travel distance, which is what the platform captions do anyway.

## Sources

* Aegisub — *ASS override tags* (official): https://aegisub.org/docs/latest/ass_tags/ — `\t` acceleration, `\move` linear, `\fad` limits, `\clip` animation, `\blur`, `\fscx/\fscy`, `\org`/`\frz`.
* BBC — *Subtitle Guidelines* v1.2.5 (March 2026): https://www.bbc.co.uk/accessibility/forproducts/guides/subtitles/ — 2 lines, 68 % line length, line breaks, 160–180 wpm, gaps ≥ 1 s, line height 8 %.
* Netflix — *Timed Text Style Guide: General Requirements*: https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements — 2 lines max, 5/6 s–7 s duration, break rules.
* Nielsen Norman Group — *Animation duration*: https://www.nngroup.com/articles/animation-duration/ — 100–500 ms, 200–300 ms for substantial changes, ease-out in / ease-in out, restraint.
* easings.net — *Easing functions cheat sheet*: https://easings.net/ — easeOutCubic `cubic-bezier(0.215, 0.61, 0.355, 1)`, easeOutQuint `cubic-bezier(0.23, 1, 0.32, 1)`.
* MDN — *line-height*: https://developer.mozilla.org/en-US/docs/Web/CSS/line-height — normal ≈ 1.2; WCAG 1.5 for paragraphs.
* Adobe — *Animating text in After Effects* (text animators, range selectors): https://helpx.adobe.com/after-effects/using/text-animation.html
* Thomas, F. & Johnston, O. — *The Illusion of Life: Disney Animation* (1981) — slow in / slow out, staging, restraint.
