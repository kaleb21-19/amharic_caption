// Point the Telegram bot at your deployed Worker URL (webhook).
// Usage:  node scripts/set_webhook.mjs
//   Uses AMH_TG_TOKEN + AMH_WEBHOOK_URL env (and optionally AMH_WEBHOOK_SECRET,
//   registered as Telegram's secret_token so only real Telegram traffic hits
//   the worker).
const API = 'https://api.telegram.org/bot';
const token = process.env.AMH_TG_TOKEN;
const webhookUrl = process.env.AMH_WEBHOOK_URL;
const webhookSecret = process.env.AMH_WEBHOOK_SECRET || '';

if (!token || !webhookUrl) {
  console.error('Set AMH_TG_TOKEN and AMH_WEBHOOK_URL (e.g. https://yourapp.workers.dev)');
  process.exit(1);
}

const params = new URLSearchParams({ url: webhookUrl });
if (webhookSecret) params.set('secret_token', webhookSecret);
params.set('allowed_updates', JSON.stringify(['message', 'callback_query', 'my_chat_member']));

const url = `${API}${token}/setWebhook?${params.toString()}`;
const res = await fetch(url);
const json = await res.json();
console.log('setWebhook result:', JSON.stringify(json));
if (json.ok) {
  console.log('Webhook set. Bot is always-on via', webhookUrl,
    webhookSecret ? '(secret_token: on)' : '(WARNING: no secret_token — spoofable)');
} else {
  console.error('setWebhook failed:', json.description);
}
