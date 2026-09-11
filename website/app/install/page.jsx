import Reveal from "@/components/Reveal";
import { DL_WIN, DL_MAC_ARM, DL_MAC_X64, RELEASES_URL, BOT_URL, GROUP_URL } from "@/lib/site";

export const metadata = {
  title: "Install — Amharic Captions for Premiere Pro",
  description:
    "Step-by-step install guide for the Amharic Captions Premiere Pro extension on Windows and macOS (Intel and Apple Silicon). Download, install into Adobe CEP extensions, and restart Premiere.",
};

const winSteps = [
  { t: "Download", c: "Get the Windows build below and unzip it (right-click the zip → Extract All). It must contain a folder named com.amharic.captions and a file named Install.cmd — keep them side by side." },
  { t: "Double-click Install.cmd", c: "Windows may ask for administrator permission — click Yes. The installer copies the extension into the correct Adobe folder and enables the required settings automatically (a window shows progress and says DONE when finished)." },
  { t: "Restart Premiere", c: "Fully quit and reopen Premiere Pro, then open Extensions > Amharic Captions." },
  { t: "Activate", c: "Copy your Machine ID, pay via the Telegram bot, and paste your license key to activate." },
];

const macSteps = [
  { t: "Download", c: "Choose the build for your chip: Apple Silicon (arm64) or Intel (x64), then unzip. It must contain a folder named com.amharic.captions and a file named Install.command — keep them side by side." },
  { t: "Double-click Install.command", c: "Terminal opens and runs the installer automatically. If macOS asks \"are you sure?\", click Open. Type your Mac password when asked. It copies the extension, clears the macOS “can't be verified” warning, and enables the required settings — no commands to type." },
  { t: "Restart Premiere", c: "Fully quit and reopen Premiere Pro, then open Extensions > Amharic Captions." },
  { t: "Activate", c: "Copy your Machine ID, pay via the Telegram bot, and paste your license key to activate." },
];

const manualNote = {
  t: "Advanced (manual)",
  c: "If your extension folder has no Install.cmd / Install.command (older download), install manually: Windows — copy com.amharic.captions into C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions, then regedit → HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.11 (Premiere 2024) or CSXS.12 (Premiere 2025) → create PlayerDebugMode=1. macOS — copy into ~/Library/Application Support/Adobe/CEP/extensions, then run xattr -dr com.apple.quarantine <path> and defaults write com.adobe.CSXS.11 PlayerDebugMode \"1\" (or CSXS.12 for 2025) in Terminal.",
};

export default function InstallPage() {
  return (
    <>
      <section className="page-hero">
        <div className="container">
          <p className="eyebrow">Installation guide</p>
          <h1>Get Amharic Captions running in minutes.</h1>
          <p className="hero-sub">
            Download your platform&apos;s build, unzip it, and double-click the
            included installer — it does the rest automatically. No Terminal, no
            registry, no copy-paste.
          </p>
        </div>
      </section>

      <section className="downloads section">
        <div className="container">
          <h2>Download</h2>
          <div className="dl-grid">
            <Reveal><div className="dl-card">
              <span className="dl-os">Windows</span>
              <h3>Windows 10 / 11</h3>
              <a className="btn btn-primary" href={DL_WIN}>Download win-x64</a>
            </div></Reveal>
            <Reveal delay={90}><div className="dl-card">
              <span className="dl-os">macOS · Apple Silicon</span>
              <h3>M1 / M2 / M3 / M4</h3>
              <a className="btn btn-primary" href={DL_MAC_ARM}>Download mac-arm64</a>
            </div></Reveal>
            <Reveal delay={180}><div className="dl-card">
              <span className="dl-os">macOS · Intel</span>
              <h3>Intel Mac</h3>
              <a className="btn btn-primary" href={DL_MAC_X64}>Download mac-x64</a>
            </div></Reveal>
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
                  <Reveal key={i} delay={i * 80}><div className="nstep">
                    <span>{i + 1}</span>
                    <div><h3>{s.t}</h3><p>{s.c}</p></div>
                  </div></Reveal>
                ))}
              </div>
            </div>
            <div>
              <h2>macOS</h2>
              <div className="numbered">
                {macSteps.map((s, i) => (
                  <Reveal key={i} delay={i * 80}><div className="nstep">
                    <span>{i + 1}</span>
                    <div><h3>{s.t}</h3><p>{s.c}</p></div>
                  </div></Reveal>
                ))}
              </div>
            </div>
          </div>
          <details className="manual-note">
            <summary>{manualNote.t}</summary>
            <p>{manualNote.c}</p>
          </details>
        </div>
      </section>

      <section className="note-section section">
        <div className="container">
          <Reveal><div className="tip">
            <h3>Need a hand?</h3>
            <p>
              Stuck on any step? Join our Telegram group — the full Windows &
              macOS guides live there with images, and members help fast.
            </p>
            <div className="tip-actions">
              <a className="btn btn-primary" href={GROUP_URL} target="_blank" rel="noopener">Join the group</a>
              <a className="btn btn-ghost" href={BOT_URL} target="_blank" rel="noopener">Buy / activate via bot</a>
            </div>
          </div></Reveal>
        </div>
      </section>
    </>
  );
}
