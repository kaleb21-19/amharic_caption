import { SITE_URL } from "@/lib/site";
const base = process.env.NEXT_PUBLIC_SITE_URL || SITE_URL;

// Three real pages. /pricing and /faq were folded into the homepage and now
// 308-redirect there, so listing them would advertise redirects to crawlers.
export default function sitemap() {
  return [
    { url: `${base}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${base}/install/`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/legal/`, lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
  ];
}
