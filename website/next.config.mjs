// SITE_EXPORT=1 (npm run build:yegara): plain files for a normal web host
// such as Yegara (cPanel / Apache). There the security headers and the
// old-link redirects come from the .htaccess that scripts/yegara.mjs writes
// (the same rules as below); on Vercel nothing changes.
const STATIC = process.env.SITE_EXPORT === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(STATIC ? { output: "export" } : { headers, redirects }),
  images: { unoptimized: true },
  poweredByHeader: false,

  // Trailing slashes keep the existing URL shape (/install/ etc) stable.
  trailingSlash: true,
};

async function headers() {
  return [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "SAMEORIGIN" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    },
  ];
}

// /pricing and /faq are now sections of the homepage — the site is
// deliberately three pages. Redirect the old URLs instead of deleting them:
// they are in the published sitemap, indexed by search engines, and may be
// linked from Telegram messages already sent to customers. 308 = permanent,
// so the anchor is preserved and link equity moves to the homepage.
async function redirects() {
  return [
    { source: "/pricing", destination: "/#pricing", permanent: true },
    { source: "/pricing/", destination: "/#pricing", permanent: true },
    { source: "/faq", destination: "/#faq", permanent: true },
    { source: "/faq/", destination: "/#faq", permanent: true },
  ];
}

export default nextConfig;
