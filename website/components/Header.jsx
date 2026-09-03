import Link from "next/link";
import { BOT_URL } from "@/lib/site";

export default function Header() {
  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href="/" className="brand" aria-label="Amharic Captions home">
          <img className="brand-logo" src="/amharic_caption/images/logo@2x.png" alt="Amharic Captions logo" width="164" height="240" />
          <span className="brand-name">Amharic <em>Captions</em></span>
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href="#features">Features</Link>
          <Link href="#how">How it works</Link>
          <Link href="#pricing">Pricing</Link>
          <Link href="#faq">FAQ</Link>
          <a className="btn btn-primary" href={BOT_URL} target="_blank" rel="noopener">
            Get started
          </a>
        </nav>
      </div>
    </header>
  );
}
