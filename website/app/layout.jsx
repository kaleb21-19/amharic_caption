import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";
import { PRICE } from "@/lib/site";

export const metadata = {
  title: "Amharic Captions — Amharic Speech-to-Text for Premiere Pro",
  description:
    `Turn Amharic speech into perfectly timed, editable captions inside Adobe Premiere Pro. Runs 100% on-device — no internet, no uploads, no cloud. One-time fee ${PRICE}.`,
  openGraph: {
    title: "Amharic Captions — Amharic Speech-to-Text for Premiere Pro",
    description:
      "Auto-caption Amharic speech right in Premiere Pro. Fully on-device, editable timelines, one-time price.",
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
    name: "Amharic Captions",
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Windows, macOS",
    offers: {
      "@type": "Offer",
      price: "2000",
      priceCurrency: "ETB",
      description: "One-time lifetime license.",
    },
    description:
      "Amharic speech-to-text captions for Adobe Premiere Pro. Runs on-device with no internet required.",
  };
  return (
    <html lang="en" style={{ backgroundColor: "#0b1110" }}>
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
