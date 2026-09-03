const base = process.env.NEXT_PUBLIC_SITE_URL || "https://kaleb21-19.github.io/amharic_caption";

export default function sitemap() {
  return [
    { url: `${base}/`, lastModified: new Date() },
    { url: `${base}/#features`, lastModified: new Date() },
    { url: `${base}/#pricing`, lastModified: new Date() },
  ];
}
