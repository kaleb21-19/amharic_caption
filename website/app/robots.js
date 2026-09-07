import { SITE_URL } from "@/lib/site";
const base = process.env.NEXT_PUBLIC_SITE_URL || SITE_URL;

export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${base}/sitemap.xml`,
  };
}
