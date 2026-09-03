import { BOT_URL, SUPPORT_URL } from "@/lib/site";

export const metadata = {
  title: "FAQ — Amharic Captions for Premiere Pro",
  description:
    "Answers to common questions about Amharic Captions: internet needs, privacy, supported Premiere versions, licensing, payment, and installation.",
};

const faqs = [
  { q: "Do I need internet to use it?", a: "No. Transcription runs fully on your machine. You only need internet to install and to receive your license key." },
  { q: "Is my footage uploaded anywhere?", a: "Never. Everything happens locally — your video and audio never leave your computer." },
  { q: "Which Premiere Pro versions work?", a: "Premiere Pro 2024 (v24) and newer, on Windows 10/11 and macOS (Intel or Apple Silicon)." },
  { q: "How does the license work?", a: "One license per machine, hardware-locked to your computer. A free 2-caption trial lets you test before buying." },
  { q: "How do I pay and get my key?", a: "Order through our Telegram bot (@AmharicCaptionsBot), pay ETB 1,500 via Telebirr, and the bot delivers your license key instantly." },
  { q: "Can I try it before paying?", a: "Yes — every new machine gets 2 free captions to try on your own Premiere, no card required." },
  { q: "What if Premiere doesn't show the panel?", a: "Third-party extensions need the CEP debug mode enabled for your Premiere version. Message us on Telegram and we'll walk you through it." },
  { q: "Do I need a separate license for each computer?", a: "Yes. The key is hardware-locked to a single machine to prevent sharing." },
];

export default function FaqPage() {
  return (
    <>
      <section className="page-hero">
        <div className="container">
          <p className="eyebrow">Help</p>
          <h1>Frequently asked questions.</h1>
          <p className="hero-sub">Everything you need to know before you install and buy.</p>
        </div>
      </section>

      <section className="faq section">
        <div className="container">
          <div className="faq-list">
            {faqs.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
          <div className="center help-cta">
            <p>Still have a question or hit a snag?</p>
            <a className="btn btn-primary" href={BOT_URL} target="_blank" rel="noopener">
              Ask us on Telegram
            </a>
          </div>
        </div>
      </section>
    </>
  );
}
