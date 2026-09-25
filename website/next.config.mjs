/** @type {import('next').NextConfig} */
const nextConfig = {
  images: { unoptimized: true },
  poweredByHeader: false,
  async headers() {
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
  },

  // Trailing slashes keep the existing URL shape (/install/ etc) stable.
  trailingSlash: true,

  // /pricing and /faq are now sections of the homepage — the site is
  // deliberately three pages. Redirect the old URLs instead of deleting them:
  // they are in the published sitemap, indexed by search engines, and may be
  // linked from Telegram messages already sent to customers. 308 = permanent,
  // so the anchor is preserved and link equity moves to the homepage.
  async redirects() {
    return [
      { source: "/pricing", destination: "/#pricing", permanent: true },
      { source: "/pricing/", destination: "/#pricing", permanent: true },
      { source: "/faq", destination: "/#faq", permanent: true },
      { source: "/faq/", destination: "/#faq", permanent: true },
    ];
  },
};

export default nextConfig;
