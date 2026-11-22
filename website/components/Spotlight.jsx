"use client";

import { useEffect } from "react";

// One listener for the whole page: a card with class "spot" gets a soft light
// that follows the mouse (--mx/--my, drawn in CSS). Mouse only - a phone has
// no hover, and nothing runs there. Renders nothing.
export default function Spotlight() {
  useEffect(() => {
    if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0, last = null;
    const paint = () => {
      raf = 0;
      const { el, x, y } = last;
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${x - r.left}px`);
      el.style.setProperty("--my", `${y - r.top}px`);
    };
    const move = (e) => {
      const el = e.target.closest?.(".spot");
      if (!el) return;
      last = { el, x: e.clientX, y: e.clientY };
      if (!raf) raf = requestAnimationFrame(paint);
    };
    document.addEventListener("pointermove", move, { passive: true });
    return () => { document.removeEventListener("pointermove", move); cancelAnimationFrame(raf); };
  }, []);
  return null;
}
