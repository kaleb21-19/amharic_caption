"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import Tx from "@/components/Tx";
import LangToggle from "@/components/LangToggle";
import { BOT_URL } from "@/lib/site";

// Pricing and FAQ are sections of the homepage now, not separate pages — the
// site is deliberately three pages (home, install, legal) so nothing competes
// with the one decision a visitor has to make.
const links = [
  { href: "/#how", am: "እንዴት ይሰራል", en: "How it works" },
  { href: "/#pricing", am: "ዋጋ", en: "Pricing" },
  { href: "/install/", am: "መጫኛ", en: "Install" },
  { href: "/#faq", am: "ጥያቄዎች", en: "FAQ" },
];

export default function Header() {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  // Close the menu on route change, and lock body scroll while it is open so
  // the page behind doesn't slide around under the panel on a phone.
  useEffect(() => { setOpen(false); }, [path]);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label="Amharic Captions Pro">
          <span className="brand-mark" aria-hidden="true">AC</span>
          <span className="brand-name">Amharic Captions <em>Pro</em></span>
        </Link>

        <div className="header-right">
          <nav className="nav" aria-label="Primary">
            {links.map((l) => {
              const active = l.href.startsWith("/install") && path.startsWith("/install");
              return (
                <Link
                  key={l.href}
                  href={l.href}
                  className={active ? "active" : ""}
                  aria-current={active ? "page" : undefined}
                >
                  <Tx am={l.am} en={l.en} />
                </Link>
              );
            })}
            <a className="btn btn-primary btn-sm" href={BOT_URL} target="_blank" rel="noopener">
              <Tx am="ቁልፍ ያግኙ" en="Get your key" />
            </a>
          </nav>

          <LangToggle />

          <button
            className={open ? "nav-toggle open" : "nav-toggle"}
            aria-label={open ? "Close menu" : "Open menu"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span /><span /><span />
          </button>
        </div>
      </div>

      {open && (
        <nav className="mobile-menu" aria-label="Mobile">
          {links.map((l) => (
            <Link key={l.href} href={l.href} onClick={() => setOpen(false)}>
              <Tx am={l.am} en={l.en} />
            </Link>
          ))}
          <a className="btn btn-primary" href={BOT_URL} target="_blank" rel="noopener">
            <Tx am="ቁልፍ ያግኙ" en="Get your key" />
          </a>
        </nav>
      )}
    </header>
  );
}
