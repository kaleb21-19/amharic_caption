import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import { BOT_URL, PRICE, PRICE_NUM, PRICE_OLD } from "@/lib/site";

const features = [
  {
    icon: "◉",
    title: "100% on-device",
    text: "Everything runs on your own machine. No uploads, no cloud, no internet needed after install. Your footage never leaves your computer.",
  },
  {
    icon: "⚡",
    title: "Straight onto the timeline",
    text: "Captions land as an editable caption track inside Premiere — not a file you have to fiddle with.",
  },
  {
    icon: "✓",
    title: "Works on Windows & Mac",
    text: "One license, both platforms — macOS (Intel and Apple Silicon) and Windows 10/11.",
  },
  {
    icon: "❝",
    title: "Built for Amharic",
    text: "A local Amharic speech-to-text engine trained for real Amharic speech — not an afterthought.",
  },
  {
    icon: "★",
    title: "Free 2-caption trial",
    text: "Every machine gets 2 free captions first, so you can be sure before you pay. No card required.",
  },
  {
    icon: "∞",
    title: "Lifetime license",
    text: `A single ${PRICE} payment for a permanent license key. No subscriptions, no recurring fees, ever.`,
  },
];

// What a cloud captioning service costs the user — the honest trade-off.
const offlineCompare = [
  { row: "Your footage stays on your computer", offline: "Yes", cloud: "Uploaded to their servers" },
  { row: "Works without internet / data plan", offline: "Yes", cloud: "Needs a connection" },
  { row: "Faster than upload + wait + download", offline: "Yes", cloud: "Depends on your upload speed" },
  { row: "No per-minute or monthly fees", offline: "Yes", cloud: "Often subscription or metered" },
  { row: "Keeps working after purchase", offline: "Yes", cloud: "Dies if service shuts down" },
];

const steps = [
  { n: "01", title: "Install", text: "Unzip and run the included one-click installer. Done in minutes — no Terminal, no registry." },
  { n: "02", title: "Pick your clip", text: "Select a clip on your timeline or the whole edit in Premiere Pro." },
  { n: "03", title: "Activate & generate", text: "Paste your lifetime license key once, then captions land on a caption track — offline." },
];

export default function HomePage() {
  return (
    <>
      <section className="hero" id="top">
        <div className="container">
          <p className="eyebrow">100% Offline · Adobe Premiere Pro · Windows &amp; macOS</p>
          <h1>
            Amharic captions in Premiere Pro —{" "}
            <span className="accent">fully on your machine.</span>
          </h1>
          <p className="hero-sub">
            Turn Amharic speech into perfectly timed, editable captions with nothing uploaded,
            nothing stored in the cloud, and no internet needed. Your footage stays yours —
            always.
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
            Free 2-caption trial first · One-time <span className="price-old-inline">{PRICE_OLD}</span> →{" "}
            <strong>{PRICE}</strong> · No subscription · No uploads
          </p>
        </div>

        <div className="hero-shot" aria-hidden="true">
          <div className="app-window">
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
            <h2>Your content is your business. It never leaves your machine.</h2>
            <p className="section-sub">
              Cloud caption tools mean uploading your cuts, waiting, and trusting a server with
              client footage. Amharic Captions Pro does the work where your Premiere project
              already lives — on your computer.
            </p>
          </Reveal>

          <div className="offline-grid">
            <Reveal><div className="offline-card">
              <span className="offline-icon" aria-hidden="true">🔒</span>
              <h3>Client-safe privacy</h3>
              <p>News, weddings, interviews, corporate clips — sensitive footage never crosses your network, so there is nothing to leak or license.</p>
            </div></Reveal>
            <Reveal delay={90}><div className="offline-card">
              <span className="offline-icon" aria-hidden="true">📶</span>
              <h3>Works with no internet</h3>
              <p>Patchy connection, expensive data, or fully offline? Transcribe anywhere — your machine is the only thing you need.</p>
            </div></Reveal>
            <Reveal delay={180}><div className="offline-card">
              <span className="offline-icon" aria-hidden="true">⏱</span>
              <h3>No upload, no waiting</h3>
              <p>No sending GBs to a server and waiting for the queue. Captions start when you click generate — not when their server frees up.</p>
            </div></Reveal>
          </div>

          <Reveal delay={120}>
            <div className="compare-wrap">
              <table className="compare">
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col"><span className="pill pill-go">✓ Amharic Captions Pro</span></th>
                    <th scope="col"><span className="pill pill-cloud">☁ Cloud caption services</span></th>
                  </tr>
                </thead>
                <tbody>
                  {offlineCompare.map((r) => (
                    <tr key={r.row}>
                      <th scope="row">{r.row}</th>
                      <td className="td-go">✓ {r.offline}</td>
                      <td className="td-muted">{r.cloud}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="features section" id="features">
        <div className="container">
          <Reveal>
            <h2>Everything you need to caption Amharic well.</h2>
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
                no per-minute fees, no time bombs.
              </p>
              <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
                Buy now on Telegram
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      <BuySafely />

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
            <h2>Try 2 free captions on your own footage.</h2>
            <p>No uploads. No card. No subscription. If you love it, one payment keeps it forever.</p>
            <a className="btn btn-light btn-lg" href={BOT_URL} target="_blank" rel="noopener">
              Start your free trial
            </a>
          </Reveal>
        </div>
      </section>
    </>
  );
}