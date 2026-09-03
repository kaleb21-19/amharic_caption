import Link from "next/link";

export default function Footer({ lang = "am" }) {
  const t = {
    tagline:
      lang === "am"
        ? "ለAdobe Premiere Pro የአማርኛ ንግግር-ወደ-ጽሑፍ ትርጉም አድራጊ መደርደሪያ።"
        : "Amharic speech-to-text captions for Adobe Premiere Pro.",
    rights: lang === "am" ? "መብቱ በህግ የተጠበቀ ነው" : "All rights reserved",
    support: lang === "am" ? "ድጋፍ" : "Support",
    switch: lang === "am" ? "English" : "አማርኛ",
    switchHref: lang === "am" ? "/en/" : "/",
  };

  return (
    <footer className="site-footer">
      <div className="container footer-inner">
        <div>
          <p className="footer-brand">Amharic Captions</p>
          <p>{t.tagline}</p>
        </div>
        <div className="footer-links">
          <Link href="https://t.me/sumpak6">{t.support}</Link>
          <Link href={t.switchHref}>{t.switch}</Link>
          <span>Telebirr: 0907 628 809</span>
        </div>
      </div>
      <div className="container footer-bottom">
        <p>© {new Date().getFullYear()} — {t.rights}</p>
      </div>
    </footer>
  );
}
