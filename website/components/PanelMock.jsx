import Tx from "@/components/Tx";

// The product visual, rendered as markup rather than a screenshot: it tracks
// the real panel's structure (Source → Options → Generate → output) and its
// wording in both languages (panel/js/i18n.js), matches the brand, stays sharp
// at any width, and costs no image bytes on a metered Ethiopian connection.
export default function PanelMock() {
  return (
    <div className="mock" role="img" aria-label="The Amharic Captions panel inside Premiere Pro: choose a source, pick a caption style, generate, and Amharic captions appear on the timeline.">
      <div className="mock-chrome">
        <span className="mock-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="mock-title"><Tx am="አማርኛ ካፕሽን ፕሮ" en="Amharic Captions Pro" /></span>
        <span className="mock-status"><Tx am="ዝግጁ · ያለ ኢንተርኔት" en="ready · offline" /></span>
      </div>

      <div className="mock-body">
        <div className="mock-step">
          <span className="mock-step-label"><i>1</i> <Tx am="ምንጭ" en="Source" /></span>
          <div className="mock-segs">
            <span className="mock-seg on"><Tx am="የተመረጠ ክሊፕ" en="Selected Clip" /></span>
            <span className="mock-seg">Work Area</span>
            <span className="mock-seg"><Tx am="ሙሉ ኤዲት" en="Whole Edit" /></span>
          </div>
        </div>

        <div className="mock-step">
          <span className="mock-step-label"><i>2</i> <Tx am="የካፕሽን አይነት" en="Caption style" /></span>
          <div className="mock-segs" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <span className="mock-seg on"><Tx am="በቡድን" en="Grouped" /></span>
            <span className="mock-seg"><Tx am="ካራኦኬ" en="Karaoke" /></span>
          </div>
        </div>

        <div className="mock-step">
          <span className="mock-step-label"><i>3</i> <Tx am="ፍጠር" en="Generate" /></span>
          <span className="mock-generate"><Tx am="▶ ካፕሽን ፍጠር" en="▶ Generate Captions" /></span>
        </div>

        <div className="mock-caps">
          <div className="mock-cap">
            <time>00:00:01,3</time>
            <span className="amh" lang="am">የተከበሩ ታዳሚዎች</span>
          </div>
          <div className="mock-cap">
            <time>00:00:02,8</time>
            <span className="amh" lang="am">እንኳን ደህና መጡ።</span>
          </div>
          <div className="mock-cap">
            <time>00:00:04,1</time>
            <span className="amh" lang="am">ዛሬ ስለ ሥራችን እናወራለን።</span>
          </div>
        </div>
      </div>
    </div>
  );
}
