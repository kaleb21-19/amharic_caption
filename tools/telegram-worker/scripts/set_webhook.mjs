// Point the Telegram bot at your deployed Worker URL (webhook).
// Usage:  node scripts/set_webhook.mjs  (uses AMH_TG_TOKEN + AMH_WEBHOOK_URL env)
const API = 'https://api.telegram.org/bot';
const token = process.env.AMH_TG_TOKEN;
const webhookUrl = process.env.AMH_WEBHOOK_URL;

if (!token || !webhookUrl) {
  console.error('Set AMH_TG_TOKEN and AMH_WEBHOOK_URL (e.g. https://yourapp.workers.dev)');
  process.exit(1);
}

const url = `${API}${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`;
const res = await fetch(url);
const json = await res.json();
console.log('setWebhook result:', JSON.stringify(json));
if (json.ok) console.log('Webhook set. Bot is always-on via', webhookUrl);
else console.error('setWebhook failed:', json.description);
