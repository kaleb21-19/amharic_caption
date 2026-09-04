# Amharic Captions — Telegram Bot Setup Guide

This bot (a) welcomes new members, (b) answers the purchase/install/FAQ questions,
and (c) generates a license key when a buyer sends their Machine ID — but holds it
for **your approval** until you confirm the Telebirr payment, then DM's the key and
logs it to `customers.csv`.

Zero dependencies: uses only Python's standard library. No `pip install` needed.

---

## 1. What the bot already knows (already configured for you)

| Item | Value |
|---|---|
| Bot username | `@AmharicCaptionsBot` |
| Your admin chat id | set in `bot.env` (`AMH_ADMIN_ID`) |
| Token | set in `bot.env` (`AMH_TG_TOKEN`) — **gitignored, keep it secret** |

**Your admin chat id** is the numeric id of your own Telegram account. The bot sends
you approval buttons there. To change it, edit `AMH_ADMIN_ID` in `bot.env`.

---

## 2. Run the bot (on your computer or a VPS)

```bash
cd tools/telegram
python3 bot.py --check-token      # optional: verify token once
python3 bot.py                    # start the bot (long polling)
```

It runs in the foreground. Leave the terminal open. To keep it running:
- **Simple:** just leave that terminal running.
- **Better (survives reboot):** use `tmux` or run it on a cheap VPS /
  always-on computer (e.g. a small DigitalOcean/Hetzner Ubuntu box) with:

  ```bash
  # as a background service (Linux):
  nohup python3 bot.py > bot.log 2>&1 &
  ```

For a simple always-on setup on your own machine, use `tmux`:

```bash
tmux new -s bot
python3 bot.py
# detach with Ctrl+B then D (it keeps running)
# reattach later with: tmux attach -t bot
```

---

## 3. Telegram steps YOU must do (bot can't do these for itself)

### A. Add the bot to your sales group + make it admin
1. Create (or open) your sales group.
2. In the group, add a member → search `@AmharicCaptionsBot` → add it.
3. Promote it to **Administrator** (Admin) so it can post + delete/admit. Restrict
   only if you like; the bot needs permission to send messages in the group.

### B. Find the group's chat id (so the bot can post there)
The bot currently replies in DMs and in any group it's added to, but to also make
it post to the group proactively, get the group id:
1. Add the bot to the group (step A).
2. Send any message in the group, or add the bot → run:
   ```bash
   python3 bot.py --whoami
   ```
   It will print the group `chat_id` (a negative number, e.g. `-1001234567890`).
3. (Optional) Tell me that group id and I'll add a `AMH_GROUP_ID` setting so the
   bot always posts the welcome/announcements there.

Recommended: keep the bot in BOTH the group and as a DM target, so buyers can
either use the group or DM `@AmharicCaptionsBot` privately (private is safer for
key delivery).

---

## 4. How the sales flow works (end-to-end)

1. Buyer joins your group (or DMs the bot) → bot sends the welcome + menu:
   **💳 How to buy · 🛠 Install · ❓ FAQ · 🔑 Get my key**
2. Buyer sends their **Machine ID** (8 hex chars from the panel's License section).
3. Bot replies: "Machine ID received — please send ETB 2,500 via Telebirr to
   0907 628 809" and **notifies you** with an Approve / Reject / Expire keyboard.
4. **You check the Telebirr payment manually.** If paid, press **✅ Approve**.
5. Bot DM's the buyer their license key and logs the sale in `customers.csv`.
6. If you hit **❌ Reject**, the buyer is told the key wasn't sent.

> The bot **never auto-sends** a key. You always approve after confirming payment,
> so no one gets a key without paying.

---

## 5. Files

| File | Purpose |
|---|---|
| `bot.py` | The bot (runs it) |
| `bot.env` | Token + admin id (**secret, gitignored**) |
| `customers.csv` | Sale ledger (created on first sale, gitignored) |
| `pending.json` | In-progress orders (survives restart, gitignored) |

---

## 6. Commands recap

```bash
python3 bot.py --check-token   # validate token
python3 bot.py --whoami        # print chat ids (find your group id)
python3 bot.py --send "hi"     # send a test DM to your admin chat
python3 bot.py                 # run the bot
```

---

## 7. Security notes

- **Never commit `bot.env` or the token.** It's already gitignored.
- The license HMAC secret is plaintext in `bot.py` (same accepted trade-off as the
  panel). A skilled person could derive keys — the bot's Approve step still gives
  you manual control over actual sales.
- Keep the token private: anyone with it can control the bot.
