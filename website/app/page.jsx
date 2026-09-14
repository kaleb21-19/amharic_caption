import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import { BOT_URL, PRICE, PRICE_NUM, PRICE_OLD } from "@/lib/site";

const features = [
  {
    icon: "⚡",
    title: "Straight onto the timeline",
    text: "Captions land as an editable caption track inside Premiere — no export-import dance.",
  },
  {
    icon: "❝",
    title: "Built for Amharic",
    text: "A local Amharic speech-to-text engine trained for real Amharic speech — not an afterthought.",
  },
  {
    icon: "◉",
    title: "Works on Windows & Mac",
    text: "One license for macOS (Intel and Apple Silicon) and Windows 10/11.",
  },
  {
    icon: "✓",
    title: "Free 2-caption trial",
    text: "Every machine gets 2 free captions first. No card, no sign-up.",
  },
];

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
            Turn Amharic speech into editable captions — no uploads, no cloud, no internet
            needed. Your footage never leaves your computer.
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
        </div>

        <div className="hero-shot">
          <span className="hero-badge">No internet · No uploads · No cloud</span>
          <div className="app-window" aria-hidden="true">
            <div className="app-titlebar">
              <span className="dot d-red" />
              <span className="dot d-yellow" />
              <span className="dot d-green" />
              <span className="app-title">Amharic Captions · Premiere Pro</span>
            </div>
            <div className="app-body">
              <div className="app-sidebar">
                <span className="side-chip" />
                <span className="side-chip" />
                <span className="side-chip" />
              </div>
              <div className="app-timeline">
                <div className="trk"><span className="trk-label">V2</span><div className="trk-clip c1" /></div>
                <div className="trk"><span className="trk-label">A1</span><div className="trk-clip c2" /></div>
                <div className="trk trk-captions">
                  <span className="trk-label">CAP</span>
                  <div className="caption-line l1 amh" lang="am"><i />“እንኳን ደህና መጡ ወደ ፕሮግራማችን”</div>
                  <div className="caption-line l2 amh" lang="am"><i />“ትርጉም በደቂቃዎች ውስጥ ዝግጁ ነው”</div>
                  <div className="caption-line l1 amh" lang="am"><i />“ሁሉም ነገር በመሳሪያዎ ላይ ይሰራል”</div>
                </div>
                <div className="transport">
                  <span className="tp-btn">‹‹</span><span className="tp-btn">◀</span>
                  <span className="tp-play">▶</span><span className="tp-btn">▶‖</span>
                  <span className="tp-time">00:12 — 00:19</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="stats">
        <div className="container stats-grid">
          <Reveal delay={0}><div className="stat"><strong>0%</strong><span>of your footage ever uploaded</span></div></Reveal>
          <Reveal delay={90}><div className="stat"><strong>100%</strong><span>on-device transcription</span></div></Reveal>
          <Reveal delay={180}><div className="stat"><strong>∞</strong><span>Lifetime license — no renewals</span></div></Reveal>
          <Reveal delay={270}><div className="stat"><strong>2</strong><span>free captions before you pay</span></div></Reveal>
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

      <section className="features section" id="features">
        <div className="container">
          <Reveal>
            <h2>The essentials, done right.</h2>
            <p className="section-sub">Built around one idea: captioning should never slow your edit down.</p>
          </Reveal>
          <div className="grid">
            {features.map((f, i) => (
              <Reveal key={f.title} delay={i * 90}>
                <article className="card">
                  <span className="card-icon" aria-hidden="true">{f.icon}</span>
                  <h3>{f.title}</h3>
                  <p>{f.text}</p>
                </article>
              </Reveal>
            ))}
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