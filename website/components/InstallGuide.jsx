"use client";

import { useEffect, useState } from "react";
import Tx from "@/components/Tx";
import {
  DL_WIN, DL_WIN_LITE, DL_MAC_ARM, DL_MAC_ARM_LITE, DL_MAC_X64, DL_MAC_X64_LITE,
} from "@/lib/site";

// Install flow as a tabbed guide rather than two long parallel columns.
// Showing Windows and macOS side by side means every reader scrolls past a set
// of instructions that can only confuse them — on a phone that is two full
// screens of wrong-platform text. We detect the visitor's OS, preselect it,
// and let them switch.
//
// Every string is { am, en } (see components/Tx.jsx). Keep the steps in line
// with what the installers print (tools/installers/Install.cmd / .command) and
// with START HERE.html in the zip.

const openPanel = {
  t: { am: "ፓነሉን ይክፈቱ", en: "Open the panel" },
  c: {
    am: "Window → Extensions → Amharic Captions Pro። የመጀመሪያ ጊዜ «የአማርኛ ሞዴሉን አውርድ» ን አንድ ጊዜ ይጫኑ (610 MB ገደማ፤ ኢንተርኔት ቢቋረጥ ካቆመበት ይቀጥላል)።",
    en: "Window → Extensions → Amharic Captions Pro. The first time, press “Download the Amharic model” once (about 610 MB; it continues where it stopped if your internet drops).",
  },
  check: {
    am: "ከመክፈልዎ በፊት 2 ነጻ ካፕሽን ይሰራሉ። ለመግዛት በፓነሉ ላይ «ፈቃድ ይግዙ» ይጫኑ።",
    en: "Two free captions work before you pay. To buy, press “Buy a license” in the panel.",
  },
};

const OS = {
  win: {
    id: "win",
    label: "Windows",
    sub: "Windows 10 / 11",
    file: "Install.cmd",
    steps: [
      {
        t: { am: "ያውርዱና Extract ያድርጉ", en: "Download and unzip" },
        c: {
          am: "የWindows ፋይሉን ያውርዱ፣ ከዚያ ዚፑ ላይ Right-click → Extract All። ዚፑን ሁለቴ መጫን ውስጡን ብቻ ያሳያል — ጫኚው እንዲሰራ መጀመሪያ Extract ማድረግ አለብዎት።",
          en: "Download the Windows build, then right-click the zip → Extract All. Double-clicking the zip only previews it — you must extract before the installer will run.",
        },
        check: {
          am: "በወጣው ፎልደር ውስጥ ሶስት ነገሮች ያያሉ፦ START HERE.html፣ Install.cmd እና com.amharic.captions።",
          en: "The extracted folder shows three items: START HERE.html, Install.cmd and com.amharic.captions.",
        },
      },
      {
        t: { am: "Install.cmd ን ሁለቴ ይጫኑ", en: "Double-click Install.cmd" },
        c: {
          am: "አንድ መስኮት ተከፍቶ ሁሉንም ይሰራል፦ ኤክስቴንሽኑን ወደ Adobe ፎልደርዎ ይቀዳል፣ Premiere የሚያስፈልገውን ቅንብር ያበራል። Premiere ወይም After Effects ክፍት ከሆነ እንዲዘጉት ይጠይቅዎታል። የአድሚን ፈቃድ አያስፈልግም።",
          en: "A window opens and does everything: copies the extension into your Adobe folder and turns on the setting Premiere needs. If Premiere or After Effects is open, it asks you to close it. No administrator rights required.",
        },
        check: {
          am: "INSTALLATION SUCCESSFUL እስኪል ይጠብቁ (አንድ ደቂቃ ገደማ)።",
          en: "Wait for INSTALLATION SUCCESSFUL (about a minute).",
        },
      },
      {
        t: { am: "Premiere ን ሙሉ በሙሉ ዘግተው እንደገና ይክፈቱ", en: "Fully quit Premiere (or After Effects), then reopen" },
        c: {
          am: "File → Exit። መስኮቱን መዝጋት ብቻ አይበቃም — ፕሮግራሙ ከጀርባ መስራቱን ይቀጥላል፣ አዲሱን ኤክስቴንሽን አያገኝም።",
          en: "File → Exit. Closing the window is not enough — the app keeps running and will not pick up a new extension.",
        },
        check: {
          am: "መጀመሪያ ፕሮጀክት ይክፈቱ፦ በመነሻ ገጹ ላይ የExtensions ሜኑ አይሰራም።",
          en: "Open a project first: the Extensions menu stays greyed out on the start screen.",
        },
      },
      openPanel,
    ],
    trouble: [
      [
        { am: "የሞዴሉ ማውረድ ቆመ", en: "The model download stopped" },
        {
          am: "ኢንተርኔትዎ ተቋርጧል። «ማውረዱን ቀጥል» ይጫኑ — ካቆመበት ይቀጥላል እንጂ እንደገና አይጀምርም። ደጋግሞ ካልተሳካ ሙሉውን የWindows ፓኬጅ ይጠቀሙ (ከማውረጃ ቁልፎቹ በታች ያለው ሊንክ)።",
          en: "Your internet dropped. Press Resume download — it continues from where it stopped, it does not start over. If it keeps failing, use the full Windows package instead (link under the download buttons).",
        },
      ],
      [
        { am: "Premiere ወይም After Effects የለኝም", en: "I don't have Premiere or After Effects" },
        {
          am: "ጫኚው «Make Amharic Captions» የሚል አቋራጭ ዴስክቶፕዎ ላይ ያስቀምጣል። ማንኛውንም ቪዲዮ በላዩ ላይ ይጎትቱ፤ .srt ፋይል ከቪዲዮው አጠገብ ይፈጠራል — ወደ CapCut፣ DaVinci Resolve ወይም YouTube ያስገቡት።",
          en: "The installer also puts a “Make Amharic Captions” shortcut on your desktop. Drag any video onto it and an .srt file appears next to the video — import it into CapCut, DaVinci Resolve or YouTube.",
        },
      ],
      [
        { am: "«Windows protected your PC» የሚል መልዕክት ወጣ", en: "“Windows protected your PC” appears" },
        {
          am: "More info → Run anyway ይጫኑ። ጫኚው ዲጂታል ፊርማ (signature) የለውም፤ ለእንደዚህ አይነት ትንሽ ፕሮግራም ይህ የተለመደ ነው።",
          en: "Click More info → Run anyway. The installer is not digitally signed, which is normal for a tool this size.",
        },
      ],
      [
        { am: "የሚጫን Install.cmd የለም", en: "There is no Install.cmd to click" },
        {
          am: "ዚፑ Extract አልተደረገም። ዚፑ ላይ Right-click → Extract All ያድርጉ፣ ከዚያ የወጣውን ፎልደር ይክፈቱ።",
          en: "The zip was not extracted. Right-click it → Extract All, then open the extracted folder.",
        },
      ],
      [
        { am: "ፓነሉ በExtensions ውስጥ አይታይም", en: "The panel does not appear in Extensions" },
        {
          am: "Premiere ሙሉ በሙሉ አልተዘጋም ወይም ፕሮጀክት አልተከፈተም። ሙሉ በሙሉ ዘግተው እንደገና ይክፈቱ፣ ፕሮጀክት ይክፈቱ፣ ከዚያ ሜኑውን እንደገና ይመልከቱ።",
          en: "Premiere was not fully quit, or no project is open. Exit completely, reopen, open a project, then check the menu again.",
        },
      ],
      [
        { am: "የድሮው ስሪት መከፈቱን ቀጥሏል", en: "An old version keeps loading" },
        {
          am: "በProgram Files ውስጥ ባለው የPremiere የጋራ extensions ፎልደር ውስጥ የቆየ ቅጂ ሊኖር ይችላል፤ እሱ ቅድሚያ ይከፈታል። ጫኚው ካገኘው ያስጠነቅቅዎታል። ያንን ቅጂ ይሰርዙት፣ Premiere ን ሙሉ በሙሉ ዘግተው እንደገና ይክፈቱ።",
          en: "A copy may exist in Premiere's system-wide extensions folder inside Program Files, which loads first; the installer warns you when it finds one. Delete it, quit Premiere fully, reopen.",
        },
      ],
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
        t: { am: "ትክክለኛውን ፋይል ያውርዱ", en: "Download the right build" },
        c: {
          am: "Apple Silicon (M1/M2/M3/M4) እና Intel የተለያዩ ፋይሎች ናቸው። ከታች የእርስዎን ይምረጡ — እርግጠኛ ካልሆኑ Apple ሜኑ → About This Mac ላይ Chip የሚለውን ይመልከቱ።",
          en: "Apple Silicon (M1/M2/M3/M4) and Intel are different downloads. Pick yours below — if unsure, click the Apple menu → About This Mac and look at the chip.",
        },
        check: {
          am: "ዚፑን ይክፈቱ። START HERE.html፣ Install.command እና com.amharic.captions ያያሉ።",
          en: "Unzip it. You should see START HERE.html, Install.command and com.amharic.captions.",
        },
      },
      {
        t: { am: "Install.command ን ሁለቴ ይጫኑ", en: "Double-click Install.command" },
        c: {
          am: "Terminal ተከፍቶ በራሱ ይሰራዋል — ምንም መጻፍ አያስፈልግዎትም። macOS ካልፈቀደ ፋይሉ ላይ Right-click → Open ይጫኑ። ሲጠየቁ የMac የይለፍ ቃልዎን ያስገቡ።",
          en: "Terminal opens and runs it for you — nothing to type. If macOS refuses, right-click the file → Open instead. Enter your Mac password when asked.",
        },
        check: {
          am: "የmacOS «can’t be verified» እገዳንም በራሱ ያነሳል።",
          en: "It also clears the macOS “can’t be verified” block automatically.",
        },
      },
      {
        t: { am: "Premiere ን ሙሉ በሙሉ ዘግተው እንደገና ይክፈቱ", en: "Fully quit Premiere (or After Effects), then reopen" },
        c: {
          am: "Premiere Pro → Quit (⌘Q)። መስኮቱን መዝጋት ብቻ ፕሮግራሙን አያዘጋውም፤ አዲሱ ፓነል አይከፈትም።",
          en: "Premiere Pro → Quit (⌘Q). Closing the window leaves it running and the new panel will not load.",
        },
        check: {
          am: "መጀመሪያ ፕሮጀክት ይክፈቱ — ፕሮጀክት እስኪከፈት የExtensions ሜኑ አይሰራም።",
          en: "Open a project first — the Extensions menu is disabled until one is open.",
        },
      },
      openPanel,
    ],
    trouble: [
      [
        { am: "የሞዴሉ ማውረድ ቆመ", en: "The model download stopped" },
        {
          am: "ኢንተርኔትዎ ተቋርጧል። «ማውረዱን ቀጥል» ይጫኑ — ካቆመበት ይቀጥላል እንጂ እንደገና አይጀምርም። ደጋግሞ ካልተሳካ ሙሉውን የMac ፓኬጅ ይጠቀሙ (ከማውረጃ ቁልፎቹ በታች ያለው ሊንክ)።",
          en: "Your internet dropped. Press Resume download — it continues from where it stopped, it does not start over. If it keeps failing, use the full Mac package instead (link under the download buttons).",
        },
      ],
      [
        { am: "Premiere ወይም After Effects የለኝም", en: "I don't have Premiere or After Effects" },
        {
          am: "ዴስክቶፕ ላይ ያለውን «Make Amharic Captions» ሁለቴ ይጫኑ፣ ቪዲዮውን ወደ ተከፈተው መስኮት ይጎትቱና Return ይጫኑ። .srt ፋይል ከቪዲዮው አጠገብ ይፈጠራል — ወደ CapCut፣ DaVinci Resolve ወይም YouTube ያስገቡት።",
          en: "Double-click “Make Amharic Captions” on your Desktop, then drag a video into the window that opens and press Return. An .srt file appears next to the video — import it into CapCut, DaVinci Resolve or YouTube.",
        },
      ],
      [
        { am: "«Apple cannot verify this app» ይላል", en: "“Apple cannot verify this app”" },
        {
          am: "Install.command ላይ Right-click → Open → Open። ጫኚው አንዴ ከሰራ እገዳውን በቋሚነት ያነሳል።",
          en: "Right-click Install.command → Open → Open. The installer clears the quarantine flag permanently once it runs.",
        },
      ],
      [
        { am: "ሁለቴ ስጫን ምንም አይከሰትም", en: "Nothing happens on double-click" },
        {
          am: "macOS በtext editor ከፍቶት ሊሆን ይችላል። Right-click → Open With → Terminal።",
          en: "macOS may have opened it in a text editor. Right-click → Open With → Terminal.",
        },
      ],
      [
        { am: "ፓነሉ በExtensions ውስጥ አይታይም", en: "The panel does not appear in Extensions" },
        {
          am: "Premiere ሙሉ በሙሉ አልተዘጋም (⌘Q) ወይም ፕሮጀክት አልተከፈተም። ዘግተው እንደገና ይክፈቱ፣ ፕሮጀክት ይክፈቱ፣ እንደገና ይመልከቱ።",
          en: "Premiere was not fully quit (⌘Q), or no project is open. Quit, reopen, open a project, check again.",
        },
      ],
      [
        { am: "ለMac ዬ የማይሆን ፋይል አውርጃለሁ", en: "Wrong build for your Mac" },
        {
          am: "የIntel ፋይል በApple Silicon ላይ (ወይም በተቃራኒው) ይጫናል ግን አይሰራም። About This Mac ን አይተው ትክክለኛውን ያውርዱ።",
          en: "An Intel build on Apple Silicon (or the reverse) will install but not run. Check About This Mac and download the matching one.",
        },
      ],
    ],
    log: "/tmp/amharic-captions-install.log",
  },
};

const downloads = [
  // One button per computer: the small Lite build. The Amharic model downloads
  // once inside the app (resumes if the connection drops). Full packages are a
  // single text link below the cards, for offline / USB installs.
  { os: "win", kicker: "Windows", name: "Windows 10 / 11", note: "~175 MB", href: DL_WIN_LITE },
  { os: "mac", kicker: "macOS · Apple Silicon", name: "M1 / M2 / M3 / M4", note: "~200 MB", href: DL_MAC_ARM_LITE },
  { os: "mac", kicker: "macOS · Intel", name: "Intel Mac", note: "~200 MB", href: DL_MAC_X64_LITE },
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
            <p className="eyebrow"><Tx am="ደረጃ 1" en="Step 1" /></p>
            <h2><Tx am="ለኮምፒውተርዎ የሚሆነውን ያውርዱ።" en="Download your build." /></h2>
            {detected && (
              <p className="section-sub" style={{ marginInline: "auto" }}>
                <Tx
                  am={<><strong>{OS[detected].label}</strong> ላይ ያሉ ይመስላል — እሱ ከታች ጎልቶ ታይቷል።</>}
                  en={<>Looks like you&apos;re on <strong>{OS[detected].label}</strong> — that one is highlighted below.</>}
                />
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
                  {mine && <span className="dl-flag"><Tx am="የእርስዎ ኮምፒውተር" en="Your system" /></span>}
                  <span className="dl-kicker">{d.kicker}</span>
                  <span className="dl-name">{d.name}</span>
                  <span className="dl-note">{d.note} · .zip</span>
                  <span className="dl-go"><Tx am="ያውርዱ ↓" en="Download ↓" /></span>
                </a>
              );
            })}
          </div>

          <p className="center dl-all">
            <Tx
              am="የአማርኛ ሞዴሉ (610 MB ገደማ) ፓነሉን ለመጀመሪያ ጊዜ ሲከፍቱ አንድ ጊዜ ይወርዳል።"
              en="The Amharic model (about 610 MB) downloads once, the first time you open the app."
            />
            <br />
            <Tx am="ያለ ኢንተርኔት ወይም በUSB ፍላሽ ነው የሚጭኑት? ሙሉ ፓኬጆች፦" en="Installing offline or from a USB stick? Full packages:" />{" "}
            <a href={DL_WIN}>Windows</a> · <a href={DL_MAC_ARM}>Mac Apple Silicon</a> ·{" "}
            <a href={DL_MAC_X64}>Mac Intel</a>{" "}
            <Tx am="(እያንዳንዳቸው 700 MB ገደማ)።" en="(about 700 MB each)." />
          </p>
        </div>
      </section>

      {/* ----------------------------------------------------------- steps */}
      <section className="section" id="steps" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <div className="section-head center">
            <p className="eyebrow"><Tx am="ደረጃ 2" en="Step 2" /></p>
            <h2><Tx am="ይጫኑት።" en="Install it." /></h2>
            <p className="section-sub" style={{ marginInline: "auto" }}>
              <Tx
                am={<><code>{active.file}</code> ን ሁለቴ ይጫኑ፣ የቀረውን እሱ ይሰራዋል።</>}
                en={<>Double-click <code>{active.file}</code> and it does the rest.</>}
              />
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
              <li className="istep" key={s.t.en}>
                <span className="istep-n">{i + 1}</span>
                <div className="istep-body">
                  <h3><Tx am={s.t.am} en={s.t.en} /></h3>
                  <p><Tx am={s.c.am} en={s.c.en} /></p>
                  {s.check && <p className="istep-check"><Tx am={s.check.am} en={s.check.en} /></p>}
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
            <p className="eyebrow"><Tx am="ችግር ካጋጠመዎት" en="If something goes wrong" /></p>
            <h2>
              <Tx am={`የ${active.label} ችግሮችና መፍትሄዎች።`} en={`${active.label} troubleshooting.`} />
            </h2>
          </div>

          <div className="faq-list">
            {active.trouble.map(([q, a]) => (
              <details key={q.en}>
                <summary><Tx am={q.am} en={q.en} /></summary>
                <p><Tx am={a.am} en={a.en} /></p>
              </details>
            ))}
            {/* Manual install steps (registry / Terminal) were removed on
                purpose: a customer editing the registry by hand is more likely
                to break something than fix it. Support has the log instead. */}
            <details>
              <summary><Tx am="የመጫኛ መዝገቡ (log) የት ነው?" en="Where is the install log?" /></summary>
              <p>
                <Tx
                  am={<>ጫኚው ድጋፍ ሊያነበው የሚችል መዝገብ ይጽፋል፦ <code>{active.log}</code>። ከተቸገሩ በቴሌግራም ይላኩልን፤ ምን እንዳልተሳካ እንነግርዎታለን።</>}
                  en={<>The installer writes a log support can read: <code>{active.log}</code>. Send it on Telegram if you get stuck and we&apos;ll tell you what failed.</>}
                />
              </p>
            </details>
          </div>
        </div>
      </section>
    </>
  );
}
