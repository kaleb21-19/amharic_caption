import Link from "next/link";
import InstallGuide from "@/components/InstallGuide";
import { BOT_URL, GROUP_URL, PRICE } from "@/lib/site";

export const metadata = {
  title: "Install — Amharic Captions for Premiere Pro",
  description:
    "Install the Amharic Captions panel for Adobe Premiere Pro on Windows 10/11 or macOS (Apple Silicon and Intel). Download, double-click the installer, restart Premiere.",
  alternates: { canonical: "/install/" },
};

export default function InstallPage() {
  const howToLd = {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: "Install Amharic Captions for Adobe Premiere Pro",
    totalTime: "PT5M",
    step: [
      { "@type": "HowToStep", name: "Download and unzip", text: "Download the build for your platform and extract the zip." },
      { "@type": "HowToStep", name: "Run the installer", text: "Double-click Install.cmd on Windows or Install.command on macOS." },
      { "@type": "HowToStep", name: "Restart Premiere Pro", text: "Fully quit Premiere Pro and reopen it, then open a project." },
      { "@type": "HowToStep", name: "Open the panel", text: "Window → Extensions → Amharic Captions, then activate with your license key." },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(howToLd) }}
      />

      <section className="page-hero">
        <div className="container">
          <p className="eyebrow">Installation</p>
          <h1>Running in about five minutes.</h1>
          <p className="hero-sub">
            Download, double-click the installer, restart Premiere. No Terminal, no registry
            editing, no administrator rights.
          </p>

          <div className="req-row">
            <span className="req"><b>Premiere Pro 2024+</b> (v24 or newer)</span>
            <span className="req"><b>Windows 10/11</b> or <b>macOS</b></span>
            <span className="req"><b>~1.5 GB</b> free disk space</span>
          </div>
        </div>
      </section>

      <InstallGuide />

      <section className="section" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <div className="final-cta">
            <h2>Stuck on a step?</h2>
            <p className="section-sub" style={{ marginInline: "auto" }}>
              Send us a message — the support group has illustrated Windows and macOS
              walkthroughs, and people usually reply fast.
            </p>
            <div className="cta-row">
              <a className="btn btn-primary btn-lg" href={GROUP_URL} target="_blank" rel="noopener">
                Join the support group
              </a>
              <a className="btn btn-ghost btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                Buy or activate ({PRICE})
              </a>
            </div>
            <p className="tiny" style={{ marginTop: "var(--s-5)" }}>
              Not bought yet? Every new machine gets <Link href="/#pricing">2 free captions</Link> first.
            </p>
          </div>
        </div>
      </section>
    </>
  );
}
