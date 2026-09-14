import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import { BOT_URL, PRICE, PRICE_NUM, PRICE_OLD } from "@/lib/site";

const steps = [
  { n: "01", title: "Install", text: "Run the one-click installer. Done in minutes — no Terminal, no registry." },
  { n: "02", title: "Choose your clip", text: "Select a clip on your timeline or the whole edit." },
  { n: "03", title: "Generate", text: "Paste your lifetime key once, then captions land on your timeline." },
];

export default function HomePage() {
  return (
    <>
      <section className="hero" id="top">
        <div className="container">
          <p className="eyebrow">For Adobe Premiere Pro · Windows 10/11 · macOS</p>
          <h1 className="hero-h1">
            <span className="hero-peak">100% offline.</span>
            <span className="hero-h1-rest">Amharic captions for Adobe Premiere&nbsp;Pro.</span>
          </h1>
          <p className="hero-sub">
            Turn Amharic speech into editable captions — no uploads, no cloud, no internet needed.
          </p>
          <p className="hero-amh amh" lang="am">በፕሪሚየር ፕሮ ውስጥ የአማርኛ ትርጉም — ሙሉ በሙሉ በኮምፒውተርዎ ላይ</p>
          <div className="hero-cta">
            <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
              Get your lifetime key
            </a>
            <Link className="btn btn-ghost btn-lg" href="/install/">
              Install now
            </Link>
          </div>
          <p className="hero-note">
            Free 2-caption trial first · One-time <strong>{PRICE}</strong> · Lifetime license
          </p>

          <div className="hero-stats">
            <div className="hero-stat"><strong>0%</strong><span>footage uploaded</span></div>
            <div className="hero-stat"><strong>100%</strong><span>on-device</span></div>
            <div className="hero-stat"><strong>∞</strong><span>lifetime license</span></div>
            <div className="hero-stat"><strong>2</strong><span>free captions</span></div>
          </div>
        </div>
      </section>

      <section className="offline section" id="offline">
        <div className="container">
          <Reveal>
            <p className="eyebrow">Why it matters</p>
            <h2>Fully offline, fully on your machine.</h2>
            <p className="section-sub">
              No uploads, no cloud, no internet. The work happens on your computer — exactly
              where your Premiere project already lives.
            </p>
          </Reveal>

          <div className="offline-grid">
            <Reveal><div className="offline-card">
              <span className="offline-icon" aria-hidden="true">🔒</span>
              <h3>Client-safe privacy</h3>
              <p>Sensitive footage never crosses your network — nothing to leak, nothing to license.</p>
            </div></Reveal>
            <Reveal delay={90}><div className="offline-card">
              <span className="offline-icon" aria-hidden="true">📶</span>
              <h3>Works with no internet</h3>
              <p>Patchy connection, expensive data, or none at all — your machine is all you need.</p>
            </div></Reveal>
            <Reveal delay={180}><div className="offline-card">
              <span className="offline-icon" aria-hidden="true">⏱</span>
              <h3>No upload, no waiting</h3>
              <p>Captions start when you click generate. No queue, no server time.</p>
            </div></Reveal>
          </div>
        </div>
      </section>

      <section className="how section" id="how">
        <div className="container">
          <Reveal>
            <h2>From install to captions in minutes.</h2>
            <p className="section-sub">Captions appear right on your timeline.</p>
          </Reveal>
          <div className="steps">
            {steps.map((s, i) => (
              <Reveal key={s.n} delay={i * 120}>
                <div className="step">
                  <span className="step-n">{s.n}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="pricing-home section">
        <div className="container">
          <Reveal>
            <div className="pricing-card">
              <span className="price-badge">Lifetime · One-time · Never expires</span>
              <p className="price-label">Amharic Captions Pro — a permanent license key</p>
              <p className="price">
                <span className="price-old">{PRICE_OLD}</span>{" "}
                <span className="cur">ETB</span> {Number(PRICE_NUM).toLocaleString("en-US")}
              </p>
              <p className="price-sub">
                2 free captions first — then one payment, forever. No subscription,
                no per-minute fees.
              </p>
              <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
                Buy now on Telegram
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      <BuySafely />
    </>
  );
}