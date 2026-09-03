import Link from "next/link";

export default function Header({ lang = "am" }) {
  const t = {
    features: lang === "am" ? "ገጽታዎች" : "Features",
    pricing: lang === "am" ? "ዋጋ" : "Pricing",
    install: lang === "am" ? "መጫን" : "Install",
    buy: lang === "am" ? "ግዛ" : "Buy",
  };

  return (
    <header className="site-header">
      <div className="container header-inner">
        <Link href={lang === "am" ? "/" : "/en/"} className="brand">
          <span className="brand-mark">አ</span>
          <span className="brand-name">Amharic Captions</span>
        </Link>
        <nav className="nav" aria-label={lang === "am" ? "ዋና አሰሳ" : "Main"}>
          <Link href="#features">{t.features}</Link>
          <Link href="#pricing">{t.pricing}</Link>
          <Link href="#install">{t.install}</Link>
          <a className="btn btn-primary" href="https://t.me/sumpak6">
            {t.buy}
          </a>
        </nav>
      </div>
    </header>
  );
}
