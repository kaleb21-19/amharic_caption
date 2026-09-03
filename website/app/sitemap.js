const base = process.env.NEXT_PUBLIC_SITE_URL || "https://kaleb21-19.github.io/amharic_caption";

export default function sitemap() {
  return [
    { url: `${base}/`, lastModified: new Date() },
    { url: `${base}/pricing/`, lastModified: new Date() },
    { url: `${base}/install/`, lastModified: new Date() },
    { url: `${base}/faq/`, lastModified: new Date() },
  ];
}
