import Tx from "@/components/Tx";

// "60+ caption styles": two rows of the real style pictures (the program's own
// thumbnails, ~5 KB each) sliding in opposite directions; hover pauses a row.
// CSS only (no JS); each row is drawn twice so the loop has no seam. With
// "reduce motion" the rows simply scroll by hand.
const ROW_A = [
  ["bold", "Bold"], ["highlight", "Highlight"], ["glide", "Glide"], ["luxgold", "Luxury Gold"],
  ["hotpink", "Hot Pink"], ["sweep", "Sweep"], ["fire", "Fire"], ["goldbox", "Gold Box"],
  ["newsbar", "News Bar"], ["retrowave", "Retro Wave"],
];
const ROW_B = [
  ["creator", "Creator"], ["boldpop", "Bold Pop"], ["neonglow", "Neon Glow"], ["ocean", "Ocean"],
  ["ice", "Ice"], ["sticker", "Sticker"], ["candychips", "Candy Chips"], ["goldword", "Gold Word"],
  ["limepunch", "Lime Punch"], ["documentary", "Documentary"],
];

function Row({ items, reverse }) {
  const all = items.concat(items);
  return (
    <div className={"showcase-row" + (reverse ? " rev" : "")}>
      <ul className="showcase-track">
        {all.map(([id, name], i) => (
          <li key={i} className="showcase-card" aria-hidden={i >= items.length ? "true" : undefined}>
            <img src={`/styles/${id}.jpg`} alt="" width="300" height="150" loading="lazy" decoding="async" />
            <span>{name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StyleShowcase() {
  return (
    <section className="section showcase" id="styles" aria-label="Caption styles">
      <div className="container">
        <div className="section-head center">
          <p className="eyebrow"><Tx am="ስታይሎች" en="Styles" /></p>
          <h2><Tx am="ከ60 በላይ የካፕሽን ስታይሎች — በአንድ ንክኪ።" en="60+ caption styles — one tap each." /></h2>
          <p className="section-sub">
            <Tx am="ለሙሉ ቪዲዮ የሚመቹ ጸጥ ያሉ ስታይሎች፣ ለአጫጭር ቅንጥቦች ደግሞ ደማቅ የReels መልኮች። መጠን፣ ቀለም፣ ፊደልና እንቅስቃሴ — ሁሉም የእርስዎ ምርጫ።"
              en="Calm looks for a whole video, bold Reels looks for short clips. Size, colour, font and motion — all yours to change." />
          </p>
        </div>
      </div>
      <Row items={ROW_A} />
      <Row items={ROW_B} reverse />
    </section>
  );
}
