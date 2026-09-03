const base = process.env.NEXT_PUBLIC_SITE_URL || "https://kaleb21-19.github.io/amharic_caption";

export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${base}/sitemap.xml`,
  };
}
