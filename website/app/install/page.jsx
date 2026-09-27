import InstallGuide from "@/components/InstallGuide";
import Tx from "@/components/Tx";
import { GROUP_URL, SUPPORT_URL } from "@/lib/site";

export const metadata = {
  title: "መጫኛ · Install — Amharic Captions Pro for Premiere Pro",
  description:
    "የአማርኛ ካፕሽን ፓነልን በWindows ወይም Mac ይጫኑ። Install the Amharic Captions panel for Adobe Premiere Pro on Windows 10/11 or macOS (Apple Silicon and Intel). Download, double-click the installer, restart Premiere.",
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
          <p className="eyebrow"><Tx am="መጫኛ" en="Installation" /></p>
          <h1><Tx am="በአምስት ደቂቃ ገደማ ዝግጁ።" en="Running in about five minutes." /></h1>
          <p className="hero-sub">
            <Tx
              am="ያውርዱ፣ ጫኚውን ሁለቴ ይጫኑ፣ Premiere ን እንደገና ይክፈቱ። የቴክኒክ እውቀት አያስፈልግም።"
              en="Download, double-click the installer, restart Premiere. No technical skills needed."
            />
          </p>

          <div className="req-row">
            <span className="req">
              <Tx
                am={<><b>Premiere Pro</b> ወይም <b>After Effects</b> 2024+ — ወይም ምንም የAdobe ፕሮግራም ሳይኖር</>}
                en={<><b>Premiere Pro</b> or <b>After Effects</b> 2024+ — or no Adobe app at all</>}
              />
            </span>
            <span className="req"><Tx am={<><b>Windows 10/11</b> ወይም <b>macOS</b></>} en={<><b>Windows 10/11</b> or <b>macOS</b></>} /></span>
            <span className="req"><Tx am={<><b>~2 GB</b> ነጻ ቦታ</>} en={<><b>~2 GB</b> free disk space</>} /></span>
          </div>
        </div>
      </section>

      <InstallGuide />

      <section className="section" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <div className="final-cta">
            <h2><Tx am="አንድ ደረጃ ላይ ተቸገሩ?" en="Stuck on a step?" /></h2>
            <p className="section-sub" style={{ marginInline: "auto" }}>
              <Tx
                am="በቴሌግራም መልዕክት ይላኩልን — ብዙውን ጊዜ በፍጥነት እንመልሳለን።"
                en="Send us a message on Telegram — we usually reply fast."
              />
            </p>
            <div className="cta-row">
              <a className="btn btn-primary btn-lg" href={SUPPORT_URL} target="_blank" rel="noopener">
                <Tx am="ድጋፍ ያግኙ" en="Message support" />
              </a>
              <a className="btn btn-ghost btn-lg" href={GROUP_URL} target="_blank" rel="noopener">
                <Tx am="የድጋፍ ግሩፑን ይቀላቀሉ" en="Join the support group" />
              </a>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
