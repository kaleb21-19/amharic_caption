import Reveal from "@/components/Reveal";
import Tx from "@/components/Tx";

// W2 (2026-11): the features as a bento grid - one short line each and a small
// moving picture of the feature itself (CSS only, no images, no JS). Every
// tile is something the product does today.

function Review() {
  return (
    <div className="bv bv-review" aria-hidden="true">
      <p className="bv-cap amh" lang="am">ዛሬ ስለ <b className="bv-doubt">ቡና</b> እናወራለን</p>
      <span className="bv-key">Enter ↵</span>
      <span className="bv-ok">✓</span>
    </div>
  );
}
function Latin() {
  return (
    <div className="bv bv-latin" aria-hidden="true">
      <span className="bv-typed">selam</span>
      <span className="bv-arrow">→</span>
      <span className="bv-amh amh" lang="am">ሰላም</span>
    </div>
  );
}
function Learn() {
  return (
    <div className="bv bv-learn" aria-hidden="true">
      {["አበበ", "ቤተልሔም", "አዲስ አበባ"].map((w, i) => (
        <span key={w} className="bv-chip amh" lang="am" style={{ "--i": i }}>{w} <i>✓</i></span>
      ))}
    </div>
  );
}
function Cut() {
  return (
    <div className="bv bv-cut" aria-hidden="true">
      <span className="bv-w amh" lang="am">ሰላም</span>
      <span className="bv-w amh" lang="am">ውድ</span>
      <span className="bv-w bv-x amh" lang="am">እ…</span>
      <span className="bv-w bv-x amh" lang="am">እንግዲህ</span>
      <span className="bv-w amh" lang="am">ተከታዮቻችን</span>
      <span className="bv-scissor">✂</span>
    </div>
  );
}
function Silence() {
  const bars = [40, 70, 55, 85, 60, 4, 4, 4, 4, 50, 90, 65, 75, 45, 4, 4, 4, 60, 80, 50];
  return (
    <div className="bv bv-sil" aria-hidden="true">
      {bars.map((h, i) => <b key={i} className={h < 10 ? "gap" : ""} style={{ "--h": h + "%" }} />)}
    </div>
  );
}
function Export() {
  return (
    <div className="bv bv-export" aria-hidden="true">
      <span className="bv-phone"><span className="amh" lang="am">ሰላም ውድ</span></span>
      <span className="bv-bar"><i /></span>
      <span className="bv-meta">MP4 · 1080×1920</span>
    </div>
  );
}
function Offline() {
  return (
    <div className="bv bv-off" aria-hidden="true">
      <span className="bv-ring"><span>0</span><small>MB</small></span>
    </div>
  );
}

const TILES = [
  { cls: "wide", V: Review, t: { am: "ቃላትን አንድ በአንድ ያረጋግጡ", en: "Check words one by one" },
    d: { am: "አጠራጣሪ ቃላት ይደምቃሉ፤ Enter = ትክክል፣ ይጻፉ = ያርሙ። ከ69,000 ቃላት መዝገበ ቃላት ምክር ይሰጣል።",
         en: "Doubtful words light up. Enter = right, type = fix — with suggestions from a 69,000-word dictionary." } },
  { cls: "", V: Latin, t: { am: "በላቲን ፊደል ይጻፉ", en: "Type with Latin letters" },
    d: { am: "selam ብለው ይጻፉ → ሰላም። የአማርኛ ኪቦርድ አያስፈልግም።", en: "Type selam → ሰላም. No Amharic keyboard needed." } },
  { cls: "", V: Learn, t: { am: "ቃላትዎን ይማራል", en: "Learns your words" },
    d: { am: "አንድ ጊዜ ያረሙት ስም በሚቀጥለው ቪዲዮ በራሱ ይስተካከላል።", en: "Fix a name once — it's right in the next video." } },
  { cls: "wide", V: Cut, t: { am: "ቪዲዮውን በጽሑፍ ያርሙ", en: "Edit the video by editing text" },
    d: { am: "ቃላትን ይምረጡና ✂ ይጫኑ — ያ የቪዲዮው ክፍል ይቆረጣል፣ ካፕሽኖቹም አብረው ይንቀሳቀሳሉ።",
         en: "Select words and press ✂ — that part of the video is cut, and the captions move with it." } },
  { cls: "", V: Silence, t: { am: "ጸጥታን ያጽዱ", en: "Clean the silences" },
    d: { am: "ረጅም ዝምታና «እ…» ድምፆች በአንድ ጠቅታ ይወጣሉ።", en: "Long pauses and “እ…” sounds go in one click." } },
  { cls: "", V: Export, t: { am: "ለTikTok ዝግጁ", en: "Ready for TikTok" },
    d: { am: "ካፕሽኑ የተጻፈበት MP4 ለTikTok፣ Reels ወይም YouTube።", en: "An MP4 with the captions burned in, for TikTok, Reels or YouTube." } },
  { cls: "", V: Offline, t: { am: "ሁሉም በኮምፒውተርዎ", en: "All on your computer" },
    d: { am: "ቪዲዮዎ ወደ የትም አይላክም። ያለ ኢንተርኔት፣ ያለ ዳታ ወጪ።", en: "Your video is never uploaded. No internet, no data costs." } },
];

export default function Bento() {
  return (
    <section className="section" id="features">
      <div className="container">
        <Reveal>
          <div className="section-head center">
            <p className="eyebrow"><Tx am="ከካፕሽን በላይ" en="More than captions" /></p>
            <h2><Tx am="ኤዲተሮች የሚፈልጉት ሁሉ።" en="Everything an editor needs." /></h2>
            <p className="section-sub"><Tx am="በፓነሉም በStudioም — አንድ ፈቃድ፣ ሁሉም ባህሪያት።" en="In the panel and in the Studio — one license, every feature." /></p>
          </div>
        </Reveal>
        <div className="bento">
          {TILES.map(({ cls, V, t, d }, i) => (
            <Reveal key={t.en} delay={(i % 3) * 80} className={"bento-cell " + cls}>
              <div className="bento-tile spot">
                <V />
                <div className="bento-copy">
                  <h3><Tx am={t.am} en={t.en} /></h3>
                  <p><Tx am={d.am} en={d.en} /></p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
