import "./globals.css";
import { Inter, Noto_Sans_Ethiopic } from "next/font/google";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

// Self-hosted webfonts (served from this deploy — no third-party CDN, fits the
// "everything is yours" brand). Inter carries all Latin copy; Noto Sans
// Ethiopic renders any Ge'ez text (the Amharic samples in the mockup).
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const ethiopic = Noto_Sans_Ethiopic({ subsets: ["ethiopic"], variable: "--font-ethiopic", display: "swap" });

export const metadata = {
  title: "Amharic Captions Pro — 100% Offline Amharic Speech-to-Text for Premiere Pro",
  description:
    "Amharic captions inside Adobe Premiere Pro — fully on your machine. No uploads, no cloud, no internet needed. One-time ETB 2,500 lifetime license. Free 2-caption trial.",
  openGraph: {
    title: "Amharic Captions Pro — 100% Offline Amharic Captions for Premiere Pro",
    type: "website",
    locale: "en_US",
    url: "/",
  },
  alternates: {
    canonical: "/",
  },
};

export default function RootLayout({ children }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Amharic Captions Pro",
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Windows, macOS",
    offers: {
      "@type": "Offer",
      price: "2500",
      priceCurrency: "ETB",
      description: "One-time lifetime license.",
      priceValidUntil: "2027-12-31",
    },
    description:
      "Amharic speech-to-text captions for Adobe Premiere Pro. Runs on-device with no internet required.",
  };
  return (
    <html
      lang="en"
      className={`${inter.variable} ${ethiopic.variable}`}
      style={{ backgroundColor: "#0b1110" }}
    >
      <head>
        <meta name="theme-color" content="#0b1110" />
        <meta name="color-scheme" content="dark" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <Header />
        {children}
        <Footer />
      </body>
    </html>
  );
}
