import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import PanelMock from "@/components/PanelMock";
import { BOT_URL, PRICE, PRICE_NUM, PRICE_OLD_NUM } from "@/lib/site";

const steps = [
  {
    n: "1",
    title: "Install once",
    text: "Run the installer and restart Premiere. No Terminal, no registry editing, no admin rights.",
  },
  {
    n: "2",
    title: "Pick your clip",
    text: "Select a clip, a work area, or the whole sequence — then choose grouped or karaoke captions.",
  },
  {
    n: "3",
    title: "Generate",
    text: "Captions land on your timeline as an editable caption track, timed to your edit.",
  },
];

// The comparison every competitor forces and this site never made. Each cloud
// tool listed genuinely requires an upload and a recurring fee; the figures are
// their own published entry prices.
const compareRows = [
  ["Where your footage goes", "Never leaves your computer", "Uploaded to their servers"],
  ["Works without internet", "Yes — fully offline", "No — upload required"],
  ["Cost", "One payment, forever", "Monthly, forever"],
  ["Per-minute fees", "None — caption all you like", "Common once your quota runs out"],
  ["Where captions appear", "On your Premiere timeline", "Download a file, then import it"],
  ["Client confidentiality", "Nothing to leak", "Depends on their policy"],
];

const faqs = [
  {
    q: "Do I need internet to use it?",
    a: "No. Transcription runs entirely on your machine. You need internet once to install and once to receive your license key — after that you can work completely offline.",
  },
  {
    q: "Is my footage uploaded anywhere?",
    a: "Never. Your video and audio never leave your computer. There is no server to send it to, which is why it works with no connection at all.",
  },
  {
    q: "Can I try it before paying?",
    a: "Yes. Every new machine gets 2 free captions so you can test it on your own footage in your own Premiere before you pay anything.",
  },
  {
    q: "Which Premiere versions work?",
    a: "Premiere Pro 2024 (v24) and newer, on Windows 10/11 and macOS (Intel or Apple Silicon). It does not load on Premiere 2021–2023.",
  },
  {
    q: "How accurate is it?",
    a: "On clear speech it is strong enough to be much faster than typing from scratch — you review and fix rather than type. Accuracy drops on heavy echo (large halls, churches) and phone-recorded audio, so those clips need more editing. See the audio guidance above.",
  },
  {
    q: "How does the license work?",
    a: "One key per computer, locked to that machine. Pay once and it never expires. If you reinstall on the same machine your key keeps working; message support to move it to a new one.",
  },
];

export const metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  const priceLbl = Number(PRICE_NUM).toLocaleString("en-US");
  const oldLbl = Number(PRICE_OLD_NUM).toLocaleString("en-US");

  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />

      {/* ---------------------------------------------------------- hero */}
      <section className="hero" id="top">
        <div className="container">
          <div className="hero-grid">
            <div>
              <span className="hero-peak">100% offline · nothing uploaded</span>
              <h1>Amharic captions, right inside Premiere&nbsp;Pro.</h1>
              <p className="hero-sub">
                Turn Amharic speech into an editable caption track on your timeline —
                without uploading a single frame.
              </p>
              <p className="hero-amh amh" lang="am">
                የአማርኛ ጽሑፍ በቀጥታ በፕሪሚየር ፕሮ ውስጥ — ሙሉ በሙሉ በኮምፒውተርዎ ላይ።
              </p>

              <div className="hero-cta cta-row">
                <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                  Get your lifetime key
                </a>
                <Link className="btn btn-ghost btn-lg" href="/install/">
                  Install guide
                </Link>
              </div>
              <p className="hero-note">
                2 free captions first · One-time <strong>{PRICE}</strong> · Never expires
              </p>

              <div className="hero-stats">
                <div className="hero-stat"><strong>0</strong><span>frames uploaded</span></div>
                <div className="hero-stat"><strong>100%</strong><span>on your machine</span></div>
                <div className="hero-stat"><strong>2</strong><span>free captions</span></div>
                <div className="hero-stat"><strong>∞</strong><span>lifetime license</span></div>
              </div>
            </div>

            <Reveal delay={120}>
              <PanelMock />
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- why offline */}
      <section className="section" id="offline">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow">Why it matters</p>
              <h2>Your footage never leaves the room.</h2>
              <p className="section-sub">
                Every other Amharic transcription tool asks you to upload your video first.
                This one doesn&apos;t — the work happens where your project already lives.
              </p>
            </div>
          </Reveal>

          <div className="grid-3">
            <Reveal>
              <div className="card">
                <span className="card-icon" aria-hidden="true">🔒</span>
                <h3>Client-safe by design</h3>
                <p>
                  Unreleased footage, interviews, private events — none of it crosses your
                  network. There is nothing to leak because nothing is sent.
                </p>
              </div>
            </Reveal>
            <Reveal delay={90}>
              <div className="card">
                <span className="card-icon" aria-hidden="true">📶</span>
                <h3>No connection needed</h3>
                <p>
                  Patchy network, expensive data, or none at all. Once installed it runs the
                  same whether you&apos;re online or not.
                </p>
              </div>
            </Reveal>
            <Reveal delay={180}>
              <div className="card">
                <span className="card-icon" aria-hidden="true">⏱</span>
                <h3>No upload, no queue</h3>
                <p>
                  A one-hour interview is gigabytes. Skip the upload entirely — captions start
                  the moment you press generate.
                </p>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="section" id="how" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow">How it works</p>
              <h2>Three steps, then you&apos;re editing.</h2>
            </div>
          </Reveal>
          <div className="steps">
            {steps.map((s, i) => (
              <Reveal key={s.n} delay={i * 110}>
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

      {/* -------------------------------------------------------- comparison */}
      <section className="section" id="compare">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow">The difference</p>
              <h2>Offline and yours, versus rented in the cloud.</h2>
              <p className="section-sub">
                Cloud transcription services charge every month and need your footage on their
                servers. This is a one-time purchase that runs on your own machine.
              </p>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="compare-wrap">
              <table className="compare">
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col" className="col-us">Amharic Captions Pro</th>
                    <th scope="col">Cloud transcription tools</th>
                  </tr>
                </thead>
                <tbody>
                  {compareRows.map(([label, us, them]) => (
                    <tr key={label}>
                      <th scope="row">{label}</th>
                      <td className="col-us">{us}</td>
                      <td>{them}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="scroll-hint">Swipe the table sideways to compare →</p>
          </Reveal>
        </div>
      </section>

      {/* ----------------------------------------------------- audio quality */}
      <section className="section" id="quality" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow">Be realistic</p>
              <h2>What kind of audio works best.</h2>
              <p className="section-sub">
                No speech-to-text is perfect, and we&apos;d rather you know where it shines
                before you buy than be disappointed after.
              </p>
            </div>
          </Reveal>

          <div className="quality">
            <Reveal>
              <div className="q-card q-good">
                <h3>✓ Works great</h3>
                <ul>
                  <li><strong>Clear speech</strong> — studio, news-style delivery</li>
                  <li><strong>Close microphone</strong> — lapel or desk mic</li>
                  <li><strong>Quiet background</strong> — little noise behind the voice</li>
                  <li><strong>Normal rooms</strong> — offices, small studios</li>
                </ul>
              </div>
            </Reveal>
            <Reveal delay={90}>
              <div className="q-card q-warn">
                <h3>⚠ Needs more editing</h3>
                <ul>
                  <li><strong>Phone recordings</strong> — narrow, compressed audio</li>
                  <li><strong>Outdoor footage</strong> — wind, traffic, crowds</li>
                  <li><strong>Overlapping speakers</strong> — people talking across each other</li>
                </ul>
              </div>
            </Reveal>
            <Reveal delay={180}>
              <div className="q-card q-avoid">
                <h3>✗ Struggles</h3>
                <ul>
                  <li><strong>Big halls and churches</strong> — strong echo is the hardest case</li>
                  <li><strong>Loud music under speech</strong> — mute the music track first</li>
                  <li><strong>Very low-quality mics</strong> — use your best available audio</li>
                </ul>
              </div>
            </Reveal>
          </div>

          <Reveal delay={240}>
            <div className="note-box">
              <p>
                <strong>Pro tip:</strong> if your footage has a music bed, mute the music track in
                Premiere before generating, then unmute it afterwards. Captions are timed to the
                original timeline, so your music stays untouched in the final cut.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------ pricing */}
      <section className="section" id="pricing">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow">Pricing</p>
              <h2>Pay once. Keep it forever.</h2>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="price-card">
              <span className="price-badge">Lifetime · One-time · Never expires</span>
              <div className="price">
                <span className="price-old">ETB {oldLbl}</span>
                <span className="price-cur">ETB</span>
                <span className="price-now">{priceLbl}</span>
              </div>
              <p className="price-sub">
                One payment. No subscription, no per-minute fees, no renewal.
              </p>

              <ul className="price-features">
                <li>Unlimited captions — caption as much as you like</li>
                <li>2 free captions before you pay anything</li>
                <li>Editable caption tracks, native to Premiere</li>
                <li>Premiere Pro 2024+ · Windows 10/11 &amp; macOS</li>
                <li>Works fully offline, forever</li>
                <li>Support on Telegram from the people who built it</li>
              </ul>

              <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
                Get your key on Telegram
              </a>
              <p className="tiny">
                Pay by bank transfer. The bot confirms your payment and sends the key straight
                into the chat, locked to your machine. <a href="#safety">Verify the official accounts</a>.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      <BuySafely />

      {/* ---------------------------------------------------------------- faq */}
      <section className="section" id="faq" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow">Questions</p>
              <h2>Before you buy.</h2>
            </div>
          </Reveal>

          <div className="faq-list">
            {faqs.map((f, i) => (
              <Reveal key={f.q} delay={i * 50}>
                <details>
                  <summary>{f.q}</summary>
                  <p>{f.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- final push */}
      <section className="section">
        <div className="container">
          <Reveal>
            <div className="final-cta">
              <h2>Stop typing Amharic captions by hand.</h2>
              <p className="section-sub" style={{ marginInline: "auto" }}>
                Try it free on your own footage — two captions, no payment, no account.
              </p>
              <div className="cta-row">
                <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                  Get your lifetime key
                </a>
                <Link className="btn btn-ghost btn-lg" href="/install/">
                  Read the install guide
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
