// npm run build:yegara — the website as plain files for Yegara (cPanel /
// Apache hosting): out/ + out/.htaccess, and yegara-site.zip to upload.
//
// Upload: cPanel > File Manager > public_html > Upload yegara-site.zip >
// right-click > Extract (keep "Show Hidden Files" on to see .htaccess).
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
// the domain on Yegara: npm run build:yegara -- https://example.et
const URL_ARG = process.argv[2] || process.env.YEGARA_URL || "";
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/?$/i.test(URL_ARG)) {
  console.error("Give the website address on Yegara, e.g.:  npm run build:yegara -- https://amharic-captions.et");
  process.exit(1);
}
const OUT = join(SITE, "out");
const ZIP = join(SITE, "yegara-site.zip");

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
const next = join(SITE, "node_modules", "next", "dist", "bin", "next");
execFileSync(process.execPath, [next, "build"], { cwd: SITE, stdio: "inherit", env: { ...process.env, SITE_EXPORT: "1", NEXT_PUBLIC_SITE_URL: URL_ARG.replace(/\/+$/, "") } });

// what Vercel does from next.config.mjs, for Apache: HTTPS, the security
// headers, the old /pricing and /faq links, the 404 page, cache rules
writeFileSync(join(OUT, ".htaccess"), `# Amharic Captions Pro website on Yegara (Apache). Made by scripts/yegara.mjs.
Options -Indexes
DirectoryIndex index.html
ErrorDocument 404 /404.html

<IfModule mod_rewrite.c>
  RewriteEngine On
  # always HTTPS (turn on the free SSL certificate in cPanel first)
  RewriteCond %{HTTPS} !=on
  RewriteCond %{HTTP:X-Forwarded-Proto} !=https
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
  # the old pages are sections of the homepage now (308 on Vercel)
  RewriteRule ^pricing/?$ /#pricing [R=301,NE,L]
  RewriteRule ^faq/?$ /#faq [R=301,NE,L]
  # /install -> /install/ (the site's URL shape)
  RewriteCond %{REQUEST_FILENAME} !-f
  RewriteCond %{REQUEST_FILENAME}/index.html -f
  RewriteRule ^(.*[^/])$ /$1/ [R=301,L]
</IfModule>

# the Telegram / social preview picture has no file extension
<Files "opengraph-image">
  ForceType image/png
</Files>

<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "SAMEORIGIN"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"
  <FilesMatch "\\.(html)$">
    Header set Cache-Control "no-cache"
  </FilesMatch>
  <If "%{REQUEST_URI} =~ m#^/_next/static/#">
    Header set Cache-Control "public, max-age=31536000, immutable"
  </If>
</IfModule>
`);

if (existsSync(ZIP)) rmSync(ZIP);
// one zip with everything (also the hidden .htaccess), ready for cPanel's Extract
if (process.platform === "win32") {
  execFileSync("powershell", ["-NoProfile", "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${OUT}', '${ZIP}')`], { stdio: "inherit" });
} else {
  execFileSync("zip", ["-qr", ZIP, "."], { cwd: OUT, stdio: "inherit" });
}
console.log("\nReady for Yegara (" + URL_ARG + "): " + ZIP + "\n(cPanel > File Manager > public_html > Upload > Extract)");
