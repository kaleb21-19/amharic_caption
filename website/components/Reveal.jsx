"use client";

import { useEffect, useRef, useState } from "react";

// Reveal — scroll-triggered entrance animation. Wraps children in a div that
// fades/slides in the first time it scrolls into view. `delay` supports
// staggering sibling cards (e.g. 0, 80, 160…).
export default function Reveal({
  children,
  as: Tag = "div",
  delay = 0,
  className = "",
  style,
  variant = "up",
}) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setVisible(true);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const state = visible ? "is-in" : "is-out";

  return (
    <Tag
      ref={ref}
      className={`reveal reveal-${variant} ${state} ${className}`.trim()}
      style={{ ...style, "--reveal-delay": `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}
