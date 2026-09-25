import { ImageResponse } from "next/og";
import { PRICE } from "@/lib/site";

// Social preview card, generated at build time.
//
// This matters commercially more than it looks: the product is sold by pasting
// this link into Telegram, and Telegram renders og:image large. With no image
// the link appeared as a bare grey text row — the least persuasive possible
// form of the one thing a buyer is sent.
//
// Generated rather than a static PNG so the price can never drift out of sync
// with lib/site.js, which is exactly how the old panel screenshot ended up
// advertising ETB 1,500.

export const runtime = "nodejs";
export const alt = "Amharic Captions Pro — Amharic subtitles inside Adobe Premiere Pro";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background: "linear-gradient(135deg, #080d0c 0%, #0f1a16 55%, #123024 100%)",
          color: "#f1f7f3",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 56,
              height: 56,
              borderRadius: 16,
              background: "linear-gradient(145deg, #3ddc8a, #178a51)",
              color: "#04150d",
              fontSize: 24,
              fontWeight: 800,
            }}
          >
            AC
          </div>
          {/* Satori requires display:flex on any element with >1 child — a bare
              text node plus a <span> counts as two and throws at render time. */}
          <div style={{ display: "flex", gap: 10, fontSize: 28, fontWeight: 700, letterSpacing: -0.5 }}>
            <span>Amharic Captions</span>
            <span style={{ color: "#3ddc8a" }}>Pro</span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              fontSize: 76,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -2,
              maxWidth: 900,
            }}
          >
            Amharic subtitles in minutes, not hours.
          </div>
          <div
            style={{
              marginTop: 24,
              fontSize: 30,
              color: "#8fa398",
              maxWidth: 820,
              lineHeight: 1.4,
            }}
          >
            Editable Amharic captions straight onto your Adobe Premiere Pro timeline.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {["No internet needed", "Nothing uploaded", `${PRICE} one-time`].map((t) => (
            <div
              key={t}
              style={{
                display: "flex",
                padding: "10px 22px",
                borderRadius: 999,
                border: "1px solid rgba(61,220,138,0.35)",
                background: "rgba(61,220,138,0.10)",
                color: "#3ddc8a",
                fontSize: 24,
                fontWeight: 600,
              }}
            >
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
    size
  );
}
