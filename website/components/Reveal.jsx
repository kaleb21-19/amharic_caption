"use client";

import { useEffect, useRef, useState } from "react";

// Scroll-triggered entrance.
//
// Motion discipline: 380ms and 10px of travel. The previous 550ms/14px read as
// sluggish — premium motion is fast and small, so the eye registers arrival
// rather than watching a slide. Easing is a pure ease-out (no overshoot): the
// element decelerates into place like a real object settling.
//
// Never wrap hero content in this. Above-the-fold content must paint
// immediately; delaying it trades real perceived speed for a effect nobody
// scrolled to see.
export default function Reveal({
  children,
  as: Tag = "div",
  delay = 0,
  className = "",
  style,
}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Respect the OS setting without running an observer at all.
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setVisible(true);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setVisible(true);
            io.unobserve(e.target);
          }
        });
      },
      // Fire slightly before the element is fully in view so the motion
      // finishes as it settles into the viewport, not after.
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={["reveal", visible ? "is-in" : "", className].filter(Boolean).join(" ")}
      style={{ ...style, "--reveal-delay": `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
