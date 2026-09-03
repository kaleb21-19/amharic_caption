const base = process.env.NEXT_PUBLIC_SITE_URL || "https://kaleb21-19.github.io/amharic_caption";

export default function sitemap() {
  return [
    {
      url: `${base}/`,
      lastModified: new Date(),
      alternates: {
        languages: { "am-ET": `${base}/`, en: `${base}/en/` },
      },
    },
    {
      url: `${base}/en/`,
      lastModified: new Date(),
      alternates: {
        languages: { "am-ET": `${base}/`, en: `${base}/en/` },
      },
    },
  ];
}
