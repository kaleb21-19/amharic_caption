"use client";

import { useEffect, useRef } from "react";
import Tx from "@/components/Tx";

// A real recording of the Studio (13 s, 355 KB, no sound): Amharic captions
// playing word by word. It loads and plays only when it is on screen — phone
// data is expensive — and pauses when it leaves. With "reduce motion" or
// "save data" it stays a picture with ▶ (the visitor starts it).
export default function DemoVideo() {
  const ref = useRef(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches || navigator.connection?.saveData;
    if (still) { v.controls = true; return; }
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => {
        if (e.isIntersecting) { if (v.preload !== "auto") { v.preload = "auto"; v.load(); } v.play().catch(() => {}); }
        else v.pause();
      });
    }, { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, []);
  return (
    <section className="section demo" id="demo" aria-label="The Studio at work">
      <div className="container">
        <div className="section-head center">
          <p className="eyebrow"><Tx am="በተግባር" en="See it work" /></p>
          <h2><Tx am="ቪዲዮ ያስገቡ — የአማርኛ ካፕሽኑ ይመጣል።" en="Drop a video — the Amharic captions arrive." /></h2>
          <p className="section-sub">
            <Tx am="እውነተኛ ስቱዲዮ፣ ያልተቀየረ ቅጂ፦ የሚነገረው ቃል ይደምቃል፣ ጽሑፉ አብሮ ይከተላል።"
              en="The real Studio, recorded as it is: the spoken word lights up, the text follows along." />
          </p>
        </div>
        <div className="demo-frame">
          <div className="mock-chrome" aria-hidden="true">
            <span className="mock-dots"><i /><i /><i /></span>
            <span className="mock-title">Amharic Captions Studio</span>
          </div>
          <video ref={ref} src="/demo/studio-demo.mp4" poster="/demo/studio-demo.jpg" muted loop playsInline preload="none"
            width="1280" height="720" aria-label="A recording of the Amharic Captions Studio making and playing Amharic captions" />
        </div>
      </div>
    </section>
  );
}
