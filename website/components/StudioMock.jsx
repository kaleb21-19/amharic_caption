"use client";

import { useEffect, useState } from "react";
import Tx from "@/components/Tx";

// The Studio (the desktop app most people start with), drawn as markup — and
// alive: the playhead runs, the caption is "spoken" word by word, the style
// changes every few phrases (the looks the Studio shows first), and the
// "እ…" take is cut out in front of the visitor. No video bytes, no one's
// face; with "reduce motion" it is one still frame.
const PHRASES = [
  { t: "0:01", words: ["የተከበሩ", "ታዳሚዎች"] },
  { t: "0:03", words: ["ዛሬ", "ስለ", "ቡና", "እናወራለን"] },
  { t: "0:05", words: ["እ…", "እንግዲህ"], cut: true },
  { t: "0:07", words: ["በአማርኛ", "ካፕሽን", "በደቂቃዎች"] },
];
const LOOKS = [
  { id: "bold", name: "Bold" },
  { id: "highlight", name: "Highlight" },
  { id: "glide", name: "Glide" },
  { id: "gold", name: "Luxury Gold" },
];
const WORD_MS = 430;

export default function StudioMock() {
  // step = one word of one phrase (and a short pause after each phrase)
  const total = PHRASES.reduce((n, p) => n + p.words.length + 1, 0);
  const [step, setStep] = useState(5);          // a good still frame for "reduce motion" and the first paint
  const [loop, setLoop] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const id = setInterval(() => {
      setStep((s) => {
        if (s + 1 >= total) { setLoop((l) => l + 1); return 0; }
        return s + 1;
      });
    }, WORD_MS);
    return () => clearInterval(id);
  }, [total]);

  let left = step, pi = 0;
  while (pi < PHRASES.length - 1 && left >= PHRASES[pi].words.length + 1) { left -= PHRASES[pi].words.length + 1; pi++; }
  const phrase = PHRASES[pi];
  const wi = Math.min(left, phrase.words.length - 1);
  const look = LOOKS[(loop * 2 + Math.floor(pi / 2)) % LOOKS.length];
  const cutDone = pi > 2 || (pi === 2 && left >= phrase.words.length);   // the "እ…" take is gone once played
  const progress = (step + 1) / total;

  return (
    <div className="smock smock-live" role="img" aria-label="Amharic Captions Studio: a video whose Amharic captions appear word by word in a chosen style, the caption list you can edit and cut, and the timeline.">
      <div className="mock-chrome">
        <span className="mock-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="mock-title">Amharic Captions Studio</span>
        <span className="mock-status"><Tx am="ያለ ኢንተርኔት" en="offline" /></span>
      </div>
      <div className="smock-body">
        <div className="smock-video" aria-hidden="true">
          <span className="smock-ratio">9:16 · 16:9</span>
          <span className="smock-look" key={look.id}>🎨 {look.name}</span>
          <span className={"smock-cap amh look-" + look.id} lang="am" key={pi + "-" + look.id}>
            {phrase.words.map((w, i) => (
              <span key={i} className={"w" + (i === wi ? " on" : "") + (i < wi ? " said" : "")}>{w}</span>
            ))}
          </span>
        </div>
        <div className="smock-list">
          {PHRASES.map((p, i) => (
            <div key={i} className={"smock-row" + (i === pi ? " on" : "") + (p.cut ? (cutDone ? " cut gone" : " cut") : "")}>
              <time>{p.t}</time>
              <span className="amh" lang="am">{p.words.join(" ")}</span>
              <i aria-hidden="true">✂</i>
            </div>
          ))}
        </div>
        <div className="smock-tl" aria-hidden="true">
          <div className="smock-tl-caps">
            {PHRASES.map((p, i) => <i key={i} className={(i === pi ? "on" : "") + (p.cut && cutDone ? " gone" : "")} />)}
          </div>
          <div className="smock-tl-wave">
            {Array.from({ length: 36 }).map((_, i) => <b key={i} style={{ "--h": (28 + ((i * 37) % 62)) + "%" }} />)}
          </div>
          <span className="smock-head" style={{ left: (progress * 100).toFixed(2) + "%" }} />
        </div>
        <div className="smock-foot">
          <span className="smock-btn"><Tx am="⬆ ይላኩ — TikTok · YouTube · CapCut" en="⬆ Export — TikTok · YouTube · CapCut" /></span>
        </div>
      </div>
    </div>
  );
}
