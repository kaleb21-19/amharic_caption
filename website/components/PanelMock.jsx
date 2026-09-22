// The product visual, rendered as markup rather than a screenshot.
//
// Why not a real screenshot: the only one in the repo (public/images/panel-hi.png)
// is stale — its footer still reads "License ETB 1,500 one-time" while the
// product sells at ETB 2,500 — and it is orange where the site is green. A
// wrong price on the sales page is worse than no photo. Built in code this
// tracks lib/site.js automatically, matches the brand, stays sharp at any
// width, and costs no image bytes on a metered Ethiopian connection.
//
// It mirrors the real panel's structure (Source → Options → Generate → output)
// so it is representative, not decorative.
export default function PanelMock() {
  return (
    <div className="mock" role="img" aria-label="The Amharic Captions panel inside Premiere Pro: choose a source, pick a caption style, generate, and Amharic captions appear on the timeline.">
      <div className="mock-chrome">
        <span className="mock-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="mock-title">Amharic Captions</span>
        <span className="mock-status">ready · offline</span>
      </div>

      <div className="mock-body">
        <div className="mock-step">
          <span className="mock-step-label"><i>1</i> Source</span>
          <div className="mock-segs">
            <span className="mock-seg on">Selected Clip</span>
            <span className="mock-seg">Work Area</span>
            <span className="mock-seg">Whole Edit</span>
          </div>
        </div>

        <div className="mock-step">
          <span className="mock-step-label"><i>2</i> Caption style</span>
          <div className="mock-segs" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <span className="mock-seg on">Grouped</span>
            <span className="mock-seg">Karaoke</span>
          </div>
        </div>

        <div className="mock-step">
          <span className="mock-step-label"><i>3</i> Generate</span>
          <span className="mock-generate">▶ Generate Captions</span>
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

