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

const faqs = [
  {
    q: "Do I need internet to use it?",
    a: "No. Transcription runs entirely on your machine. You need internet once to install (the small download fetches the Amharic model once, and continues if your connection drops) and once to receive your license key — after that you can work completely offline.",
  },
  {
    q: "I don't use Premiere. Can I still use it?",
    a: "Yes. The installer adds a “Make Amharic Captions” shortcut to your desktop. On Windows, drag any video onto it; on a Mac, double-click it and drag the video into the window. An .srt subtitle file appears next to the video, ready for CapCut, DaVinci Resolve, older Premiere versions or YouTube. Same key, same 2 free captions.",
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
    q: "Which Adobe versions work?",
    a: "Premiere Pro 2024 (v24) and newer, on Windows 10/11 and macOS (Intel or Apple Silicon). After Effects 2024 and newer is supported too — captions arrive as one text layer in your composition. The panel does not load on 2021–2023 versions; use the drag-and-drop .srt tool there instead.",
  },
  {
    q: "How accurate is it?",
    a: "Accuracy varies substantially with the speaker, accent, recording, noise, and echo. The current model is not yet validated against the project's ≤15% real-audio WER target, so treat every transcription as a draft that needs review and correction before publishing.",
  },
  {
    q: "How does the license work?",
    a: "One key per licensed installation, file-bound to the panel identity. Pay once; keys are perpetual by default unless the seller explicitly issues a dated key. Do not share the identity/license files.",
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
            <div className="hero-copy">
              <p className="eyebrow">For Premiere Pro, After Effects &amp; any editor</p>

              <h1>
                Amharic subtitles in minutes,
                <br className="hide-sm" /> not hours.
              </h1>

              <p className="hero-sub">
                Generate editable Amharic captions straight onto your Premiere timeline —
                instead of typing every line by hand.
              </p>

              <p className="hero-amh amh" lang="am">
                የአማርኛ ጽሑፍ በደቂቃዎች ውስጥ — በፕሪሚየር ፕሮ ውስጥ በቀጥታ።
              </p>

              <div className="hero-cta cta-row">
                <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                  Get your key — {PRICE}
                </a>
                <Link className="btn btn-ghost btn-lg" href="/install/">
                  Install guide
                </Link>
              </div>

              <p className="hero-note">
                Try 2 captions free first · One-time payment · No subscription
              </p>
            </div>

            {/* Deliberately NOT wrapped in Reveal: this is the hero visual and
                the largest paint on the page. Fading it in delays the one thing
                a visitor came to see, for an effect they never scrolled to. */}
            <div className="hero-visual">
              <PanelMock />
            </div>
          </div>
        </div>
      </section>

      {/* A thin band, not a section: the practical reasons this matters to an
          editor in Ethiopia, said plainly. Replaces the old "Why offline"
          section, which explained a technical concept instead of a benefit. */}
      <section className="strip">
        <div className="container">
          <ul className="strip-list">
            <li>
              <strong>No internet needed</strong>
              <span>Works when the connection doesn&apos;t</span>
            </li>
            <li>
              <strong>No data charges</strong>
              <span>Nothing is uploaded, ever</span>
            </li>
            <li>
              <strong>No monthly fee</strong>
              <span>Pay once; perpetual by default</span>
            </li>
          </ul>
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

      {/* ----------------------------------------------------- audio quality */}
      <section className="section" id="quality">
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
              <h2>One-time license, perpetual by default.</h2>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="price-card">
              <span className="price-badge">One-time · Perpetual by default</span>
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
                <li>After Effects 2024+ and a drag-and-drop .srt maker for CapCut &amp; DaVinci</li>
                <li>Panel in Amharic or English</li>
                <li>Works fully offline after activation</li>
                <li>Support on Telegram from the people who built it</li>
              </ul>

              <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
                Get your key on Telegram
              </a>
              <p className="tiny">
                Pay by bank transfer. The bot confirms your payment and sends the key straight
                into the chat, file-bound to that installation. <a href="#safety">Verify the official accounts</a>.
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
                  Get your license key
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
