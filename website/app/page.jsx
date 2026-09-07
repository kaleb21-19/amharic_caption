import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import { BOT_URL, PRICE, PRICE_NUM, PRICE_OLD } from "@/lib/site";

const features = [
  {
    icon: "◉",
    title: "Runs 100% on-device",
    text: "Your footage never leaves your computer. No uploads, no cloud, no internet needed after install. Your content stays yours.",
  },
  {
    icon: "⚡",
    title: "Straight onto the timeline",
    text: "Captions are placed as an editable caption track in Premiere — not a file you have to fiddle with.",
  },
  {
    icon: "✓",
    title: "Works on Windows & Mac",
    text: "One license, both platforms — macOS (Intel and Apple Silicon) and Windows 10/11.",
  },
  {
    icon: "❝",
    title: "Built for Amharic",
    text: "A local Amharic speech-to-text model made for real Amharic speech, not an afterthought.",
  },
  {
    icon: "★",
    title: "Free 2-caption trial",
    text: "Every machine gets 2 free captions first, so you can be sure before you pay. No card required.",
  },
  {
    icon: "∞",
    title: "One-time price",
    text: `A single ${PRICE} payment. No subscriptions, no recurring fees, no lock-in. Was ${PRICE_OLD}.`,
  },
];

const steps = [
  { n: "01", title: "Install", text: "Unzip and drop into your Adobe CEP extensions folder — takes a couple of minutes." },
  { n: "02", title: "Pick your clip", text: "Select a clip on your timeline or the whole edit in Premiere Pro." },
  { n: "03", title: "Generate", text: "Captions land on a caption track, ready to edit and export." },
];

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <p className="eyebrow">For Adobe Premiere Pro · Windows & macOS</p>
          <h1>Amharic captions, automatically, inside Premiere Pro.</h1>
          <p className="hero-sub">
            Turn Amharic speech into perfectly timed, editable captions — on your
            own machine. No uploads, no cloud, no per-minute fees.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
              Get started via Telegram
            </a>
            <Link className="btn btn-ghost btn-lg" href="/install/">
              Install now
            </Link>
          </div>
          <p className="hero-note">2 free captions to start · One-time <span className="price-old-inline">{PRICE_OLD}</span> → <strong>{PRICE}</strong> · No subscription</p>
        </div>
      </section>

      <section className="pricing-home section">
        <div className="container">
          <Reveal>
            <div className="pricing-card">
              <span className="price-badge">Lifetime · One-time</span>
              <p className="price-label">Amharic Captions Pro — unlimited captions</p>
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

      <section className="features section" id="features">
        <div className="container">
          <Reveal>
            <h2>Everything you need to caption Amharic, without the busywork.</h2>
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
            <p className="section-sub">No export-import dance. Captions appear right on your timeline.</p>
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
          <Reveal delay={120}>
            <div className="center">
              <Link className="btn btn-primary btn-lg" href="/install/">
                See the install guide
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="cta">
        <div className="container">
          <Reveal>
            <h2>Ready to caption Amharic in minutes?</h2>
            <p>Start your free 2-caption trial today — no card required.</p>
            <a className="btn btn-light btn-lg" href={BOT_URL} target="_blank" rel="noopener">
              Get started now
            </a>
          </Reveal>
        </div>
      </section>
    </>
  );
}
