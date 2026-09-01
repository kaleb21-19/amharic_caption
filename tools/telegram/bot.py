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

# ── per-user finite state machine for the "send proof" buy flow ──────────────
# Every buyer is in exactly ONE of these states at a time:
#   absent        -> not in the buy flow (idle)
#   "mid"         -> waiting for their Machine ID (8 hex chars)
#   "photo"       -> waiting for their Telebirr screenshot (photo)
# FSM: uid -> {"step": "mid"|"photo", "mid": str|None, "photo": file_id|None}
FSM = {}

# Every buyer who ever messaged the bot privately, so the admin can broadcast.
# contact: uid -> {"chat_id", "username", "name", "first_seen"}
CONTACTS = {}
CONTACTS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "contacts.json")

# Admin-only: when True, the admin's next private text is a broadcast message.
BROADCASTING = False



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


def save_contacts():
    try:
        with open(CONTACTS_FILE, "w", encoding="utf-8") as f:
            json.dump(CONTACTS, f, ensure_ascii=False)
    except Exception:
        pass


def load_contacts():
    global CONTACTS
    CONTACTS = {}
    try:
        with open(CONTACTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            CONTACTS = data if isinstance(data, dict) else {}
    except Exception:
        CONTACTS = {}


def remember_contact(message):
    """Track any buyer who messaged the bot privately so /admin can broadcast."""
    user = message.get("from", {})
    uid = user.get("id")
    if not uid:
        return
    uid = str(uid)
    chat = message.get("chat", {})
    if chat.get("type") != "private":
        return
    existing = CONTACTS.get(uid)
    CONTACTS[uid] = {
        "chat_id": str(chat.get("id", uid)),
        "username": user.get("username") or existing.get("username") if existing else (user.get("username") or ""),
        "name": user.get("first_name") or existing.get("name", "") if existing else (user.get("first_name") or ""),
        "first_seen": existing.get("first_seen") if existing
                      else datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    save_contacts()


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
    if keyboard is not None:
        params["reply_markup"] = json.dumps({"inline_keyboard": keyboard})
    try:
        return api("editMessageText", **params)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
        # Telegram returns 400 "message is not modified" when the new text is
        # identical (e.g. double-tapping a button). That's benign, not a failure.
        if "not modified" in body:
            return None
        print(f"[edit] HTTP {e.code} -> {body[:300]}", file=sys.stderr)
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


def send_photo(chat_id, photo_path, caption=None, keyboard=None, parse_mode="HTML"):
    """Send a photo via multipart/form-data (stdlib only).
    The photo can be a file path, an existing Telegram file_id, or a URL."""
    params = {"chat_id": chat_id}
    if caption:
        params["caption"] = caption
        params["parse_mode"] = parse_mode
    if keyboard:
        params["reply_markup"] = json.dumps({"inline_keyboard": keyboard})
    boundary = "----AmhBotBoundary" + uuid.uuid4().hex
    body = b""
    if isinstance(photo_path, str) and (photo_path.startswith("http") or photo_path.endswith(".jpg") is False and ":" in photo_path and not os.path.isfile(photo_path)):
        pass  # placeholder, treated below
    # Build the multipart body: first any text params, then the photo file.
    text_parts = {k: v for k, v in params.items() if k != "photo"}
    for k, v in text_parts.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n"
                 f"{v}\r\n").encode("utf-8")
    if isinstance(photo_path, str) and os.path.isfile(photo_path):
        filename = os.path.basename(photo_path)
        with open(photo_path, "rb") as f:
            fdata = f.read()
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"; "
                 f"filename=\"{filename}\"\r\nContent-Type: image/jpeg\r\n\r\n").encode("utf-8")
        body += fdata
        body += b"\r\n"
    else:
        body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"photo\"\r\n\r\n"
                 f"{photo_path}\r\n").encode("utf-8")
    body += f"--{boundary}--\r\n".encode("utf-8")
    url = API + TOKEN + "/sendPhoto"
    req = urllib.request.Request(url, data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"[photo] HTTP {e.code} -> {e.read().decode('utf-8','replace')[:300]}", file=sys.stderr)
    except Exception as e:
        print(f"[photo] error: {e}", file=sys.stderr)
    return None


def send_with_hint(chat_id, text, hint, keyboard=None, parse_mode="HTML"):
    """Send a message with a persistent reply-keyboard that carries a
    placeholder hint in the input box (input_field_placeholder) telling the
    user WHAT to type (e.g. their Machine ID). This is the modern 'where do I
    type this?' affordance."""
    params = {"chat_id": chat_id, "text": text, "parse_mode": parse_mode}
    reply = {"keyboard": [[{"text": "📍 ማስተማሪያ / እገዛ"}]],
             "input_field_placeholder": hint, "resize_keyboard": True,
             "one_time_keyboard": False, "selective": False}
    params["reply_markup"] = json.dumps(reply)
    try:
        return api("sendMessage", **params)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace") if hasattr(e, "read") else ""
        print(f"[send] HTTP {e.code} -> {body[:300]}", file=sys.stderr)
    except Exception as e:
        print(f"[send] error: {e}", file=sys.stderr)
    return None


def admin_keyboard(action, payload):
    uid = str(payload["uid"])
    return [[
        {"text": "✅ አረጋግጥ", "callback_data": f"approve:{uid}"},
        {"text": "❌ ውድቅ", "callback_data": f"reject:{uid}"},
        {"text": "⏰ ጊዜ ስጥ", "callback_data": f"expiry:{uid}"},
    ]]


# ── user-facing copy (natural, correct Amharic) ─────────────────────────────
#: each menu handler returns a (text, keyboard) tuple.
#: sub-menus always carry a "◀ ዋና ማውጫ" (back) button so the user never gets stuck.

def base_nav():
    """Navigation row for sub-pages: back to the menu."""
    return [
        [{"text": "1️⃣ Install", "callback_data": "menu:install"}],
        [{"text": "2️⃣ Pay", "callback_data": "menu:pay"}],
        [{"text": "3️⃣ Machine ID", "callback_data": "menu:guide"}],
        [{"text": "4️⃣ Help", "callback_data": "menu:help"}],
        [{"text": "🔑 My Key", "callback_data": "menu:mykey"}],
        [{"text": "◀ Menu", "callback_data": "menu:home"}],
    ]


def home_keyboard(extra=None):
    kb = [
        [{"text": "1️⃣ Install", "callback_data": "menu:install"}],
        [{"text": "2️⃣ Pay", "callback_data": "menu:pay"}],
        [{"text": "3️⃣ Machine ID", "callback_data": "menu:guide"}],
        [{"text": "4️⃣ Help", "callback_data": "menu:help"}],
        [{"text": "🔑 My Key", "callback_data": "menu:mykey"}],
    ]
    return kb if extra is None else kb + extra


def back_row():
    return [[{"text": "◀ Menu", "callback_data": "menu:home"}]]


def menu_how():
    text = (
        "🎬 <b>እንዴት እንደሚሰራ (How it works)</b>\n\n"
        "ሙሉ ሂደቱን በ5 ደረጃ ይመልከቱ — ቀላል ነው! 👇\n\n"
        "<b>① ይጫኑ (Install)</b>\n"
        "ሶፍትዌሩን ያውርዱና ይጫኑ። ችግር ካለ \"🛠 እንዴት እንደሚጫኑ\" ይንኩ።\n\n"
        "<b>② ይሞክሩ (Try) — ነጻ</b>\n"
        "ከመግዛትዎ በፊት <b>2 ነጻ</b> ካፕሽን ይስሩ። እርካታ ካላስተኛ አይግዙም።\n\n"
        "<b>③ ይክፈሉ (Pay)</b>\n"
        f"<b>{PRICE}</b> በTelebirr ወደ <b>{TELEBIRR}</b> ይላኩ። "
        "የክፍያ ማረጋገጫ ስክሪን ሾት ያንሱ (screenshot)።\n\n"
        "<b>④ ያስገቡ (Send ID + proof)</b>\n"
        "የክፍያ ስክሪን ሾትዎን እና <b>Machine ID</b>ዎን ይላኩ።\n\n"
        "<b>⑤ ያግኙ (Get key)</b>\n"
        "ክፍያዎን ካረጋገጥን በኋላ ሊሰንስ ቁልፍ ወደዚህ እንልክልዎታለን → "
        "በፓነሉ License ውስጥ አስገብተው <b>Activate</b> ይጫኑ።\n\n"
        "👉 ለመጀመር \"🛠 እንዴት እንደሚጫኑ\" ይንኩ።"
    )
    return text, home_keyboard(back_row())


WELCOME = (
    "ሰላም! ወደ <b>አማርኛ ካፕሽን</b> እንኳን በደህና መጡ 👋\n\n"
    "ይህ ሶፍትዌር፣ Premiere Pro ላይ ቪዲዮዎን በራስ-ሰር በ<b>አማርኛ ንዑስ ርዕስ</b> "
    "(subtitle) ያስቀምጥልዎታል። ሙሉ በሙሉ በኮምፒውተርዎ ላይ ነው የሚሰራው (offline)።\n\n"
    f"💰 ዋጋ: <b>{PRICE}</b> (አንድ ጊዜ)\n"
    f"📲 Telebirr: <b>{TELEBIRR}</b>\n"
    "🖥 Windows & Mac\n"
    "🎁 2 ነጻ trial\n\n"
    "ከታች ያሉትን አዝራሮች ይጠቀሙ 👇"
)

MENU = (
    "ሰላም! 👋 ምን ማድረግ ይፈልጋሉ? ከታች ይምረጡ:"
)
MENU_KEYBOARD = home_keyboard()


def hero(first=""):
    name = f"{first}, " if first else ""
    return (
        f"{name}Welcome to <b>Amharic Captions</b> 👋\n\n"
        "1️⃣ <b>Install</b>\n"
        f"2️⃣ <b>Pay</b> — {PRICE} (Telebirr {TELEBIRR})\n"
        "3️⃣ <b>Machine ID</b>\n"
        "4️⃣ <b>Help</b>\n"
        "🔑 <b>My Key</b>\n\n"
        "👇 Tap one:"
    )


def hero_keyboard():
    return [
        [{"text": "1️⃣ Install", "callback_data": "menu:install"}],
        [{"text": "2️⃣ Pay", "callback_data": "menu:pay"}],
        [{"text": "3️⃣ Machine ID", "callback_data": "menu:guide"}],
        [{"text": "4️⃣ Help", "callback_data": "menu:help"}],
        [{"text": "🔑 My Key", "callback_data": "menu:mykey"}],
    ]


def menu_buy():
    return hero(), hero_keyboard()


def menu_pay():
    text = (
        "💰 <b>Pay</b>\n\n"
        f"Amount: <b>{PRICE}</b> (one-time, forever license)\n"
        f"Telebirr: <b>{TELEBIRR}</b>\n\n"
        "1️⃣ Send <b>ETB 1,500</b> via Telebirr to <b>0907 628 809</b>\n"
        "2️⃣ Screenshot the payment\n\n"
        "Then tap the button below to send your proof."
    )
    kb = [
        [{"text": "📤 I've paid — send proof", "callback_data": "pay:proof"}],
    ] + base_nav()
    return text, kb


def menu_payproof():
    """Single-ask 'send proof' starting screen: first request = Machine ID."""
    text = (
        "📤 <b>Send proof</b>\n\n"
        "Almost done! Two steps:\n\n"
        "<b>Step 1 of 2</b> — send your <b>Machine ID</b> (8 characters).\n"
        "It's in the panel's <b>License</b> section."
    )
    kb = [
        [{"text": "📍 Where is my Machine ID?", "callback_data": "menu:guide"}],
        [{"text": "✖ Cancel", "callback_data": "proof:cancel"}],
    ]
    return text, kb


def menu_help():
    text = (
        "4️⃣ <b>Help</b>\n\n"
        "❓ Questions?\n"
        "👤 Support: DM the seller — @AmharicCaptionsBot\n\n"
        "• 2 free captions to try\n"
        "• One-time ETB 1,500, forever license\n"
        "• Needs Premiere Pro 2024+"
    )
    return text, base_nav()


def menu_install():
    text = (
        "🛠 <b>Install</b>\n\n"
        "⚠️ Needs Premiere Pro <b>2024 (v24)</b> or newer.\n\n"
        "<b>1.</b> Download:\n"
        "   github.com/kaleb21-19/amharic_caption/releases/latest\n"
        "   (Windows → amharic-captions-win-x64.zip)\n\n"
        "<b>2.</b> Extract.\n\n"
        "<b>3.</b> Copy the folder to:\n"
        "   <code>C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions\\</code>\n"
        "   (must be named <code>com.amharic.captions</code>)\n\n"
        "<b>4.</b> Open Premiere → Windows > Extensions > \"Amharic Captions\"\n\n"
        "✅ Then you get <b>2 free</b> captions to try!"
    )
    return text, base_nav()



def menu_faq():
    text = (
        "❓ <b>ጥያቄዎች (FAQ)</b>\n\n"
        "<b>Q: ከመግዛት በፊት መሞከር እችላለሁ?</b>\n"
        "A: አዎ! እያንዳንዱ አዲስ ተጠቃሚ <b>2 ነጻ</b> ካፕሽን የመስራት እድል አለው። "
        "ፓነሉን ይክፈቱ → \"Generate Captions\" ይጫኑ።\n\n"
        "<b>Q: ቁልፉ ለብዙ ኮምፒውተር ይሰራል?</b>\n"
        "A: አይሰራም። እያንዳንዱ ቁልፍ ለ<b>አንድ</b> ኮምፒውተር ብቻ "
        "(hardware ID) ነው። ለሌላ ኮምፒውተር የተለየ ቁልፍ ያስፈልጋል።\n\n"
        "<b>Q: ቁልፉ መቼ ነው የሚያበቃው?</b>\n"
        "A: አያበቃም! <b>አንድ ጊዜ ክፍያ</b> ነው — subscription የለም።\n\n"
        "<b>Q: ክፍያው Telebirr ብቻ ነው?</b>\n"
        f"A: አዎ። Telebirr ወደ <b>{TELEBIRR}</b>።\n\n"
        "<b>Q: ኮምፒውተሬን ቀየርኩ / ቁልፍ አጣሁ?</b>\n"
        "A: አስተዳዳሪውን ያነጋግሩ። የግዢ ማረጋገጫ ካለ (proof of purchase) "
        "ወደነበረው እንዲመለስ እንረዳለን።\n\n"
        "<b>Q: ምን ኮምፒውተር ያስፈልጋል?</b>\n"
        "A: Windows / Mac ከ <b>Premiere Pro 2024 (v24)</b> ወይም ከዚያ አዲስ ጋር። "
        "የአማርኛ ሞዴሉ በራስዎ ኮምፒውተር ላይ ይሰራል — ኢንተርኔት አያስፈልገውም።"
    )
    return text, home_keyboard(back_row())


def menu_key_welcome(uid):
    text = (
        "🔑 <b>ሊሰንስ ቁልፍ ያግኙ</b>\n\n"
        "📌 <b>ሶፍትዌሩ ካልተጫነ Machine ID የለዎትም!</b>\n"
        "Machine ID ማየት የሚችሉት ሶፍትዌሩን ጭነው ፓነሉን ከከፈቱ <b>በኋላ</b> ብቻ ነው። "
        "ካልጫኑት መጀመሪያ \"🛠 እንዴት እንደሚጫኑ\" ይንኩ።\n\n"
        "ሶፍትዌሩ ከተጫነ፡-\n"
        "ፓነሉን ይክፈቱ → \"License\" ክፍል → ያለውን <b>Machine ID</b> (8 ቁምፊ) ይቅዱ → ይላኩ።\n\n"
        "ቁልፍዎ የሚላከው ክፍያው ከተረጋገጠ <b>በኋላ</b> ብቻ ነው።"
    )
    kb = home_keyboard(back_row())
    kb = [[{"text": "📍 Machine ID የት ነው?", "callback_data": "menu:guide"}]] + kb
    return text, kb


def menu_guide():
    """Explain where the Machine ID lives + send the annotated screenshot."""
    text = (
        "3️⃣ <b>Machine ID</b>\n\n"
        "Your unique computer number — <b>8 characters</b> (e.g. <code>a1b2c3d4</code>).\n\n"
        "<b>Where to find it:</b>\n"
        "1. Open Premiere → Windows > Extensions > \"Amharic Captions\"\n"
        "2. In the panel, open the <b>License</b> section\n"
        "3. Copy the \"Your Machine ID\" box\n\n"
        "⚙️ You need it when paying (step 2)."
    )
    return text, base_nav()


def menu_screenshot_help():
    text = (
        "📸 <b>የክፍያ ስክሪን ሾት እንዴት ይላካል?</b>\n\n"
        "በTelebirr <b>{price}</b> ወደ <b>{telebirr}</b> ከከፈሉ በኋላ፣ "
        "በስልክዎ ላይ የታየውን \"<b>ክፍያ ተሳክቷል / Success</b>\" ስክሪን "
        "ሾት ይንሱ (screenshot ይውሰዱ)።\n\n"
        "በTelegram ላይ ሾቱን ለመላክ:\n"
        "<b>①</b> ከታች ባለው <b>📎 (paperclip)</b> ምልክት ይንኩ\n"
        "<b>②</b> ስክሪን ሾቱን ይምረጡ (Gallery/Photos)\n"
        "<b>③</b> <b>Send</b> ይጫኑ\n\n"
        "ሾቱ እዚህ እንደደረሰ፣ የክፍያዎን ማረጋገጫ እናረጋግጣለን እና ቁልፍዎን "
        "በዚህ ቦት እንልክልዎታለን ✅"
    ).format(price=PRICE, telebirr=TELEBIRR)
    return text, home_keyboard(back_row())


def menu_support():
    text = (
        "👤 <b>ድጋፍ</b>\n\n"
        "ችግር ካጋጠመዎት ወይም ጥያቄ ካለዎት፣ አስተዳዳሪውን በቀጥታ ያነጋግሩ።\n\n"
        "💬 ተጠቃሚዎች ግዢ፣ መጫኛ ወይም ቁልፍ ችግር ካጋጠማቸው እዚህ ይጽፋሉ።\n\n"
        "በ<code>/start</code> በመጠቀም ወደ ዋና ማውጫ መመለስ ይችላሉ።"
    )
    return text, home_keyboard(back_row())


def key_delivery_message(key, expiry="00000000", chat_type="private"):
    lines = [
        "✅ <b>Your license key is ready!</b>",
        "",
        f"<code>{key}</code>",
        "",
        "<b>①</b> Copy the key",
        "<b>②</b> Premiere Pro → open the panel → License",
        "<b>③</b> Paste it → tap <b>Activate</b>",
    ]
    if expiry != "00000000":
        lines += ["", f"⏰ Expires: {expiry}"]
    if chat_type != "private":
        lines += ["", "🔒 For privacy, ask for your key in a private DM."]
    lines += ["", "Thank you! 🙏 If you have any trouble, message the admin."]
    return "\n".join(lines)


# ── helpers ─────────────────────────────────────────────────────────────────
MACHINE_ID_RE = re.compile(r"\b[a-f0-9]{8}\b")

def _suspicious_mid(mid):
    """Reject obviously-fake IDs that match the pattern by coincidence."""
    mid = mid.lower()
    if len(mid) != 8:
        return True
    if len(set(mid)) == 1:            # aaaaaaaa, 00000000, ffffffff
        return True
    if mid in ("00000000", "11111111", "12345678", "abcdefgh",
               "abcdef01", "deadbeef", "feedface", "cafebabe"):
        return True
    # sequential like 12345678 / abcdef etc.
    seq = "0123456789abcdef"
    for i in range(len(seq) - 7):
        if mid == seq[i:i + 8]:
            return True
        if mid == seq[i:i + 8][::-1]:
            return True
    return False

def mid_of_pending_or_none(uid):
    p = PENDING.get(str(uid))
    return p["machine_id"] if p else None


def _ask_screenshot(chat_id):
    """Step 2: Machine ID is in, ask for the Telebirr screenshot (a photo)."""
    send_text(chat_id,
              "✅ Machine ID received!\n\n"
              "📤 <b>Step 2 of 2</b> — now send your <b>Telebirr screenshot</b> "
              "as a <b>photo</b> (the \"payment success\" screen).",
              keyboard=[[{"text": "✖ Cancel", "callback_data": "proof:cancel"}]])
    return


def _complete_proof(uid, chat_id, uname, is_pm):
    """Both Machine ID + screenshot received -> build order + notify admin."""
    s = FSM.pop(uid, None)
    mid = s.get("mid") if s else None
    photo = s.get("photo") if s else None
    if not mid:
        return
    default_expiry = "00000000"
    PENDING[uid] = {"machine_id": mid, "expiry": default_expiry,
                    "username": uname, "chat_id": str(chat_id),
                    "chat_type": "private" if is_pm else "group"}
    save_pending()
    send_text(chat_id,
              "✅ <b>All received!</b>\n\n"
              f"Machine ID: <code>{mid}</code>\n"
              "Telebirr screenshot: ✅\n\n"
              "We're checking now. Your license key will be sent here once verified 🙏")
    if ADMIN_ID:
        cap = (
            "🧾 <b>New order — payment proof</b>\n\n"
            f"Machine ID: <code>{mid}</code>\n"
            f"User: @{uname} (id {uid})\n"
            f"Source: {'DM' if is_pm else 'Group'}\n\n"
            "Check the Telebirr screenshot, then Approve or Reject:"
        )
        kb = admin_keyboard("pending", {"uid": uid})
        if photo:
            send_photo(ADMIN_ID, photo, caption=cap, keyboard=kb)
        else:
            send_text(ADMIN_ID, cap, keyboard=kb)


def _find_keys_for_user(user):
    """Return the sold-key ledger rows belonging to this Telegram user.

    The ledger stores the buyer as '@username' in the 'name' column, so we match
    on the user's current username when available. This is the only identity
    signal we persist at sale time.
    """
    username = (user.get("username") or "").strip().lstrip("@").lower()
    if not username:
        return []
    rows = []
    for r in read_ledger():
        if r.get("status") != "sold":
            continue
        name = (r.get("name") or "").strip().lstrip("@").lower()
        if name == username:
            rows.append(r)
    return rows


def _show_my_key(user, chat_id, message_id=None):
    """Let a buyer recall their own license key from the ledger. NEVER exposes
    another buyer's key."""
    rows = _find_keys_for_user(user)
    if rows:
        lines = []
        for r in rows:
            exp = r.get("expiry", "00000000")
            exp_note = " (perpetual)" if exp in ("", "00000000") else f" (until {exp})"
            lines.append(f"• <code>{r.get('key')}</code>{exp_note}")
        text = ("🔑 <b>My Key</b>\n\n" +
                "License key(s) for your account:\n\n" +
                "\n".join(lines) +
                "\n\nNeed help activating? DM the admin.")
    else:
        text = ("🔑 <b>My Key</b>\n\n"
                "I couldn't find a key linked to <b>this Telegram account</b> "
                "yet.\n\n"
                "It will appear here automatically after your purchase is "
                "approved. If you paid and don't see it, DM the admin with your "
                "Machine ID.")
    if message_id is not None:
        edit_text(chat_id, message_id, text,
                  keyboard=[[{"text": "◀ Menu", "callback_data": "menu:home"}]])
    else:
        send_text(chat_id, text,
                  keyboard=[[{"text": "◀ Menu", "callback_data": "menu:home"}]])


def _render_or_edit(chat_id, message_id, text, keyboard):
    """Send a new message if message_id is None, else edit in place."""
    if message_id is None:
        return send_text(chat_id, text, keyboard=keyboard)
    return edit_text(chat_id, message_id, text, keyboard=keyboard)


def _admin_panel(chat_id, message_id):
    """Build the admin dashboard (pending orders + broadcast)."""
    n = len(PENDING)
    text = (
        "🛠 <b>Admin</b>\n\n"
        f"Pending orders: <b>{n}</b>\n"
        f"Broadcast recipients: <b>{len(CONTACTS)}</b>\n\n"
        "Book the Telebirr payment for each order, then Approve."
    )
    kb = [
        [{"text": f"📋 Pending orders ({n})", "callback_data": "admin:pending"}],
        [{"text": "📢 Broadcast", "callback_data": "admin:broadcast"}],
        [{"text": "◀ Menu", "callback_data": "menu:home"}],
    ]
    _render_or_edit(chat_id, message_id, text, kb)


def _admin_list_pending(chat_id, message_id):
    """Show all pending orders with approve/reject buttons."""
    if not PENDING:
        text = ("📋 <b>No pending orders.</b>\n\n"
                "When a buyer submits proof, their order appears here.")
        _render_or_edit(chat_id, message_id, text,
                        keyboard=[[{"text": "🛠 Admin", "callback_data": "admin:panel"}]])
        return
    for uid, p in list(PENDING.items()):
        cap = (
            f"🧾 <b>Order @{p.get('username','?')}</b>\n"
            f"Machine ID: <code>{p.get('machine_id')}</code>\n"
            f"Source: {p.get('chat_type','private')}"
        )
        kb = admin_keyboard("pending", {"uid": uid})
        send_text(chat_id, cap, keyboard=kb)
    text = "📋 Showing all pending orders."
    _render_or_edit(chat_id, message_id, text,
                    keyboard=[[{"text": "🛠 Admin", "callback_data": "admin:panel"}]])


def _admin_broadcast(chat_id, message_id):
    """Ask the admin for the broadcast message text."""
    global BROADCASTING
    BROADCASTING = True
    text = ("📢 <b>Broadcast</b>\n\n"
            f"This will send a message to all {len(CONTACTS)} known buyers.\n"
            "Reply with the message text to send, or /cancel.")
    _render_or_edit(chat_id, message_id, text,
                    keyboard=[[{"text": "✖ Cancel", "callback_data": "admin:cancel"}]])
    return text


def _broadcast_send(text):
    """Send a message to every known private buyer. Returns delivered count."""
    n = 0
    for uid, c in list(CONTACTS.items()):
        if not text:
            break
        try:
            r = send_text(c["chat_id"], text, keyboard=None)
            if r and r.get("ok"):
                n += 1
        except Exception:
            continue
    return n


def handle_buyer_message(message):
    """Return True if a message was treated as part of the buy/proof flow."""
    text = (message.get("text") or "").strip()
    user = message.get("from", {})
    uid = str(user.get("id"))
    uname = user.get("username") or user.get("first_name") or ""
    chat_id = message["chat"]["id"]
    is_pm = message["chat"]["type"] in ("private",)

    s = FSM.get(uid)
    step = s.get("step") if s else None

    # ── FSM step "photo": we're waiting for the screenshot, not text ─────────
    if step == "photo":
        send_text(chat_id,
                  "📸 I'm waiting for your <b>screenshot</b> — please send the "
                  "Telebirr payment screenshot as a <b>photo</b>.",
                  keyboard=[[{"text": "✖ Cancel", "callback_data": "proof:cancel"}]])
        return True

    # ── FSM step "mid": waiting for the Machine ID text ─────────────────────
    if step == "mid":
        m = MACHINE_ID_RE.search(text)
        if not m:
            send_text(chat_id,
                      "⚠️ You sent a message, but right now I need your "
                      "<b>Machine ID</b> — the <b>8-character</b> code from the "
                      "panel's <b>License</b> section (e.g. <code>a1b2c3d4</code>).",
                      keyboard=[[{"text": "📍 Where is my Machine ID?", "callback_data": "menu:guide"}],
                                [{"text": "✖ Cancel", "callback_data": "proof:cancel"}]])
            return True
        mid = m.group(0).lower()

        # Reject an obviously-fake Machine ID so we re-prompt instead of booking.
        if _suspicious_mid(mid):
            send_text(chat_id,
                      f"⚠️ <code>{mid}</code> doesn't look like a real <b>Machine ID</b>.\n\n"
                      "Your Machine ID is the <b>8 characters</b> shown under "
                      "\"Your Machine ID\" in the panel's License section "
                      "(e.g. <code>a1b2c3d4</code>).\n"
                      "Please copy and send the real one.",
                      keyboard=[[{"text": "📍 Where is my Machine ID?", "callback_data": "menu:guide"}],
                                [{"text": "✖ Cancel", "callback_data": "proof:cancel"}]])
            return True

        # Already delivered a key for this machine? Re-surface it instead of
        # booking a duplicate order. This runs INSIDE the flow so it can't
        # short-circuit the rest of the proof handling.
        existing = find_key(mid)
        if existing:
            send_text(chat_id,
                      f"🔑 This Machine ID (<code>{mid}</code>) already has a key.\n\n"
                      "Tap <b>My Key</b> below (or the 🔑 button in the menu) to "
                      "see it again, or contact the admin if it's not working.",
                      keyboard=[[{"text": "🔑 My Key", "callback_data": "proof:mykey"}],
                                [{"text": "✖ Cancel", "callback_data": "proof:cancel"}]])
            FSM.pop(uid, None)
            return True

        # Valid Machine ID -> save it, move to the screenshot step.
        s["mid"] = mid
        s["step"] = "photo"
        _ask_screenshot(chat_id)
        return True

    # ── Not in the FSM: only react to a bare Machine ID that's not part of the
    #    guided flow, but DON'T create a half-baked order from random text.
    m = MACHINE_ID_RE.search(text)
    if not m:
        return False
    mid = m.group(0)

    if _suspicious_mid(mid):
        send_text(chat_id,
                  f"⚠️ <code>{mid}</code> doesn't look like a real Machine ID.\n\n"
                  "Send the <b>8 characters</b> shown under \"Your Machine ID\" "
                  "in the panel (e.g. <code>a1b2c3d4</code>), or tap <b>2️⃣ Pay</b> "
                  "to start the guided purchase.",
                  keyboard=[[{"text": "2️⃣ Pay", "callback_data": "menu:pay"}],
                            [{"text": "📍 Where is my Machine ID?", "callback_data": "menu:guide"}]])
        return True

    # Tell them to use the guided flow rather than firing a raw order.
    send_text(chat_id,
              "👋 Got it — that looks like a Machine ID. To pay, please use the "
              "guided flow:\n\n"
              "1️⃣ Tap <b>2️⃣ Pay</b>\n"
              "2️⃣ Tap <b>I've paid — send proof</b>",
              keyboard=[[{"text": "2️⃣ Pay", "callback_data": "menu:pay"}]])
    return True


def handle_buyer_photo(message):
    """Accept a payment-proof screenshot and link it to the buyer's FSM state."""
    photos = message.get("photo")
    if not photos:
        return False
    file_id = photos[-1]["file_id"]  # largest resolution
    user = message.get("from", {})
    uid = str(user.get("id"))
    uname = user.get("username") or user.get("first_name") or ""
    chat_id = message["chat"]["id"]
    is_pm = message["chat"]["type"] in ("private",)

    s = FSM.get(uid)
    step = s.get("step") if s else None

    # ── FSM step "photo": this screenshot completes the order. ──────────────
    if step == "photo":
        s["photo"] = file_id
        _complete_proof(uid, chat_id, uname, is_pm)
        return True

    # ── FSM step "mid": they sent a photo, but we asked for a Machine ID. ───
    if step == "mid":
        s["photo"] = file_id
        send_text(chat_id,
                  "📸 Screenshot saved! Now please send your <b>Machine ID</b> "
                  "(8 characters) to finish Step 1.",
                  keyboard=[[{"text": "📍 Where is my Machine ID?", "callback_data": "menu:guide"}],
                            [{"text": "✖ Cancel", "callback_data": "proof:cancel"}]])
        return True

    # Not in the buy flow: kindly point them at the guided payment flow.
    send_text(chat_id,
              "🖼 Thanks — but to place an order please start the guided flow "
              "and send your <b>Machine ID</b> first:\n\n"
              "1️⃣ Tap <b>2️⃣ Pay</b>\n"
              "2️⃣ Tap <b>I've paid — send proof</b>",
              keyboard=[[{"text": "2️⃣ Pay", "callback_data": "menu:pay"}]])
    return True


# ── callback handling ───────────────────────────────────────────────────────
def handle_callback(cb):
    global BROADCASTING
    data = cb.get("data", "")
    cb_id = cb["id"]
    from_user = cb.get("from", {})
    from_uid = str(from_user.get("id"))

    # menu navigation (any user)
    if data.startswith("menu:"):
        answer_cb(cb_id, "ok")
        kind = data.split(":", 1)[1]
        if kind == "home":
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"],
                      MENU, MENU_KEYBOARD)
        elif kind == "how":
            text, kb = menu_how()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "buy":
            text, kb = menu_buy()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "pay":
            text, kb = menu_pay()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "help":
            text, kb = menu_help()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "install":
            text, kb = menu_install()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "faq":
            text, kb = menu_faq()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "key":
            text, kb = menu_key_welcome(from_uid)
            chat = cb["message"]["chat"]["id"]
            edit_text(chat, cb["message"]["message_id"], text, kb)
            # Persistent reply keyboard: tells the buyer EXACTLY what to type
            # and where (input_field_placeholder shown in the input box).
            send_with_hint(chat,
                           "✍️ ከታች ባለው ሳጥን ✍️ ውስጥ Machine ID ዎን ይቅዱ/ይጻፉ እና ይላኩ።",
                           "Machine ID እዚህ ይጻፉ (ለምሳሌ a1b2c3d4)...")
        elif kind == "support":
            text, kb = menu_support()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        elif kind == "guide":
            text, kb = menu_guide()
            chat = cb["message"]["chat"]["id"]
            edit_text(chat, cb["message"]["message_id"], text, kb)
            guide = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "guide_machine_id.jpg")
            if os.path.isfile(guide):
                send_photo(chat, guide,
                           caption="⬆️ \"Your Machine ID\" in the Licensed section — copy the 8 characters and send it.",
                           keyboard=[[{"text": "◀ Menu", "callback_data": "menu:home"}]])
        elif kind == "screenshot_help":
            text, kb = menu_screenshot_help()
            chat = cb["message"]["chat"]["id"]
            edit_text(chat, cb["message"]["message_id"], text, kb)
        elif kind == "mykey":
            chat = cb["message"]["chat"]["id"]
            mid = cb["message"]["message_id"]
            answer_cb(cb_id, "ok")
            _show_my_key(from_user, chat, mid)
        return

    # 'send proof' flow (any buyer)
    if data.startswith("pay:"):
        action = data.split(":", 1)[1]
        chat = cb["message"]["chat"]["id"]
        answer_cb(cb_id, "ok")
        if action == "proof":
            FSM[from_uid] = {"step": "mid", "mid": None, "photo": None}
            text, kb = menu_payproof()
            edit_text(chat, cb["message"]["message_id"], text, kb)
            send_with_hint(chat,
                           "📤 Send your <b>Machine ID</b> (8 characters).",
                           "Send Machine ID (e.g. a1b2c3d4)...")
        return

    # 'send proof' cancel / my-key (any buyer)
    if data.startswith("proof:"):
        action = data.split(":", 1)[1]
        chat = cb["message"]["chat"]["id"]
        mid = cb["message"]["message_id"]
        if action == "cancel":
            FSM.pop(from_uid, None)
            answer_cb(cb_id, "ተሰርዟል")
            edit_text(chat, mid, MENU, MENU_KEYBOARD)
            return
        if action == "mykey":
            answer_cb(cb_id, "ok")
            _show_my_key(from_user, chat, mid)
            return
        return

    # admin-only actions
    if ADMIN_ID and from_uid != ADMIN_ID:
        answer_cb(cb_id, "ይህን የሚያደርገው አስተዳዳሪው ብቻ ነው")
        return

    if data.startswith("admin:"):
        action = data.split(":", 1)[1]
        chat = cb["message"]["chat"]["id"]
        mid = cb["message"]["message_id"]
        answer_cb(cb_id, "ok")
        if action == "panel":
            _admin_panel(chat, mid)
        elif action == "pending":
            _admin_list_pending(chat, mid)
        elif action == "broadcast":
            _admin_broadcast(chat, mid)
        elif action == "cancel":
            BROADCASTING = False
            _admin_panel(chat, mid)
        return

    if data.startswith("approve:"):
        uid = data.split(":", 1)[1]
        p = PENDING.get(uid)
        if not p:
            answer_cb(cb_id, "የሚጠበቅ ትዕዛዝ የለም")
            return
        mid = p["machine_id"]
        exp = p["expiry"]
        key = generate_key(mid, exp)
        buyer_chat = p.get("chat_id") or uid
        uname = p.get("username", "buyer")
        ctype = p.get("chat_type", "private")
        save_to_ledger(mid, f"@{uname}", exp, key, "sold")

        # Deliver the key to the buyer's PRIVATE DM (this bot) when possible.
        # If the buyer bought from a group and hasn't started a private chat
        # with the bot, fall back to the chat they used and mark it private.
        delivered_dm = False
        try:
            r = send_text(uid, key_delivery_message(key, exp, "private"))
            if r and r.get("ok"):
                delivered_dm = True
        except Exception as e:
            print(f"[approve] DM to {uid} failed: {e}", file=sys.stderr)

        if delivered_dm:
            if ctype != "private":
                # still acknowledge in the group they bought from (no key shown)
                send_text(buyer_chat,
                          "🔑 የመግዛት እና የመክፈያ ሂደት ተጠናቋል ✅\n"
                          "@" + uname + " ቁልፍዎ በ<b>ግለ ቻት (DM)</b> ወደ እርስዎ ጋር "
                          "ወደዚህ ቦት ተልኳል። እዚያ ይፈልጉት።")
        else:
            # fall back to the chat they used (group) with privacy note
            send_text(buyer_chat, key_delivery_message(key, exp, ctype if ctype != "private" else "private"))

        # confirm to admin
        edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"],
                  f"✅ ሊሰንስ ቁልፍ ተልኳል እና ተመዝግቧል።\n"
                  f"ተጠቃሚ: @{uname}\nMachine ID: <code>{mid}</code>\n"
                  f"ቦት (DM): {'✅' if delivered_dm else '⚠️ ወደ ቡድን ተልኳል'}")
        answer_cb(cb_id, "ቁልፍ ተልኳል")
        PENDING.pop(uid, None)
        save_pending()
        return

    if data.startswith("reject:"):
        uid = data.split(":", 1)[1]
        p = PENDING.pop(uid, None)
        save_pending()
        edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"],
                  "❌ ጥያቄው ተሰርዟል።")
        answer_cb(cb_id, "ውድቅ ተደርጓል")
        if p:
            send_text(p.get("chat_id") or uid,
                      "ይቅርታ፣ የክፍያ ማረጋገጫ ስላልተገኘ ቁልፍ አልተላከም። "
                      "ጥያቄ ካለዎት አስተዳዳሪውን ያነጋግሩ።")
        return

    if data.startswith("expiry:"):
        uid = data.split(":", 1)[1]
        p = PENDING.get(uid)
        if p and p["expiry"] == "00000000":
            p["expiry"] = "20301231"
            save_pending()
            answer_cb(cb_id, "ቁልፍ እስከ 2030-12-31 ይሰራል")
        else:
            answer_cb(cb_id, "ጊዜ አልተቀመጠም / የሚጠበቅ የለም")
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
    global BROADCASTING

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

    # register the command menu (/ menu button) + bot description/about
    try:
        api("setMyCommands", commands=json.dumps([
            {"command": "start", "description": "ዋና ማውጫ / ጀምር"},
            {"command": "buy", "description": "እንዴት እንደሚገዙ"},
            {"command": "install", "description": "እንዴት እንደሚጫኑ"},
            {"command": "faq", "description": "ተደጋጋሚ ጥያቄዎች"},
            {"command": "support", "description": "ድጋፍ ማግኘት"},
        ]))
        api("setMyDescription",
            description="Premiere Pro ሶፍትዌር ላይ በአማርኛ ካፕሽን (ንዑስ ርዕስ) "
                        "በራስ-ሰር የሚያስቀምጥ ፕሮግራም ገዢዎች የሚጠቀሙበት ቦት። "
                        "Telebirr → 0907 628 809።")
        api("setMyShortDescription", short_description="የአማርኛ ካፕሽን ግዢ እና ድጋፍ ቦት")
        print("Commands/description registered.")
    except Exception as e:
        print(f"[setup] could not register commands/description: {e}", file=sys.stderr)

    load_pending()
    load_contacts()
    print("Amharic Captions bot started. Ctrl-C to stop.")
    offset = 0
    while True:
        try:
            for upd in get_updates(offset):
                offset = upd["update_id"] + 1
                if "message" in upd:
                    msg = upd["message"]
                    chat = msg.get("chat", {})
                    chat_type = chat.get("type", "private")
                    text = (msg.get("text") or "").strip()
                    first = msg.get("from", {}).get("first_name", "")

                    # new members (group welcome)
                    nms = msg.get("new_chat_members")
                    if nms:
                        send_text(chat["id"], WELCOME, MENU_KEYBOARD)
                        continue

                    # Track private contacts so /admin can broadcast to buyers.
                    remember_contact(msg)

                    # payment-proof screenshot?
                    if msg.get("photo") and handle_buyer_photo(msg):
                        continue

                    if text.lower() in ("/start", "/start@amhariccaptionsbot", "/menu", "menu"):
                        if chat_type == "private":
                            send_text(chat["id"], hero(first), hero_keyboard())
                        else:
                            send_text(chat["id"], WELCOME, MENU_KEYBOARD)
                        continue

                    if text.lower() in ("/mykey", "/mykey@amhariccaptionsbot"):
                        if chat_type == "private":
                            _show_my_key(msg.get("from", {}), chat["id"])
                        continue

                    # /admin (private, admin-only) -> admin dashboard
                    if text.lower() in ("/admin", "/admin@amhariccaptionsbot"):
                        if chat_type == "private" and ADMIN_ID and str(msg.get("from", {}).get("id")) == ADMIN_ID:
                            _admin_panel(chat["id"], None)
                        else:
                            send_text(chat["id"], "🔒 Admin only.")
                        continue

                    # admin broadcast reply
                    if BROADCASTING and ADMIN_ID and chat_type == "private" \
                            and str(msg.get("from", {}).get("id")) == ADMIN_ID:
                        if text.lower() in ("/cancel", "/cancel@amhariccaptionsbot"):
                            BROADCASTING = False
                            send_text(chat["id"], "Broadcast cancelled.", keyboard=None)
                            continue
                        if text:
                            n = _broadcast_send(text)
                            BROADCASTING = False
                            send_text(chat["id"],
                                      f"📢 Broadcast sent to {n} recipient(s).",
                                      keyboard=None)
                            continue
                        continue

                    if text.lower() in ("/help", "/faq", "/faq@amhariccaptionsbot"):
                        t, kb = menu_faq()
                        send_text(chat["id"], t, kb)
                        continue
                    if text.lower() in ("/buy", "/buy@amhariccaptionsbot"):
                        t, kb = menu_buy()
                        send_text(chat["id"], t, kb)
                        continue
                    if text.lower() in ("/install", "/install@amhariccaptionsbot"):
                        t, kb = menu_install()
                        send_text(chat["id"], t, kb)
                        continue
                    if text.lower() in ("/support", "/support@amhariccaptionsbot"):
                        t, kb = menu_support()
                        send_text(chat["id"], t, kb)
                        continue
                    # buyer Machine ID?
                    if handle_buyer_message(msg):
                        continue
                    if chat_type == "private":
                        # unknown input -> graceful acknowledgment + menu
                        send_text(chat["id"],
                                  f"😊 {first}፣ ያገባኝ አልመሰለኝም። ምን ማድረግ ይፈልጋሉ? "
                                  "ከታች ይምረጡ:",
                                  MENU_KEYBOARD)
                    else:
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
