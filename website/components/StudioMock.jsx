import Tx from "@/components/Tx";

// The Studio (the desktop app most people start with), drawn as markup like
// PanelMock: a video with a styled Amharic caption, the caption list with
// ✂, and the timeline. Sharp at any width, no image bytes, no one's video.
export default function StudioMock() {
  return (
    <div className="smock" role="img" aria-label="Amharic Captions Studio: a video with a styled Amharic caption, the caption list you can edit and cut, and the timeline.">
      <div className="mock-chrome">
        <span className="mock-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="mock-title">Amharic Captions Studio</span>
        <span className="mock-status"><Tx am="ያለ ኢንተርኔት" en="offline" /></span>
      </div>
      <div className="smock-body">
        <div className="smock-video" aria-hidden="true">
          <span className="smock-ratio">9:16 · 16:9</span>
          <span className="smock-cap amh" lang="am">ዛሬ ስለ <b>ቡና</b> እናወራለን</span>
        </div>
        <div className="smock-list">
          <div className="smock-row"><time>0:01</time><span className="amh" lang="am">የተከበሩ ታዳሚዎች</span><i aria-hidden="true">✂</i></div>
          <div className="smock-row on"><time>0:03</time><span className="amh" lang="am">ዛሬ ስለ <b>ቡና</b> እናወራለን</span><i aria-hidden="true">✂</i></div>
          <div className="smock-row cut"><time>0:05</time><span className="amh" lang="am">እ… እንግዲህ</span><i aria-hidden="true">✂</i></div>
        </div>
        <div className="smock-tl" aria-hidden="true">
          <div className="smock-tl-caps"><i /><i /><i className="on" /><i /><i /><i /></div>
          <div className="smock-tl-wave" />
        </div>
        <div className="smock-foot">
          <span className="smock-btn"><Tx am="⬆ ይላኩ — TikTok · YouTube · CapCut" en="⬆ Export — TikTok · YouTube · CapCut" /></span>
        </div>
      </div>
    </div>
  );
}
