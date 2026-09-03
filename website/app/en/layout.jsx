import Header from "../../components/Header";
import Footer from "../../components/Footer";

export const metadata = {
  title: "Amharic Captions — Amharic Speech-to-Text for Premiere Pro",
  description:
    "Turn Amharic speech into captions right inside Adobe Premiere Pro. Fully on-device — no internet, no uploads. One-time fee of ETB 1,500 with a free trial.",
  alternates: {
    canonical: "/en/",
    languages: {
      "am-ET": "/",
      en: "/en/",
    },
  },
};

export default function EnglishLayout({ children }) {
  return (
    <>
      <Header lang="en" />
      <main>{children}</main>
      <Footer lang="en" />
    </>
  );
}
