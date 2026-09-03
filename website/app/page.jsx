import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { BOT_URL } from "@/lib/site";

const steps = [
  {
    n: "01",
    title: "Pick your clip",
    text: "Select a clip on your timeline or the whole edit in Premiere Pro.",
  },
  {
    n: "02",
    title: "Generate",
    text: "Hit Generate — the Amharic ASR runs locally on your machine.",
  },
  {
    n: "03",
    title: "Edit & export",
    text: "Captions land on a caption track, fully editable and repositionable.",
  },
];

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
    text: "A single ETB 1,500 payment. No subscriptions, no recurring fees, no lock-in.",
  },
];

export default function HomePage() {
  return (
    <>
      <Header />

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
            <a className="btn btn-ghost btn-lg" href="#how">
              See how it works
            </a>
          </div>
          <p className="hero-note">2 free captions to start · One-time ETB 1,500 · No subscription</p>

          <div className="hero-shot">
            <a className="shot" href="#demo">
              <div className="shot-frame">
                {/* Swap public/images/screenshot.svg for your real panel screenshot
                    (save as public/images/screenshot.png and update src below). */}
                <img
                  src="/amharic_caption/images/screenshot.svg"
                  alt="Amharic Captions panel in Premiere Pro with generated captions"
                />
              </div>
            </a>
          </div>
        </div>
      </section>

      <section className="logos section">
        <div className="container">
          <p className="muted-center">Works with the editing tools you already use</p>
        </div>
      </section>

      <section className="features section" id="features">
        <div className="container">
          <h2>Everything you need to caption Amharic, without the busywork.</h2>
          <p className="section-sub">Built around one idea: captioning should never slow your edit down.</p>
          <div className="grid">
            {features.map((f) => (
              <article className="card" key={f.title}>
                <span className="card-icon" aria-hidden="true">{f.icon}</span>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="how section" id="how">
        <div className="container">
          <h2>From speech to captions in three steps.</h2>
          <p className="section-sub">No export-import dance. Captions appear right on your timeline.</p>
          <div className="steps">
            {steps.map((s) => (
              <div className="step" key={s.n}>
                <span className="step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
              </div>
            ))}
          </div>
          <div className="center">
            <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
              Get Amharic Captions
            </a>
          </div>
        </div>
      </section>

      <section className="pricing section" id="pricing">
        <div className="container">
          <h2>Simple, honest pricing.</h2>
          <p className="section-sub">Pay once. Own it forever.</p>
          <div className="pricing-card">
            <p className="price-label">Lifetime license</p>
            <p className="price"><span className="cur">ETB</span> 1,500</p>
            <p className="price-sub">≈ $30 · One-time payment</p>
            <ul className="price-features">
              <li>Unlimited captions — no per-minute fees</li>
              <li>Premiere Pro 2024+ · Windows & macOS</li>
              <li>2 free captions before you pay</li>
              <li>Editable, native caption tracks</li>
              <li>Support from the team on Telegram</li>
            </ul>
            <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
              Buy now via Telegram
            </a>
            <p className="tiny">Secure order &amp; license delivery through our Telegram bot</p>
          </div>
        </div>
      </section>

      <section className="faq section" id="faq">
        <div className="container">
          <h2>Frequently asked questions.</h2>
          <div className="faq-list">
            <details>
              <summary>Do I need internet to use it?</summary>
              <p>No. Transcription runs fully on your machine. You only need internet to install and receive your license key.</p>
            </details>
            <details>
              <summary>Is my footage uploaded anywhere?</summary>
              <p>Never. Everything happens locally — your video and audio never leave your computer.</p>
            </details>
            <details>
              <summary>Which Premiere Pro versions work?</summary>
              <p>Premiere Pro 2024 (v24) and newer, on Windows 10/11 and macOS (Intel or Apple Silicon).</p>
            </details>
            <details>
              <summary>How does the license work?</summary>
              <p>One license per machine, hardware-locked to your computer. A free 2-caption trial lets you test before buying.</p>
            </details>
            <details>
              <summary>How do I pay and get my key?</summary>
              <p>Order through our Telegram bot, pay ETB 1,500 via Telebirr, and the bot delivers your license key instantly.</p>
            </details>
          </div>
        </div>
      </section>

      <section className="cta">
        <div className="container">
          <h2>Ready to caption Amharic in minutes?</h2>
          <p>Start your free 2-caption trial today — no card required.</p>
          <a className="btn btn-light btn-lg" href={BOT_URL} target="_blank" rel="noopener">
            Get started now
          </a>
        </div>
      </section>

      <Footer />
    </>
  );
}
