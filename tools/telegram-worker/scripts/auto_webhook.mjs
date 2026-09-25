#!/usr/bin/env node
// Auto webhook setter. Reads the Telegram bot token and webhook secret from
// bot.env so secrets never need to appear in a command line.
// Usage: node scripts/auto_webhook.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const botEnv = resolve(here, '../telegram/bot.env');
const webhookUrl = process.env.AMH_WEBHOOK_URL || 'https://amharic-captions-bot.amhcaps.workers.dev';

function fail(message) {
  console.error('[FAIL] ' + message);
  process.exit(1);
}

function readEnvValue(names) {
  for (const p of [botEnv, resolve(here, '../../telegram/bot.env'), resolve(here, 'telegram/bot.env')]) {
    try {
      const txt = readFileSync(p, 'utf8');
      for (const name of names) {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const m = txt.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"?([^"\\r\\n]+)"?\\s*$`, 'm'));
        if (m && m[1].trim()) return m[1].trim();
      }
    } catch {}
  }
  return null;
}

const token = process.env.AMH_TG_TOKEN || readEnvValue(['TELEGRAM_BOT_TOKEN', 'BOT_TOKEN', 'AMH_TG_TOKEN']);
if (!token) fail('Could not find AMH_TG_TOKEN/TELEGRAM_BOT_TOKEN in the environment or bot.env.');
const secret = process.env.AMH_WEBHOOK_SECRET || readEnvValue(['AMH_WEBHOOK_SECRET']);
if (!secret) fail('AMH_WEBHOOK_SECRET is required; the Worker rejects unsigned webhook updates.');
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) fail('AMH_WEBHOOK_SECRET must be 1–256 characters using only A-Z, a-z, 0-9, underscore, or hyphen.');
let parsedUrl;
try { parsedUrl = new URL(webhookUrl); } catch { parsedUrl = null; }
if (!parsedUrl || parsedUrl.protocol !== 'https:') fail('AMH_WEBHOOK_URL must be a valid https:// URL.');

async function telegram(method, params = {}) {
  const query = new URLSearchParams(params);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}${suffix}`);
  let body;
  try { body = await res.json(); } catch { body = { ok: false, description: `HTTP ${res.status}` }; }
  if (!res.ok || !body.ok) {
    throw new Error(`${method} failed (HTTP ${res.status}): ${body.description || 'unknown Telegram error'}`);
  }
  return body.result;
}

try {
  const me = await telegram('getMe');
  if (!me || !me.username) throw new Error('getMe returned no bot identity');
  const setResult = await telegram('setWebhook', {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: JSON.stringify(['message', 'callback_query', 'my_chat_member']),
  });
  if (setResult !== true) throw new Error('setWebhook did not return true');
  const info = await telegram('getWebhookInfo');
  if (!info || info.url !== webhookUrl) {
    throw new Error(`registered webhook URL mismatch: ${info && info.url ? info.url : '(none)'}`);
  }
  if (info.last_error_message) console.warn('[WARN] Telegram reports a last webhook error:', info.last_error_message);
  console.log(`Webhook verified for @${me.username}: ${webhookUrl} (secret_token: on)`);
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
