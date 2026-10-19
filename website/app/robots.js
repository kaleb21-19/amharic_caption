// made once at build time (also needed for the static export: npm run build:yegara)
export const dynamic = "force-static";
import { SITE_URL } from "@/lib/site";
const base = process.env.NEXT_PUBLIC_SITE_URL || SITE_URL;

export default function robots() {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: `${base}/sitemap.xml`,
  };
}
