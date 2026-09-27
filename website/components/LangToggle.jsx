"use client";

import Tx from "@/components/Tx";
import { LANG_KEY } from "@/lib/site";

// The button always names the OTHER language ("English" while reading Amharic,
// "አማርኛ" while reading English), so it needs no React state: the label is
// switched by the same CSS as the rest of the page.

export default function LangToggle({ className = "" }) {
  const flip = () => {
    const root = document.documentElement;
    const next = root.getAttribute("data-lang") === "en" ? "am" : "en";
    root.setAttribute("data-lang", next);
    root.lang = next;
    try { localStorage.setItem(LANG_KEY, next); } catch (e) { /* private mode: session only */ }
  };
  return (
    <button type="button" className={`lang-toggle ${className}`} onClick={flip}>
      <Tx am="English" en="አማርኛ" />
    </button>
  );
}
