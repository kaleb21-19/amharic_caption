"use client";

import { useEffect, useRef, useState } from "react";

// A number that counts up once when it scrolls into view. The real number is
// in the HTML from the start (search engines, no-JS, "reduce motion"); only a
// number still below the fold is reset to 0 and counted up when it arrives.
export default function CountUp({ to, suffix = "", ms = 1400 }) {
  const ref = useRef(null);
  const [n, setN] = useState(to);
  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    if (el.getBoundingClientRect().top < window.innerHeight) return;   // already seen: leave it
    setN(0);
    let raf = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min(1, (now - t0) / ms);
        setN(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, { threshold: 0.5 });
    io.observe(el);
    return () => { io.disconnect(); cancelAnimationFrame(raf); };
  }, [to, ms]);
  return <span ref={ref} className="countup">{n.toLocaleString("en-US")}{suffix}</span>;
}
