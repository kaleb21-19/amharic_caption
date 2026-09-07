import Reveal from "@/components/Reveal";
import { DL_WIN, DL_MAC_ARM, DL_MAC_X64, RELEASES_URL, BOT_URL } from "@/lib/site";

export const metadata = {
  title: "Install — Amharic Captions for Premiere Pro",
  description:
    "Step-by-step install guide for the Amharic Captions Premiere Pro extension on Windows and macOS (Intel and Apple Silicon). Download, install into Adobe CEP extensions, and restart Premiere.",
};

const winSteps = [
  { t: "Download", c: "Get the Windows build below and unzip it (right-click the zip → Extract All). Make sure a folder named com.amharic.captions appears — do not drag files out of the zip by hand." },
  { t: "Copy to Extensions", c: "Open File Explorer and go to C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions. Copy the com.amharic.captions folder into it (click Yes if Windows asks for permission)." },
  { t: "Allow Adobe to run it", c: "Press WIN+R → type regedit → Enter (click Yes if asked). Paste HKEY_CURRENT_USER\\Software\\Adobe\\CSXS.11 into the address bar → Enter. On the right, double-click PlayerDebugMode and set it to 1. If it doesn't exist: right-click empty space → New → DWORD (32-bit) Value → name it PlayerDebugMode → set value to 1. Close regedit." },
  { t: "Restart Premiere", c: "Fully quit and reopen Premiere Pro, then open Extensions > Amharic Captions." },
  { t: "Activate", c: "Copy your Machine ID, pay via the Telegram bot, and paste your license key to activate." },
];

const macSteps = [
  { t: "Download", c: "Choose the build for your chip: Apple Silicon (arm64) or Intel (x64), then unzip." },
  { t: "Copy to Extensions", c: "Copy the com.amharic.captions folder into: ~/Library/Application Support/Adobe/CEP/extensions/" },
  { t: "Allow Adobe to run it", c: "Open Terminal (⌘+Space → type Terminal → Enter), paste defaults write com.adobe.CSXS.11 PlayerDebugMode \"1\" and press Enter. Using Premiere 2025 (v25)? Also run the same for com.adobe.CSXS.12. Close Terminal." },
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
        </div>
      </section>

      <section className="note-section section">
        <div className="container">
          <Reveal><div className="tip">
            <h3>Need a hand?</h3>
            <p>
              Stuck on any step? Message us on Telegram and we&apos;ll walk you
              through it.
            </p>
            <a className="btn btn-ghost" href={BOT_URL} target="_blank" rel="noopener">Get help on Telegram</a>
          </div></Reveal>
        </div>
      </section>
    </>
  );
}
