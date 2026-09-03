/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  // Served from a sub-path on GitHub Pages: https://<user>.github.io/<repo>/
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || "/amharic_caption",
};

export default nextConfig;
