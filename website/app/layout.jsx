import "./globals.css";
import { Inter, Source_Serif_4, Noto_Sans_Ethiopic } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import MobileBuyBar from "@/components/MobileBuyBar";
import { SITE_URL, BOT_URL, GROUP_URL, SUPPORT_URL } from "@/lib/site";

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
// Deliberately NOT adding a serif Ethiopic: the only Amharic on the site sits
// in body copy, so a second Ethiopic file would be pure weight on a metered
// Ethiopian connection for no visible gain.
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
// preload:false is deliberate. This file is 193KB — the whole Ge'ez block —
// against roughly 40 characters actually used on the site, and data is
// expensive in Ethiopia. Subsetting to those 40 would save ~180KB but breaks
// silently the moment anyone adds new Amharic copy (missing glyphs render as
// empty boxes with no error). Instead: don't let it compete with critical
// resources. With display:swap the Amharic paints immediately in the reader's
// system Ge'ez font — Windows ships Nyala, macOS ships Kefa, and Ethiopian
// Android devices have one — then upgrades to Noto when it arrives.
const ethiopic = Noto_Sans_Ethiopic({
  subsets: ["ethiopic"],
  variable: "--font-ethiopic",
  display: "swap",
  preload: false,
});

export const metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Amharic Captions Pro — 100% Offline Amharic Speech-to-Text for Premiere Pro",
  description:
    "Amharic captions inside Adobe Premiere Pro — fully on your machine. No uploads, no cloud, no internet needed. One-time ETB 2,500 lifetime license. Free 2-caption trial.",
  openGraph: {
    title: "Amharic Captions Pro — Amharic subtitles inside Adobe Premiere Pro",
    description:
      "Editable Amharic captions straight onto your Premiere timeline. Runs on your computer — no uploads, no internet needed. One-time ETB 2,500.",
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    // NB: og:image itself comes from app/opengraph-image.jsx (the file
    // convention wins over anything set here). trailingSlash:true means that
    // URL 308-redirects once before serving; verified it resolves in one hop
    // to a 1200x630 PNG, and every major crawler follows redirects.
  },
  twitter: {
    card: "summary_large_image",
    title: "Amharic Captions Pro — Amharic subtitles inside Adobe Premiere Pro",
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
          description: "One-time lifetime license.",
          url: SITE_URL,
          availability: "https://schema.org/InStock",
          priceValidUntil: "2027-12-31",
          seller: { "@type": "Organization", name: "Amharic Captions Pro" },
        },
        description:
          "Amharic speech-to-text captions for Adobe Premiere Pro. Runs on-device with no internet required.",
      },
    ],
  };
  return (
    <html
      lang="en"
      className={`${inter.variable} ${serif.variable} ${ethiopic.variable}`}
      style={{ backgroundColor: "#080d0c" }}
    >
      <head>
        <meta name="theme-color" content="#080d0c" />
        <meta name="color-scheme" content="dark" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        {/* Keyboard users land here first: one tab to jump the whole nav. */}
        <a className="skip" href="#main">Skip to content</a>
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
