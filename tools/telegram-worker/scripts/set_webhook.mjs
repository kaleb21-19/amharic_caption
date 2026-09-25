// Point the Telegram bot at your deployed Worker URL (webhook).
// Usage:  node scripts/set_webhook.mjs
//   Uses AMH_TG_TOKEN + AMH_WEBHOOK_URL + AMH_WEBHOOK_SECRET.
//   The secret is mandatory because the Worker rejects webhook requests when
//   its AMH_WEBHOOK_SECRET binding is absent.
const API = 'https://api.telegram.org/bot';
const token = process.env.AMH_TG_TOKEN;
const webhookUrl = process.env.AMH_WEBHOOK_URL;
const webhookSecret = process.env.AMH_WEBHOOK_SECRET || '';

function fail(message) {
  console.error('[FAIL] ' + message);
  process.exit(1);
}

if (!token || !webhookUrl || !webhookSecret) {
  fail('Set AMH_TG_TOKEN, AMH_WEBHOOK_URL, and AMH_WEBHOOK_SECRET (the Worker requires the secret).');
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(webhookSecret)) {
  fail('AMH_WEBHOOK_SECRET must be 1–256 characters using only A-Z, a-z, 0-9, underscore, or hyphen.');
}
let parsedUrl;
try { parsedUrl = new URL(webhookUrl); } catch { parsedUrl = null; }
if (!parsedUrl || parsedUrl.protocol !== 'https:') {
  fail('AMH_WEBHOOK_URL must be a valid https:// URL.');
}

async function telegram(method, params = {}) {
  const query = new URLSearchParams(params);
  const suffix = query.toString() ? '?' + query.toString() : '';
  const res = await fetch(`${API}${token}/${method}${suffix}`);
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
  const params = {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: JSON.stringify(['message', 'callback_query', 'my_chat_member']),
  };
  const setResult = await telegram('setWebhook', params);
  if (setResult !== true) throw new Error('setWebhook did not return true');
  const info = await telegram('getWebhookInfo');
  if (!info || info.url !== webhookUrl) {
    throw new Error(`registered webhook URL mismatch: ${info && info.url ? info.url : '(none)'}`);
  }
  if (info.last_error_message) {
    console.warn('[WARN] Telegram reports a last webhook error:', info.last_error_message);
  }
  console.log(`Webhook verified for @${me.username}: ${webhookUrl} (secret_token: on)`);
} catch (error) {
  fail(error && error.message ? error.message : String(error));
}
