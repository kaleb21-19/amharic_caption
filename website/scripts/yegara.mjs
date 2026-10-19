// npm run build:yegara -- https://<domain> — the website as plain files for
// Yegara (Standard Hosting: DirectAdmin, LiteSpeed - reads .htaccess like
// Apache): out/ + .htaccess files, and yegara-site.zip to upload.
//
// Upload: DirectAdmin > File Manager > domains/<domain>/public_html >
// Upload yegara-site.zip > Extract (hidden files: .htaccess).
// Only directives LiteSpeed and Apache both support (no <If> blocks).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
// the domain on Yegara: npm run build:yegara -- https://example.com
const URL_ARG = process.argv[2] || process.env.YEGARA_URL || "";
if (!/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}\/?$/i.test(URL_ARG)) {
  console.error("Give the website address on Yegara, e.g.:  npm run build:yegara -- https://amhariccaption.com");
  process.exit(1);
}
const OUT = join(SITE, "out");
const ZIP = join(SITE, "yegara-site.zip");

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
const next = join(SITE, "node_modules", "next", "dist", "bin", "next");
execFileSync(process.execPath, [next, "build"], { cwd: SITE, stdio: "inherit", env: { ...process.env, SITE_EXPORT: "1", NEXT_PUBLIC_SITE_URL: URL_ARG.replace(/\/+$/, "") } });

// what Vercel does from next.config.mjs: HTTPS, the security headers, the old
// /pricing and /faq links, the 404 page; plus cache rules
writeFileSync(join(OUT, ".htaccess"), `# Amharic Captions Pro website on Yegara (LiteSpeed / Apache). Made by scripts/yegara.mjs.
Options -Indexes
DirectoryIndex index.html
ErrorDocument 404 /404.html

<IfModule mod_rewrite.c>
  RewriteEngine On
  # always HTTPS (turn on the free SSL certificate in DirectAdmin first)
  RewriteCond %{HTTPS} !=on
  RewriteCond %{HTTP:X-Forwarded-Proto} !=https
  RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]
  # one address: www.<domain> -> <domain>
  RewriteCond %{HTTP_HOST} ^www\\.(.+)$ [NC]
  RewriteRule ^ https://%1%{REQUEST_URI} [R=301,L]
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
</IfModule>
`);
// _next/static files have their content hash in the name: cache them for a year
writeFileSync(join(OUT, "_next", "static", ".htaccess"), `# made by scripts/yegara.mjs: these file names change when their content does
<IfModule mod_headers.c>
  Header set Cache-Control "public, max-age=31536000, immutable"
</IfModule>
`);

if (existsSync(ZIP)) rmSync(ZIP);
// one zip with everything (also the hidden .htaccess files), ready to Extract
// Windows: its own tar (bsdtar) - the .NET zip of Windows PowerShell wrote
// "install\index.html" paths, which a Linux server unpacks as ONE file with
// a backslash in its name (every page but the home page, and all CSS / JS,
// were missing on the server)
// (the one in System32: Git's tar on the PATH takes "C:" for a remote host)
const WINTAR = join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
if (process.platform === "win32") {
  execFileSync(WINTAR, ["-a", "-c", "-f", ZIP, ...readdirSync(OUT)], { cwd: OUT, stdio: "inherit" });
} else {
  execFileSync("zip", ["-qr", ZIP, "."], { cwd: OUT, stdio: "inherit" });
}
// never ship a zip with Windows paths again
const names = execFileSync(process.platform === "win32" ? WINTAR : "unzip", process.platform === "win32" ? ["-tf", ZIP] : ["-Z1", ZIP]).toString();
const list = names.split(/\r?\n/);
if (names.includes("\\") || !list.includes("install/index.html") || !list.includes(".htaccess")) {
  console.error("The zip does not look right (backslashes, or install/index.html or .htaccess missing):\n" + names.slice(0, 600));
  process.exit(1);
}
console.log("\nReady for Yegara (" + URL_ARG + "): " + ZIP + "\n(DirectAdmin > File Manager > domains/<domain>/public_html > Upload > Extract)");
