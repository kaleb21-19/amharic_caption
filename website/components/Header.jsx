import Link from "next/link";
import { BOT_URL } from "@/lib/site";

export default function Header() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label="Amharic Captions home">
          <span className="brand-mark">AC</span>
          <span className="brand-name">Amharic <em>Captions</em></span>
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href="/">Home</Link>
          <Link href="/pricing/">Pricing</Link>
          <Link href="/install/">Install</Link>
          <Link href="/faq/">FAQ</Link>
          <a className="btn btn-primary" href={BOT_URL} target="_blank" rel="noopener">
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}
