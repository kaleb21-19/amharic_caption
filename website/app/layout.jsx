import "./globals.css";
import Header from "@/components/Header";
import Footer from "@/components/Footer";

export const metadata = {
  title: "Amharic Captions Pro — Amharic Speech-to-Text for Premiere Pro",
  openGraph: {
    title: "Amharic Captions Pro — Amharic Speech-to-Text for Premiere Pro",
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
