#!/usr/bin/env python3
"""Amharic Captions Telegram sales/support bot.

Zero-dependency: uses only Python stdlib (urllib) + the raw Telegram Bot API
with long polling. Runs on any machine with internet.

Setup
-----
1. Create the bot with @BotFather and copy its token.
2. Put the token in bot_config.env (or export env vars directly):
       AMH_TG_TOKEN=<your token>
       AMH_ADMIN_ID=<your numeric chat id>
   To find your chat id, after starting the bot send it any message: it will
   not know you yet, but the log will print your id. Then set AMH_ADMIN_ID.
3. Run:  python3 bot.py
4. Add the bot to your sales group and make it an administrator.

The bot NEVER sends a license key automatically. When a buyer sends a Machine
ID it generates a key but keeps it PENDING until you (the admin) approve the
sale with the Approve button, after you confirm the Telebirr payment manually.
Approving DM's the key to the buyer and logs it to customers.csv.
"""
import argparse
import csv
import hmac
import hashlib
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import uuid
from datetime import datetime

# ── config ──────────────────────────────────────────────────────────────────
def _env(key, default=""):
    return os.environ.get(key, default)

TOKEN = _env("AMH_TG_TOKEN", "").strip()
ADMIN_ID = _env("AMH_ADMIN_ID", "").strip()
PRICE = "ETB 1,500"
TELEBIRR = "0907 628 809"
LEDGER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "customers.csv")
SECRET = b"7JBrcWoJAXZYNDczdPjIn1Kyv2Wynqz1_d73_-fdC4g="

API = "https://api.telegram.org/bot"


# ── license key logic (same as tools/keygen.py / panel js/main.js) ──────────
def generate_key(machine_id, expiry="00000000"):
    mid = machine_id.strip().lower()
    if len(mid) != 8 or not all(c in "0123456789abcdef" for c in mid):
        raise ValueError("Invalid Machine ID (need 8 hex chars, e.g. a1b2c3d4)")
    msg = f"{mid}|{expiry}".encode()
    sig = hmac.new(SECRET, msg, hashlib.sha256).hexdigest()[:8]
    raw = f"{mid}{expiry}{sig}"
    parts = [raw[i:i + 4] for i in range(0, len(raw), 4)]
    return "AMH-" + "-".join(parts)


def valid_machine_id(mid):
    try:
        generate_key(mid)
        return True
    except ValueError:
        return False


# ── customer ledger (same CSV format as tools/deliver_key.py) ───────────────
def read_ledger():
    rows = []
    if os.path.exists(LEDGER):
        with open(LEDGER, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    return rows


def save_to_ledger(mid, name, expiry, key, status="sold"):
    rows = read_ledger()
    header = ["machine_id", "name", "expiry", "key", "status"]
    rows = [r for r in rows if r["machine_id"] != mid]
    rows.append({"machine_id": mid, "name": name or "-", "expiry": expiry,
                 "key": key, "status": status})
    with open(LEDGER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(rows)


def find_key(mid):
    for r in read_ledger():
        if r["machine_id"] == mid and r.get("status") == "sold":
            return r
    return None


# ── pending (awaiting admin approval) store ─────────────────────────────────
# In-memory. Keys: telegram user id -> {"machine_id", "expiry", "username"}
PENDING = {}
# optional file so pending survives a restart
PENDING_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pending.json")


def save_pending():
    try:
        with open(PENDING_FILE, "w", encoding="utf-8") as f:
            json.dump(PENDING, f, ensure_ascii=False)
    except Exception:
        pass


def load_pending():
    global PENDING
    try:
        with open(PENDING_FILE, "r", encoding="utf-8") as f:
            PENDING = json.load(f)
    except Exception:
        PENDING = {}


# ── Telegram API helpers (stdlib only) ──────────────────────────────────────
def api(method, **params):
    url = API + TOKEN + "/" + method
    data = json.dumps(params).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


def send_text(chat_id, text, keyboard=None, parse_mode="HTML"):
    params = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    if keyboard:
        params["reply_markup"] = json.dumps({"inline_keyboard": keyboard})
    try:
        return api("sendMessage", **params)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
        print(f"[send] HTTP {e.code} -> {body[:300]}", file=sys.stderr)
    except Exception as e:
        print(f"[send] error: {e}", file=sys.stderr)
    return None


def edit_text(chat_id, message_id, text, keyboard=None, parse_mode="HTML"):
    params = {"chat_id": chat_id, "message_id": message_id, "text": text, "parse_mode": parse_mode}
    if keyboard:
        params["reply_markup"] = json.dumps({"inline_keyboard": keyboard})
    try:
        return api("editMessageText", **params)
    except Exception as e:
        print(f"[edit] error: {e}", file=sys.stderr)
    return None


def answer_cb(callback_query_id, text=None):
    params = {"callback_query_id": callback_query_id}
    if text:
        params["text"] = text
    try:
        return api("answerCallbackQuery", **params)
    except Exception as e:
        print(f"[cb] error: {e}", file=sys.stderr)
    return None


def admin_keyboard(action, payload):
    uid = str(payload["uid"])
    return [[
        {"text": "✅ አረጋግጥ (Approve)", "callback_data": f"approve:{uid}"},
        {"text": "❌ አትስጥ (Reject)", "callback_data": f"reject:{uid}"},
        {"text": "✏️ ቀነ-ገደብ (Expire)", "callback_data": f"expiry:{uid}"},
    ]]


# ── messages (from selling.md / POSTS.md) ───────────────────────────────────
WELCOME = (
    "👋 እንኳን ወደ <b>አማርኛ ካፕሽን</b> በደህና መጡ!\n\n"
    "ይህ ሶፍትዌር Premiere Pro ላይ ቪዲዮዎን በነጻ የአማርኛ ንዑስ ርዕስ (subtitle/caption) "
    "ያስቀምጥልዎታል — በኮምፒውተርዎ ላይ ብቻ ይሰራል (offline, on-device)።\n\n"
    f"💰 <b>{PRICE}</b> (one-time) · 📲 Telebirr <b>{TELEBIRR}</b> · 🖥 Windows & Mac\n\n"
    "🔍 ለመግዛት እና ለ2 ነጻ trial → ከታች ያለውን ይንኩ 👇"
)

MENU = (
    "መረጃ ይምረጡ (select an option):"
)
MENU_KEYBOARD = [
    [{"text": "💳 እንዴት እንደሚገዙ (How to buy)", "callback_data": "menu:buy"}],
    [{"text": "🛠 እንዴት እንደሚጫኑ (Install)", "callback_data": "menu:install"}],
    [{"text": "❓ ጥያቄዎች (FAQ)", "callback_data": "menu:faq"}],
    [{"text": "🔑 ሊሰንስ ኬይ አግኝ (Get my key)", "callback_data": "menu:key"}],
]

#: each handler returns a (text, keyboard_or_None) tuple
def menu_buy():
    text = (
        "📌 <b>እንዴት እንደሚገዙ</b>\n\n"
        "1. የሶፍትዌሩን ፓነል ይክፈቱና \"Your Machine ID\" የሚለውን ቁጥር ይቅዱ\n"
        "   (Copy the Machine ID in the panel's License section).\n\n"
        f"2. <b>{PRICE}</b> በTelebirr ወደ <b>{TELEBIRR}</b> ይላኩ\n\n"
        "3. የTelebirr ማረጋገጫ (screenshot) እና Machine ID ይላኩ\n\n"
        "4. ሊሰንስ ኬይ ወደ እርስዎ ይላካል። በፓነሉ License field ውስጥ "
        "ተጭነው \"Activate\" ይጫኑ\n\n"
        "✅ ሁሉም ሰው ከመግዛቱ በፊት <b>2 ነጻ</b> ካፕሽን የመስራት ዕድል አለው።\n\n"
        "👉 ኬይ ለማግኘት \"🔑 ሊሰንስ ኬይ አግኝ\" ይንኩ (በፍጥነት: Machine ID ብቻ ይላኩ)"
    )
    return text, MENU_KEYBOARD


def menu_install():
    text = (
        "🛠 <b>እንዴት እንደሚጫኑ</b>\n\n"
        "⚠️ Premiere Pro <b>2024 (v24) or newer</b> ያስፈልጋል (older are NOT supported).\n\n"
        "1. ለኮምፒውተርዎ የሚሆነውን ፋይል ከ\n"
        "   https://github.com/kaleb21-19/amharic_caption/releases/latest አውርድ\n"
        "   (Windows → amharic-captions-win-x64.zip)\n\n"
        "2. ይዘቱን አውጣ። ፎልደሩን በ:\n"
        "   <code>C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions\\</code>\n"
        "   ስር አስቀምጥ (ስሙ com.amharic.captions መሆን አለበት)\n\n"
        "3. Premiere Pro ከፍት → Windows > Extensions > \"Amharic Captions\" ክፈት\n\n"
        "4. License ለማግኘት Machine ID ቅዳ።\n\n"
        "✅ ከተጫነ በኋላ 2 ነጻ trial አለ!"
    )
    return text, MENU_KEYBOARD


def menu_faq():
    text = (
        "❓ <b>ጥያቄዎች (FAQ)</b>\n\n"
        "<b>ከመግዛት በፊት እንዴት መሞከር እችላለሁ?</b>\n"
        "Every new user can run 2 free transcriptions. Open the panel → Generate "
        "Captions → see the result, then buy.\n\n"
        "<b>ሊሰንስ ኬይ ለብዙ ኮምፒውተር ይሰራል?</b>\n"
        "No. Each key is locked to one computer (hardware ID).\n\n"
        "<b>መቼ ነው የሚቆየው?</b> One-time purchase, permanent (no subscription).\n\n"
        "<b>Telebirr ብቻ?</b> Yes, Telebirr to 0907 628 809.\n\n"
        "<b>ኮምፒውተሬን ቀይሬያለሁ / key አጣሁ?</b> DM admin — we can reactivate "
        "(with proof of purchase).\n\n"
        "<b>ምን አይነት ኮምፒውተር ያስፈልጋል?</b> Windows/Mac with Premiere Pro 2024 (v24) or newer."
    )
    return text, MENU_KEYBOARD


def menu_key_welcome(uid):
    text = (
        "🔑 <b>ሊሰንስ ኬይ አግኝ</b>\n\n"
        "አጭር ጎዳና (fast): በቀጥታ የ<b>Machine ID</b>ዎን ያስገቡ ብቻ።\n"
        "Machine ID ከፓነሉ License ክፍል ይቅዱታል (8 characters, e.g. a1b2c3d4).\n\n"
        "ኬይ ከተከፈለ በኋላ ብቻ ይላካል — ማረጋገጫ ከወጣ በኋላ።"
    )
    return text, None


def key_delivery_message(key, expiry="00000000"):
    lines = [
        "✅ የእርስዎ license key ተዘጋጅቷል!",
        "",
        f"<code>{key}</code>",
        "",
        "1. ይህን ኬይ ቅዳ (copy)",
        "2. Premiere Pro ውስጥ ፓነሉን ክፈት → License",
        "3. ኬዩን paste አድርግ → <b>Activate</b> ተጫን",
    ]
    if expiry != "00000000":
        lines += ["", f"⏰ የሚቆይበት ጊዜ: እስከ {expiry}"]
    lines += ["", "አመሰግናለሁ! 🙏 ችግር ካለ DM ይጻፉ።"]
    return "\n".join(lines)


# ── helpers ─────────────────────────────────────────────────────────────────
MACHINE_ID_RE = re.compile(r"\b[a-f0-9]{8}\b")

def mid_of_pending_or_none(uid):
    p = PENDING.get(str(uid))
    return p["machine_id"] if p else None


def handle_buyer_message(message):
    """Return True if a message was treated as a Machine ID submission."""
    text = (message.get("text") or "").strip()
    if not text:
        return False
    m = MACHINE_ID_RE.search(text)
    if not m:
        return False
    mid = m.group(0)
    user = message.get("from", {})
    uid = str(user.get("id"))
    uname = user.get("username") or user.get("first_name") or ""
    chat_id = message["chat"]["id"]
    is_pm = message["chat"]["type"] in ("private",)

    # Already delivered a key for this machine?
    existing = find_key(mid)
    if existing:
        send_text(chat_id,
                  f"⚠️ ይህ Machine ID ({mid}) ሊሰንስ አለው አስቀድሞ። ኬይ ከተጠየቀ ወይም እንደገና ከፈለጉ ይጻፉ።")
        return True

    # build pending
    default_expiry = "00000000"
    PENDING[uid] = {"machine_id": mid, "expiry": default_expiry,
                    "username": uname, "chat_id": str(chat_id)}
    save_pending()

    send_text(chat_id,
        f"📥 Machine ID ተቀብለናል: <code>{mid}</code>\n"
        f"📲 እባክዎ <b>{PRICE}</b> በTelebirr ወደ <b>{TELEBIRR}</b> ይላኩ።\n"
        "ማረጋገጫ (screenshot) ይላኩ — ከተረጋገጠ በኋላ ኬይዎ ይደርስዎታል።",
        keyboard=None)

    # notify admin
    if ADMIN_ID:
        send_text(ADMIN_ID,
            "🧾 <b>አዲስ ግዢ ጥያቄ (new order)</b>\n\n"
            f"Machine ID: <code>{mid}</code>\n"
            f"Bot user: @{uname} (id {uid})\n"
            f"Chat: {'private DM' if is_pm else 'group'}\n\n"
            "ማረጋገጫ ይመልከቱ (check Telebirr payment) ከዚያ ከታች ይንኩ:",
            keyboard=admin_keyboard("pending", {"uid": uid}))
    return True


# ── callback handling ───────────────────────────────────────────────────────
def handle_callback(cb):
    data = cb.get("data", "")
    cb_id = cb["id"]
    from_user = cb.get("from", {})
    from_uid = str(from_user.get("id"))

    # menu navigation (any user)
    if data.startswith("menu:"):
        answer_cb(cb_id, "ok")
        kind = data.split(":", 1)[1]
        if kind == "buy":
            text, kb = menu_buy()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "install":
            text, kb = menu_install()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "faq":
            text, kb = menu_faq()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "key":
            text, kb = menu_key_welcome(from_uid)
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        return

    # admin-only actions
    if ADMIN_ID and from_uid != ADMIN_ID:
        answer_cb(cb_id, "Only the admin can do this")
        return

    if data.startswith("approve:"):
        uid = data.split(":", 1)[1]
        p = PENDING.get(uid)
        if not p:
            answer_cb(cb_id, "No pending order")
            return
        mid = p["machine_id"]
        exp = p["expiry"]
        key = generate_key(mid, exp)
        buyer_chat = p.get("chat_id") or uid
        uname = p.get("username", "buyer")
        save_to_ledger(mid, f"@{uname}", exp, key, "sold")
        # deliver to buyer
        send_text(buyer_chat, key_delivery_message(key, exp))
        # confirm to admin
        edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"],
                  f"✅ ኬይ ለ @{uname} (Machine <code>{mid}</code>) ተልኳል እና ተመዝግቧል።")
        answer_cb(cb_id, "Key sent")
        PENDING.pop(uid, None)
        save_pending()
        return

    if data.startswith("reject:"):
        uid = data.split(":", 1)[1]
        p = PENDING.pop(uid, None)
        save_pending()
        edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"],
                  "❌ ጥያቄ ተሰርዟል (rejected).")
        answer_cb(cb_id, "Rejected")
        if p:
            send_text(p.get("chat_id") or uid,
                      "በቅጽበት የክፍያ ማረጋገጫ ስላልተገኘ ኬይ አልተላከም። ጥያቄ ካለ ይጻፉ።")
        return

    if data.startswith("expiry:"):
        uid = data.split(":", 1)[1]
        p = PENDING.get(uid)
        if p and p["expiry"] == "00000000":
            p["expiry"] = "20301231"
            save_pending()
            answer_cb(cb_id, "Expiry set to 2030-12-31")
        else:
            answer_cb(cb_id, "Already has expiry / no pending")
        return


# ── main loop ───────────────────────────────────────────────────────────────
def get_updates(offset):
    url = (f"{API}{TOKEN}/getUpdates?timeout=30&offset={offset}"
           "&allowed_updates=%5B%22message%22,%22callback_query%22,%22my_chat_member%22%5D")
    try:
        with urllib.request.urlopen(url, timeout=40) as r:
            return json.loads(r.read().decode("utf-8")).get("result", [])
    except Exception as e:
        print(f"[poll] error: {e}", file=sys.stderr)
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", help="send a text message to AMH_ADMIN_ID (test)", nargs="?", const="hello")
    ap.add_argument("--check-token", action="store_true", help="validates the bot token")
    ap.add_argument("--whoami", action="store_true",
                    help="DMs a 'from' message to the bot? No — read all pending updates "
                         "and print the last private chat id (your admin id). DM the bot "
                         "first, then run this.")
    args = ap.parse_args()

    if args.check_token:
        try:
            me = api("getMe")
            print("Bot is:", me["result"]["username"], "OK")
        except Exception as e:
            print("TOKEN invalid/network error:", e)
        return

    if args.send is not None:
        r = send_text(ADMIN_ID, str(args.send))
        print("sent to admin", ADMIN_ID, "-> OK" if r else "-> FAILED")
        return

    if args.whoami:
        found = []
        for upd in get_updates(0):
            if "message" in upd:
                msg = upd["message"]
                c = msg.get("chat", {})
                user = msg.get("from", {})
                found.append({
                    "chat_id": c.get("id"),
                    "chat_type": c.get("type"),
                    "first": user.get("first_name"),
                    "username": user.get("username"),
                    "text": (msg.get("text") or "")[:40],
                })
            elif "my_chat_member" in upd:
                mcm = upd["my_chat_member"]
                c = mcm.get("chat", {})
                found.append({"chat_id": c.get("id"), "chat_type": c.get("type"),
                              "note": "bot added to chat"})
        if not found:
            print("No updates yet. DM @AmharicCaptionsBot (press Start / send /start), "
                  "then run --whoami again.")
            return
        for f in found:
            print(json.dumps(f, ensure_ascii=False))
        print("\nSet AMH_ADMIN_ID to your PRIVATE chat id (chat_type 'private').")
        return

    if not TOKEN:
        print("No AMH_TG_TOKEN set. See bot.py docstring / BOT_SETUP.md", file=sys.stderr)
        return
    if not ADMIN_ID:
        print("Note: AMH_ADMIN_ID not set yet. Bot still runs; buyer messages will only be logged.",
              file=sys.stderr)

    load_pending()
    print("Amharic Captions bot started. Ctrl-C to stop.")
    offset = 0
    while True:
        try:
            for upd in get_updates(offset):
                offset = upd["update_id"] + 1
                if "message" in upd:
                    msg = upd["message"]
                    chat = msg.get("chat", {})
                    text = (msg.get("text") or "").strip()
                    if text in ("/start", "/menu", "menu"):
                        send_text(chat["id"], MENU, MENU_KEYBOARD)
                        continue
                    if text in ("/help", "/faq"):
                        t, kb = menu_faq()
                        send_text(chat["id"], t, kb)
                        continue
                    # buyer Machine ID?
                    if handle_buyer_message(msg):
                        continue
                    # new member welcome
                    nms = msg.get("new_chat_members") or msg.get("left_chat_member")
                    if nms:
                        send_text(chat["id"], WELCOME, MENU_KEYBOARD)
                        continue
                    # unknown text -> show menu
                    send_text(chat["id"], MENU, MENU_KEYBOARD)
                elif "callback_query" in upd:
                    try:
                        handle_callback(upd["callback_query"])
                    except Exception as e:
                        print(f"[cb] err {e}", file=sys.stderr)
        except KeyboardInterrupt:
            print("\nStopped.")
            break
        except Exception as e:
            print(f"[loop] error: {e}", file=sys.stderr)
            time.sleep(3)


if __name__ == "__main__":
    main()
