import Link from "next/link";
import { BOT_URL } from "@/lib/site";

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
          <p className="hero-note">2 free captions to start · One-time ETB 1,500 · No subscription</p>

          <div className="hero-shot">
            <div className="shot-frame">
              <img
                src="/amharic_caption/images/panel-hi.png"
                alt="Amharic Captions panel in Premiere Pro with generated Amharic captions"
              />
            </div>
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
          <h2>From install to captions in minutes.</h2>
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
            <Link className="btn btn-primary btn-lg" href="/install/">
              See the install guide
            </Link>
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
    </>
  );
}
