import "./globals.css";

export const metadata = {
  title: "Amharic Captions — የአማርኛ ትርጉም አድራጊ ለPremiere Pro",
  description:
    "በAdobe Premiere Pro ውስጥ የአማርኛ ንግግርን በራስ ወደ ትርጉም (captions) ይለውጡ። በመሣሪያዎ ላይ ብቻ ይሠራል — በይነመረብ አያስፈልግም። የአንድ ጊዜ ክፍያ ETB 1,500።",
  openGraph: {
    title: "Amharic Captions — ለPremiere Pro",
    description:
      "የአማርኛ ንግግርን በቀላሉ ወደ ትርጉም ይለውጡ። በመሣሪያዎ ላይ ብቻ፣ በይነመረብ ሳያስፈልግ። ETB 1,500 የአንድ ጊዜ ክፍያ።",
    type: "website",
    locale: "am_ET",
  },
  alternates: {
    canonical: "/",
    languages: {
      "am-ET": "/",
      en: "/en/",
    },
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
      price: "1500",
      priceCurrency: "ETB",
      description: "One-time lifetime license for Amharic speech-to-text captions in Adobe Premiere Pro.",
    },
    description:
      "Amharic speech-to-text captions for Adobe Premiere Pro. Runs on-device with no internet required.",
  };
  return (
    <html lang="am" dir="ltr">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
