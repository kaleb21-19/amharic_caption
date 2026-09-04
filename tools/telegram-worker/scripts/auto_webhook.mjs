#!/usr/bin/env node
// Auto webhook setter. Reads the Telegram bot token from bot.env so the
// secret never needs to appear in any chat or terminal-visible command.
// Usage: node scripts/auto_webhook.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const botEnv = resolve(here, '../telegram/bot.env');
const webhookUrl = process.env.AMH_WEBHOOK_URL || 'https://amharic-captions-bot.amhcaps.workers.dev';

function readBotToken() {
  // try different env-file locations so it works from anywhere in the repo
  const candidates = [
    botEnv,
    resolve(here, '../../telegram/bot.env'),
    resolve(here, 'telegram/bot.env'),
  ];
  for (const p of candidates) {
    try {
      const txt = readFileSync(p, 'utf8');
      const m = txt.match(/^\s*(?:TELEGRAM_BOT_TOKEN|BOT_TOKEN|AMH_TG_TOKEN)\s*=\s*"?([A-Za-z0-9:_-]+)"?\s*$/m);
      if (m) return m[1];
    } catch {}
  }
  return null;
}

const token = readBotToken();
if (!token) {
  console.error('Could not find the bot token in bot.env. Open tools/telegram/bot.env and check the key name.');
  process.exit(1);
}

const url = `https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
const res = await fetch(url);
const json = await res.json();
console.log('setWebhook result:', JSON.stringify(json));
// verify
const me = await (await fetch(`https://api.telegram.org/bot${token}/getMe`)).json();
console.log('getMe:', me.ok ? `bot is @${me.result.username}` : 'FAILED');

// also confirm which URL Telegram has registered
const info = await (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)).json();
console.log('webhook info:', JSON.stringify(info.result));
