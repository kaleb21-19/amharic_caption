import "./globals.css";
import { Inter, Source_Serif_4, Noto_Sans_Ethiopic } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import MobileBuyBar from "@/components/MobileBuyBar";
import Tx from "@/components/Tx";
import { SITE_URL, BOT_URL, GROUP_URL, SUPPORT_URL } from "@/lib/site";
import { LANG_KEY } from "@/lib/site";

// Runs before first paint: applies the visitor's saved language so English
// readers never see a flash of Amharic (see components/Tx.jsx).
const LANG_BOOT = `try{if(localStorage.getItem("${LANG_KEY}")==="en"){var r=document.documentElement;r.setAttribute("data-lang","en");r.lang="en"}}catch(e){}`;

// Type system. Self-hosted from this deploy — no third-party CDN.
//
// DISPLAY — Source Serif 4. Adobe's own open-source serif, which is a real
// argument and not a decoration: this product lives inside Adobe Premiere, so
// its headlines are set in the type Adobe designed. A serif also does what a
// generic UI sans cannot — it reads as considered and editorial rather than
// like every other SaaS landing page, which is what "classic and professional"
// actually requires. Loaded at 600/700 only: headlines never need nine weights.
//
// UI — Inter, for everything a person reads at small sizes: body copy, buttons,
// labels, the panel mock. Inter is built for screen UI at 13-16px, where a
// serif turns muddy. Serif for the voice, sans for the interface.
//
// AMHARIC — Noto Sans Ethiopic. Ge'ez must never fall back to a Latin face.
// The site is Amharic by default (English via the toggle), headlines included;
// still no serif Ethiopic, one Ethiopic file is enough weight on a metered
// Ethiopian connection.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});
const serif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["600", "700"],
  style: ["normal"],
  variable: "--font-serif",
  display: "swap",
});
// preload:false is deliberate. This file is 193KB and data is expensive in
// Ethiopia. With display:swap the Amharic paints immediately in the reader's
// system Ge'ez font — Windows ships Nyala/Ebrima, macOS ships Kefa, and
// Ethiopian Android devices have one — then upgrades to Noto when it arrives.
const ethiopic = Noto_Sans_Ethiopic({
  subsets: ["ethiopic"],
  variable: "--font-ethiopic",
  display: "swap",
  preload: false,
});

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Amharic Captions Pro — የአማርኛ ካፕሽን ለPremiere፣ After Effects፣ CapCut እና DaVinci | 100% Offline",
  description:
    "የአማርኛ ካፕሽን በደቂቃዎች — ለPremiere Pro፣ After Effects፣ CapCut እና DaVinci Resolve፣ ያለ ኢንተርኔት። Amharic captions for Premiere Pro, After Effects, CapCut and DaVinci Resolve, made on your computer. No uploads, no internet needed. One-time ETB 2,500. 2 free captions to try.",
  openGraph: {
    title: "Amharic Captions Pro — Amharic subtitles for Premiere, After Effects, CapCut & DaVinci",
    description:
      "Editable Amharic captions on your Premiere or After Effects timeline, or a ready .srt for CapCut and DaVinci. Runs on your computer — no uploads, no internet needed. One-time ETB 2,500.",
    type: "website",
    locale: "am_ET",
    alternateLocale: ["en_US"],
    url: SITE_URL,
    // NB: og:image itself comes from app/opengraph-image.jsx (the file
    // convention wins over anything set here). trailingSlash:true means that
    // URL 308-redirects once before serving; verified it resolves in one hop
    // to a 1200x630 PNG, and every major crawler follows redirects.
  },
  twitter: {
    card: "summary_large_image",
    title: "Amharic Captions Pro — Amharic subtitles for Premiere, After Effects, CapCut & DaVinci",
  },
  alternates: {
    canonical: "/",
  },
};

export default function RootLayout({ children }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Amharic Captions Pro",
        url: SITE_URL,
        sameAs: [BOT_URL, GROUP_URL, SUPPORT_URL],
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "sales and support",
          url: BOT_URL,
        },
      },
      {
        "@type": "SoftwareApplication",
        name: "Amharic Captions Pro",
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Windows, macOS",
        url: SITE_URL,
        brand: { "@type": "Brand", name: "Amharic Captions Pro" },
        offers: {
          "@type": "Offer",
          price: "2500",
          priceCurrency: "ETB",
          description: "One-time payment, no renewal.",
          url: SITE_URL,
          availability: "https://schema.org/InStock",
          priceValidUntil: "2027-12-31",
          seller: { "@type": "Organization", name: "Amharic Captions Pro" },
        },
        description:
          "Amharic speech-to-text captions for Adobe Premiere Pro, After Effects, CapCut and DaVinci Resolve. Runs on-device with no internet required.",
      },
    ],
  };
  return (
    <html
      lang="am"
      suppressHydrationWarning
      className={`${inter.variable} ${serif.variable} ${ethiopic.variable}`}
      style={{ backgroundColor: "#080d0c" }}
    >
      <head>
        <meta name="theme-color" content="#080d0c" />
        <meta name="color-scheme" content="dark" />
        <script dangerouslySetInnerHTML={{ __html: LANG_BOOT }} />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        {/* Keyboard users land here first: one tab to jump the whole nav. */}
        <a className="skip" href="#main"><Tx am="ወደ ዋናው ይዘት ይለፉ" en="Skip to content" /></a>
        <Header />
        {/* <main> was missing entirely — screen readers had no primary landmark
            to jump to, and every page was one undifferentiated region. */}
        <main id="main">{children}</main>
        <Footer />
        <MobileBuyBar />
      </body>
    </html>
  );
}
