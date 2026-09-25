"use client";

import { useEffect, useState } from "react";
import { DL_WIN, DL_MAC_ARM, DL_MAC_X64, RELEASES_URL } from "@/lib/site";

// Install flow as a tabbed guide rather than two long parallel columns.
// Showing Windows and macOS side by side means every reader scrolls past a set
// of instructions that can only confuse them — on a phone that is two full
// screens of wrong-platform text. We detect the visitor's OS, preselect it,
// and let them switch.

const OS = {
  win: {
    id: "win",
    label: "Windows",
    sub: "Windows 10 / 11",
    file: "Install.cmd",
    steps: [
      {
        t: "Download and unzip",
        c: "Download the Windows build, then right-click the zip → Extract All. Double-clicking the zip only previews it — you must extract before the installer will run.",
        check: "You should see a folder com.amharic.captions and a file Install.cmd sitting side by side.",
      },
      {
        t: "Double-click Install.cmd",
        c: "A window opens and does everything: copies the extension into your Adobe folder and enables the setting Premiere needs. No administrator rights required.",
        check: "Wait until it prints DONE before closing the window.",
      },
      {
        t: "Fully quit Premiere, then reopen",
        c: "File → Exit. Closing the window is not enough — Premiere keeps running and will not pick up a new extension.",
        check: "Open a project first: the Extensions menu stays greyed out on the start screen.",
      },
      {
        t: "Open the panel and activate",
        c: "Window → Extensions → Amharic Captions. Copy your Machine ID, send it to the Telegram bot with your payment, and paste the key you get back.",
        check: "Two free captions work before you pay anything.",
      },
    ],
    trouble: [
      ['"Windows protected your PC" appears', 'Click More info → Run anyway. The installer is unsigned, which is normal for a tool this size — the extension itself is unchanged.'],
      ["There is no Install.cmd to click", "The zip was not extracted. Right-click it → Extract All, then open the extracted folder."],
      ["The panel does not appear in Extensions", "Premiere was not fully quit, or no project is open. Exit completely, reopen, open a project, then check the menu again."],
      ["An old version keeps loading", "A copy may exist in Premiere's system-wide extensions folder inside Program Files, which loads first. Delete it, quit Premiere fully, reopen."],
    ],
    log: "%TEMP%\\amharic-captions-install.log",
  },
  mac: {
    id: "mac",
    label: "macOS",
    sub: "Apple Silicon & Intel",
    file: "Install.command",
    steps: [
      {
        t: "Download the right build",
        c: "Apple Silicon (M1/M2/M3/M4) and Intel are different downloads. Pick yours below — if unsure, click the Apple menu → About This Mac and look at the chip.",
        check: "Unzip it. You should see com.amharic.captions and Install.command together.",
      },
      {
        t: "Double-click Install.command",
        c: "Terminal opens and runs it for you — nothing to type. If macOS refuses, right-click the file → Open instead. Enter your Mac password when asked.",
        check: "It also clears the macOS “can’t be verified” block automatically.",
      },
      {
        t: "Fully quit Premiere, then reopen",
        c: "Premiere Pro → Quit (⌘Q). Closing the window leaves it running and the new panel will not load.",
        check: "Open a project first — the Extensions menu is disabled until one is open.",
      },
      {
        t: "Open the panel and activate",
        c: "Window → Extensions → Amharic Captions. Copy your Machine ID, send it to the Telegram bot with your payment, and paste the key you get back.",
        check: "Two free captions work before you pay anything.",
      },
    ],
    trouble: [
      ['"Apple cannot verify this app"', "Right-click Install.command → Open → Open. The installer clears the quarantine flag permanently once it runs."],
      ["Nothing happens on double-click", "macOS may have opened it in a text editor. Right-click → Open With → Terminal."],
      ["The panel does not appear in Extensions", "Premiere was not fully quit (⌘Q), or no project is open. Quit, reopen, open a project, check again."],
      ["Wrong build for your Mac", "An Intel build on Apple Silicon (or the reverse) will install but not run. Check About This Mac and download the matching one."],
    ],
    log: "/tmp/amharic-captions-install.log",
  },
};

const downloads = [
  { os: "win", kicker: "Windows", name: "Windows 10 / 11", note: "64-bit", href: DL_WIN },
  { os: "mac", kicker: "macOS · Apple Silicon", name: "M1 / M2 / M3 / M4", note: "arm64", href: DL_MAC_ARM },
  { os: "mac", kicker: "macOS · Intel", name: "Intel Mac", note: "x64", href: DL_MAC_X64 },
];

function detectOS() {
  if (typeof navigator === "undefined") return null;
  const s = `${navigator.platform || ""} ${navigator.userAgent || ""}`.toLowerCase();
  if (s.includes("win")) return "win";
  if (s.includes("mac")) return "mac";
  return null;
}

export default function InstallGuide() {
  // Start on Windows for SSR so the markup is deterministic, then correct it on
  // mount. Most buyers are on Windows, so this is also the better default when
  // detection fails.
  const [os, setOs] = useState("win");
  const [detected, setDetected] = useState(null);

  useEffect(() => {
    const d = detectOS();
    if (d) { setOs(d); setDetected(d); }
  }, []);

  const active = OS[os];

  return (
    <>
      {/* ------------------------------------------------------- downloads */}
      <section className="section" id="download">
        <div className="container">
          <div className="section-head center">
            <p className="eyebrow">Step 1</p>
            <h2>Download your build.</h2>
            {detected && (
              <p className="section-sub" style={{ marginInline: "auto" }}>
                Looks like you&apos;re on <strong>{OS[detected].label}</strong> — that one is
                highlighted below.
              </p>
            )}
          </div>

          <div className="dl-grid">
            {downloads.map((d) => {
              const mine = detected === d.os;
              return (
                <a
                  key={d.name}
                  className={mine ? "dl-card is-mine" : "dl-card"}
                  href={d.href}
                >
                  {mine && <span className="dl-flag">Your system</span>}
                  <span className="dl-kicker">{d.kicker}</span>
                  <span className="dl-name">{d.name}</span>
                  <span className="dl-note">{d.note} · .zip</span>
                  <span className="dl-go">Download ↓</span>
                </a>
              );
            })}
          </div>

          <p className="center dl-all">
            Looking for an older version?{" "}
            <a href={RELEASES_URL} target="_blank" rel="noopener">Browse all releases</a>.
          </p>
        </div>
      </section>

      {/* ----------------------------------------------------------- steps */}
      <section className="section" id="steps" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <div className="section-head center">
            <p className="eyebrow">Step 2</p>
            <h2>Install it.</h2>
            <p className="section-sub" style={{ marginInline: "auto" }}>
              Double-click <code>{active.file}</code> and it does the rest. No Terminal
              commands, no registry editing, no admin rights.
            </p>
          </div>

          <div className="os-switch" role="tablist" aria-label="Choose your operating system">
            {Object.values(OS).map((o) => (
              <button
                key={o.id}
                role="tab"
                aria-selected={os === o.id}
                className={os === o.id ? "os-tab on" : "os-tab"}
                onClick={() => setOs(o.id)}
              >
                <span className="os-tab-label">{o.label}</span>
                <span className="os-tab-sub">{o.sub}</span>
              </button>
            ))}
          </div>

          <ol className="istep-list">
            {active.steps.map((s, i) => (
              <li className="istep" key={s.t}>
                <span className="istep-n">{i + 1}</span>
                <div className="istep-body">
                  <h3>{s.t}</h3>
                  <p>{s.c}</p>
                  {s.check && <p className="istep-check">{s.check}</p>}
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* -------------------------------------------------- troubleshooting */}
      <section className="section" id="trouble">
        <div className="container">
          <div className="section-head center">
            <p className="eyebrow">If something goes wrong</p>
            <h2>{active.label} troubleshooting.</h2>
          </div>

          <div className="faq-list">
            {active.trouble.map(([q, a]) => (
              <details key={q}>
                <summary>{q}</summary>
                <p>{a}</p>
              </details>
            ))}
            <details>
              <summary>Install manually (advanced)</summary>
              <p>
                {os === "win" ? (
                  <>
                    Copy <code>com.amharic.captions</code> into{" "}
                    <code>%AppData%\Adobe\CEP\extensions</code>, then in{" "}
                    <code>regedit</code> open{" "}
                    <code>HKEY_CURRENT_USER\Software\Adobe\CSXS.11</code> (Premiere 2024) or{" "}
                    <code>CSXS.12</code> (2025+) and create a string (REG_SZ){" "}
                    <code>PlayerDebugMode</code> set to <code>1</code>.
                  </>
                ) : (
                  <>
                    Copy <code>com.amharic.captions</code> into{" "}
                    <code>~/Library/Application Support/Adobe/CEP/extensions</code>, then run{" "}
                    <code>xattr -dr com.apple.quarantine &lt;that folder&gt;</code> and{" "}
                    <code>defaults write com.adobe.CSXS.11 PlayerDebugMode 1</code>{" "}
                    (use <code>CSXS.12</code> for Premiere 2025+).
                  </>
                )}
              </p>
            </details>
            <details>
              <summary>Where is the install log?</summary>
              <p>
                The installer writes a log support can read: <code>{active.log}</code>. Send
                it on Telegram if you get stuck and we&apos;ll tell you what failed.
              </p>
            </details>
          </div>
        </div>
      </section>
    </>
  );
}
