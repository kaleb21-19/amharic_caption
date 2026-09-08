export const BOT_USERNAME = "AmharicCaptionsBot";
export const BOT_URL = "https://t.me/AmharicCaptionsBot";
export const GROUP_URL = "https://t.me/+L-bMfmIRyEo3MDg0";
export const CONTACT_URL = "https://t.me/sumpak6";
export const SUPPORT_URL = "https://t.me/sumpak6";
export const SITE_NAME = "Amharic Captions Pro";
export const SITE_URL = "https://amharic-caption-pro.vercel.app";
export const PRICE = "ETB 2,500";
export const PRICE_NUM = "2500";
export const PRICE_OLD = "ETB 3,500";
export const PRICE_OLD_NUM = "3500";

// Official payment details. We publish these so buyers can always verify they
// are paying the real seller — never pay anyone who claims to accept payment
// to a different account or a different name.
export const ACCT_NAME = "KALEB TEGEGEN";
export const ACCOUNTS = [
  { bank: "CBE", number: "1000504159977" },
  { bank: "Abyssinia", number: "402393939" },
  { bank: "Zemen", number: "1031111343277015" },
];
export const ACCOUNTS_LABEL = "CBE 1000504159977 · Abyssinia 402393939 · Zemen 1031111343277015";

// Download links. Pointed at "releases/latest/download/..." so they always
// resolve to the newest release that carries the zip (GitHub redirects the
// latest tag to the current head of main's build).
export const RELEASES_URL = "https://github.com/kaleb21-19/amharic_caption/releases/latest";
export const DL_WIN =
  "https://github.com/kaleb21-19/amharic_caption/releases/latest/download/amharic-captions-win-x64.zip";
export const DL_MAC_ARM =
  "https://github.com/kaleb21-19/amharic_caption/releases/latest/download/amharic-captions-mac-arm64.zip";
// Intel Macs: same latest-tag mechanism — x64 zip is uploaded manually when the
// CI runner (macos-13) is too slow to finish in time.
export const DL_MAC_X64 =
  "https://github.com/kaleb21-19/amharic_caption/releases/latest/download/amharic-captions-mac-x64.zip";
