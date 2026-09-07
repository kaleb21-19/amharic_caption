import { SITE_URL } from "@/lib/site";
const base = process.env.NEXT_PUBLIC_SITE_URL || SITE_URL;

export default function sitemap() {
  return [
    { url: `${base}/`, lastModified: new Date() },
    { url: `${base}/pricing/`, lastModified: new Date() },
    { url: `${base}/install/`, lastModified: new Date() },
    { url: `${base}/faq/`, lastModified: new Date() },
  ];
}
