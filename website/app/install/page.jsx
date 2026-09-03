import { DL_WIN, DL_MAC_ARM, DL_MAC_X64, RELEASES_URL, BOT_URL } from "@/lib/site";

export const metadata = {
  title: "Install — Amharic Captions for Premiere Pro",
  description:
    "Step-by-step install guide for the Amharic Captions Premiere Pro extension on Windows and macOS (Intel and Apple Silicon). Download, install into Adobe CEP extensions, and restart Premiere.",
};

const winSteps = [
  { t: "Download", c: "Get the Windows build below and unzip it anywhere." },
  { t: "Copy to Extensions", c: "Copy the com.amharic.captions folder into: C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions\\" },
  { t: "Restart Premiere", c: "Fully quit and reopen Premiere Pro, then open Extensions > Amharic Captions." },
  { t: "Activate", c: "Copy your Machine ID, pay via the Telegram bot, and paste your license key to activate." },
];

const macSteps = [
  { t: "Download", c: "Choose the build for your chip: Apple Silicon (arm64) or Intel (x64), then unzip." },
  { t: "Copy to Extensions", c: "Copy the com.amharic.captions folder into: ~/Library/Application Support/Adobe/CEP/extensions/" },
  { t: "Restart Premiere", c: "Fully quit and reopen Premiere Pro, then open Extensions > Amharic Captions." },
  { t: "Activate", c: "Copy your Machine ID, pay via the Telegram bot, and paste your license key to activate." },
];

export default function InstallPage() {
  return (
    <>
      <section className="page-hero">
        <div className="container">
          <p className="eyebrow">Installation guide</p>
          <h1>Get Amharic Captions running in minutes.</h1>
          <p className="hero-sub">
            Download your platform&apos;s build, drop it into Adobe&apos;s CEP
            extensions folder, and restart Premiere. No coding, no hoops.
          </p>
        </div>
      </section>

      <section className="downloads section">
        <div className="container">
          <h2>Download</h2>
          <div className="dl-grid">
            <div className="dl-card">
              <span className="dl-os">Windows</span>
              <h3>Windows 10 / 11</h3>
              <a className="btn btn-primary" href={DL_WIN}>Download win-x64</a>
            </div>
            <div className="dl-card">
              <span className="dl-os">macOS · Apple Silicon</span>
              <h3>M1 / M2 / M3 / M4</h3>
              <a className="btn btn-primary" href={DL_MAC_ARM}>Download mac-arm64</a>
            </div>
            <div className="dl-card">
              <span className="dl-os">macOS · Intel</span>
              <h3>Intel Mac</h3>
              <a className="btn btn-primary" href={DL_MAC_X64}>Download mac-x64</a>
            </div>
          </div>
          <p className="center-note">
            Need another option? Browse <a href={RELEASES_URL} target="_blank" rel="noopener">all releases</a>.
          </p>
        </div>
      </section>

      <section className="install-steps section">
        <div className="container">
          <div className="os-tabs">
            <div>
              <h2>Windows</h2>
              <div className="numbered">
                {winSteps.map((s, i) => (
                  <div className="nstep" key={i}>
                    <span>{i + 1}</span>
                    <div><h3>{s.t}</h3><p>{s.c}</p></div>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <h2>macOS</h2>
              <div className="numbered">
                {macSteps.map((s, i) => (
                  <div className="nstep" key={i}>
                    <span>{i + 1}</span>
                    <div><h3>{s.t}</h3><p>{s.c}</p></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="note-section section">
        <div className="container">
          <div className="tip">
            <h3>Need help?</h3>
            <p>
              If Premiere doesn&apos;t show the Amharic Captions panel, you may need
              to enable the CEP debug mode for your version. Message us on Telegram
              and we&apos;ll walk you through it.
            </p>
            <a className="btn btn-ghost" href={BOT_URL} target="_blank" rel="noopener">Get help on Telegram</a>
          </div>
        </div>
      </section>
    </>
  );
}
