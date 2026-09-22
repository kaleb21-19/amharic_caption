"use client";

import { useEffect, useState } from "react";
import { BOT_URL, PRICE } from "@/lib/site";

// Sticky buy bar, phones only.
//
// The purchase happens in Telegram on a phone, so the moment someone decides,
// the action has to be within thumb reach — not a scroll back to the hero.
// It stays hidden until the hero CTA has scrolled away (so it never duplicates
// a button already on screen) and hides again over the footer, where the real
// CTA lives.
export default function MobileBuyBar() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY;
      const nearBottom =
        window.innerHeight + y > document.body.scrollHeight - 560;
      setShow(y > 620 && !nearBottom);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <div className={show ? "buybar is-up" : "buybar"} aria-hidden={!show}>
      <div className="buybar-inner">
        <div className="buybar-text">
          <strong>{PRICE}</strong>
          <span>one-time · 2 free first</span>
        </div>
        <a
          className="btn btn-primary"
          href={BOT_URL}
          target="_blank"
          rel="noopener"
          tabIndex={show ? 0 : -1}
        >
          Get your key
        </a>
      </div>
    </div>
  );
}
