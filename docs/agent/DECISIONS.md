# DECISIONS — the owner decided these (do not re-propose without asking)

Add a line (with the date) when the owner decides something. Keep < 60 lines.

## Product
- No model training / fine-tuning. Improve with decoding, rules, word lists (measured).
- Nothing may slow transcription. Time every engine change.
- Afaan Oromo is NOT released (tested 2026-10, friend: not accurate). Branch feature/oromo is parked.
- Other languages only as an optional download, measured first, Amharic untouched.
- No find & replace / search box in the review. Fix a word -> "Change all (N)" / "Always fix".
- Speaker marks were removed on purpose in 1.10.14 (owner request). Do not re-add without asking.
- No next/previous navigation buttons in the review (owner rejected; the orange marks are enough).
- Amharic TTS: free models (e.g. MMS) are non-commercial — do not ship them. A sample clip must be the owner's own recording.
- Nothing persistent above the caption list; hints hide after use.
- Update experience (2026-10-14): a "What's new" card on the first open after a version change — once per version, never on a first install; ✕ closes it, and "Try it" goes to the review's style strip (before the review exists the card itself says what to do first for a few seconds); the update banner says what the update brings + that the license stays and opens the website's download section (not the new-user install steps); the footer has a pressable "Check for updates".
- Customize starts closed for every caption (2026-10-13). Preview = caption strip only.
- Fonts must be free for commercial use (OFL). Abyssinica SIL ships unmodified (Reserved Font Name).
- Never ship third-party videos or faces (thumbnails, demos, promo videos): neutral backgrounds.

## Money
- Prices: 1 month ETB 500, 2 months ETB 900, Forever ETB 2,500. No yearly plan.
- Free trial: 30 minutes, valid 7 days, given by the Telegram bot (one per Telegram account and per computer).
- Payment: bank transfer through the bot only. No Telebirr / Chapa for now.
- Partners: owner-controlled; default reward 300 / buyer discount 200 on Forever only; 100 / 150 on short plans.
- Buyer referrals: OFF by default.

## Community / marketing
- No public jobs channel; jobs only in the group's Editing Jobs topic.
- Never post, message customers, broadcast or publish in the owner's name: prepare the text, the owner sends.
- Customer texts: Amharic first, then English; polite form (እርስዎ) in product texts and promo videos.

## Process
- The owner merges every PR. Never push to main.
- The owner merges a PR as soon as it exists: after giving a PR link, that version counts as published.
  Any later change = new branch + new version.
- Migrations: `npm run migrate` BEFORE `npm run deploy`.
