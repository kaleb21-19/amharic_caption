"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BOT_URL } from "@/lib/site";

const links = [
  { href: "/", label: "Home" },
  { href: "/pricing/", label: "Pricing" },
  { href: "/install/", label: "Install" },
  { href: "/faq/", label: "FAQ" },
];

export default function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="site-header">
      <div className="trust-bar">
        <div className="container trust-inner">
          <span>100% offline — your footage never leaves your machine</span>
          <span>Lifetime license · ETB 2,500 one-time</span>
        </div>
      </div>
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label="Amharic Captions Pro home" onClick={() => setOpen(false)}>
          <span className="brand-mark">AC</span>
          <span className="brand-name">Amharic Captions <em>Pro</em></span>
        </Link>
        <nav className="nav" aria-label="Primary">
          {links.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
                {l.label}
              </Link>
            );
          })}
          <a className="btn btn-primary" href={BOT_URL} target="_blank" rel="noopener">
            Get started
          </a>
        </nav>
        <button
          className={open ? "nav-toggle open" : "nav-toggle"}
          aria-label="Menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span /><span /><span />
        </button>
      </div>
      {open && (
        <nav className="mobile-menu" aria-label="Mobile">
          {links.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
          <a className="btn btn-primary" href={BOT_URL} target="_blank" rel="noopener">
            Get started
          </a>
        </nav>
      )}
    </header>
  );
}