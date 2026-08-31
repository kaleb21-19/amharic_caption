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

def home_keyboard(extra=None):
    kb = [
        [{"text": "💳 መግዛት", "callback_data": "menu:buy"}],
        [{"text": "🛠 እንዴት እንደሚጫኑ", "callback_data": "menu:install"}],
        [{"text": "❓ ጥያቄዎች", "callback_data": "menu:faq"}],
        [{"text": "🔑 ሊሰንስ ቁልፍ ያግኙ", "callback_data": "menu:key"}],
        [{"text": "👤 ድጋፍ ያነጋግሩ", "callback_data": "menu:support"}],
    ]
    return kb if extra is None else kb + extra


def back_row():
    return [[{"text": "◀ ዋና ማውጫ", "callback_data": "menu:home"}]]


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
        f"{name}ሰላም! 👋 ወደ <b>አማርኛ ካፕሽን</b> እንኳን በደህና መጡ!\n\n"
        "በ Premiere Pro ላይ ቪዲዮዎን በራስ-ሰር <b>በአማርኛ ንዑስ ርዕስ</b> "
        "(subtitle) ያስቀምጡ። ሙሉ በሙሉ በኮምፒውተርዎ ላይ ይሰራል (offline)።\n\n"
        f"💰 ዋጋ: <b>{PRICE}</b> (አንድ ጊዜ)\n"
        f"📲 Telebirr: <b>{TELEBIRR}</b>\n"
        "🖥 Windows & Mac · 🎁 2 ነጻ trial\n\n"
        "ምን ማድረግ ይፈልጋሉ? ከታች ይምረጡ 👇"
    )


def hero_keyboard():
    return [[
        {"text": "💳 መግዛት", "callback_data": "menu:buy"},
        {"text": "🛠 መጫን", "callback_data": "menu:install"},
    ], [
        {"text": "❓ ጥያቄዎች", "callback_data": "menu:faq"},
        {"text": "🔑 ቁልፍ ያግኙ", "callback_data": "menu:key"},
    ], [
        {"text": "👤 ድጋፍ", "callback_data": "menu:support"},
    ]]


def menu_buy():
    text = (
        "💳 <b>እንዴት ይገዛሉ?</b>\n\n"
        "<b>①</b> የሶፍትዌሩን ፓነል ይክፈቱ → በ \"License\" ክፍል ውስጥ ያለውን "
        "<b>Machine ID</b> ይቅዱ\n"
        f"<b>②</b> <b>{PRICE}</b> በTelebirr ወደ <b>{TELEBIRR}</b> ይላኩ\n"
        "<b>③</b> የክፍያ ማረጋገጫ (screenshot) ከ Machine ID ጋር ይላኩ\n"
        "<b>④</b> ሊሰንስ ቁልፍ እንልክልዎታለን → በፓነሉ License ውስጥ "
        "ያስገቡ → <b>Activate</b> ይጫኑ\n\n"
        "🎁 ከመግዛትዎ በፊት <b>2 ነጻ</b> ካፕሽን የመስራት እድል አለዎት።\n\n"
        "👉 ቁልፍ ለማግኘት \"🔑 ሊሰንስ ቁልፍ ያግኙ\" ይንኩ፣ ወይም "
        "Machine ID ብቻ ይላኩ"
    )
    return text, home_keyboard(back_row())


def menu_install():
    text = (
        "🛠 <b>እንዴት ይጫናሉ?</b>\n\n"
        "⚠️ Premiere Pro <b>2024 (v24)</b> ወይም ከዚያ <b>አዲስ</b> ያስፈልጋል። "
        "(የቆዩ እትሞች አይደገፉም)\n\n"
        "<b>①</b> ፋይሉን ከዚህ ያውርዱ:\n"
        "   github.com/kaleb21-19/amharic_caption/releases/latest\n"
        "   (Windows → amharic-captions-win-x64.zip)\n\n"
        "<b>②</b> ፋይሉን ያውጡ (extract)። ፎልደሩን እዚህ ያስቀምጡ:\n"
        "   <code>C:\\Program Files (x86)\\Common Files\\Adobe\\CEP\\extensions\\</code>\n"
        "   (ስሙ com.amharic.captions መሆን አለበት)\n\n"
        "<b>③</b> Premiere Pro ይክፈቱ → Windows > Extensions > \"Amharic Captions\"\n\n"
        "<b>④</b> License ለማግኘት በፓነሉ ውስጥ ያለውን Machine ID ይቅዱ\n\n"
        "✅ ከተጫነ በኋላ <b>2 ነጻ</b> የመጠቀም እድል ይኖርዎታል!"
    )
    return text, home_keyboard(back_row())


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
        "ፈጣን መንገድ፡ የ<b>Machine ID</b>ዎን ብቻ ይላኩ።\n\n"
        "Machine ID በፓነሉ \"License\" ክፍል ውስጥ ይገኛል — <b>8 ቁምፊ</b> ብቻ "
        "(ለምሳሌ a1b2c3d4)።\n\n"
        "ቁልፍዎ የሚላከው ክፍያው ከተረጋገጠ <b>በኋላ</b> ብቻ ነው።"
    )
    return text, home_keyboard(back_row())


def menu_support():
    text = (
        "👤 <b>ድጋፍ</b>\n\n"
        "ችግር ካጋጠመዎት ወይም ጥያቄ ካለዎት፣ አስተዳዳሪውን በቀጥታ ያነጋግሩ።\n\n"
        "💬 ተጠቃሚዎች ግዢ፣ መጫኛ ወይም ቁልፍ ችግር ካጋጠማቸው እዚህ ይጽፋሉ።\n\n"
        "በ<code>/start</code> በመጠቀም ወደ ዋና ማውጫ መመለስ ይችላሉ።"
    )
    return text, home_keyboard(back_row())


def machine_id_request(mid):
    return (
        "📥 Machine ID ተቀብለናል: <code>{mid}</code>\n\n"
        "እባክዎ <b>{price}</b> በTelebirr ወደ <b>{telebirr}</b> ይላኩ።\n\n"
        "ከክፍያው በኋላ የማረጋገጫ ስክሪን ሾት (screenshot) ይላኩ። "
        "ክፍያውን ካረጋገጥን በኋላ ቁልፍዎ ወደዚህ ይደርስዎታል።"
    ).format(mid=mid, price=PRICE, telebirr=TELEBIRR)


def key_delivery_message(key, expiry="00000000", chat_type="private"):
    lines = [
        "✅ ሊሰንስ ቁልፍዎ ዝግጁ ነው!",
        "",
        f"<code>{key}</code>",
        "",
        "<b>①</b> ቁልፉን ይቅዱ (copy)",
        "<b>②</b> Premiere Pro → ፓነሉን ይክፈቱ → License",
        "<b>③</b> ቁልፉን ያስገቡ (paste) → <b>Activate</b> ይጫኑ",
    ]
    if expiry != "00000000":
        lines += ["", f"⏰ የሚያበቃበት ቀን: {expiry}"]
    if chat_type != "private":
        lines += ["", "🔒 ለግላዊነት፣ ቁልፍዎን በግል (DM) ይጠይቁ።"]
    lines += ["", "አመሰግናለሁ! 🙏 ችግር ካጋጠመዎት ይጻፉ።"]
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
                  f"⚠️ ይህ Machine ID (ለ<code>{mid}</code>) ቪዲዮ ቀድሞውኑ ቁልፍ አለው። "
                  "ቁልፍ ማግኘት ካልቻሉ ወይም እንደገና ማግኘት ከፈለጉ አስተዳዳሪውን ያነጋግሩ።")
        return True

    # build pending
    default_expiry = "00000000"
    PENDING[uid] = {"machine_id": mid, "expiry": default_expiry,
                    "username": uname, "chat_id": str(chat_id),
                    "chat_type": message["chat"]["type"]}
    save_pending()

    send_text(chat_id, machine_id_request(mid), keyboard=None)

    # notify admin
    if ADMIN_ID:
        send_text(ADMIN_ID,
            "🧾 <b>አዲስ ገዢ (New order)</b>\n\n"
            f"Machine ID: <code>{mid}</code>\n"
            f"ተጠቃሚ: @{uname} (id {uid})\n"
            f"ምንጭ: {'ግል (private DM)' if is_pm else 'ቡድን (group)'}\n\n"
            "ክፍያውን (Telebirr) ያረጋግጡ፣ ከዚያ ከታች ይንኩ:",
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
        if kind == "home":
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"],
                      MENU, MENU_KEYBOARD)
        elif kind == "buy":
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
        elif kind == "support":
            text, kb = menu_support()
            edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"], text, kb)
        return

    # admin-only actions
    if ADMIN_ID and from_uid != ADMIN_ID:
        answer_cb(cb_id, "ይህን የሚያደርገው አስተዳዳሪው ብቻ ነው")
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
        # deliver to buyer
        send_text(buyer_chat, key_delivery_message(key, exp, ctype))
        # confirm to admin
        edit_text(cb["message"]["chat"]["id"], cb["message"]["message_id"],
                  f"✅ ሊሰንስ ቁልፍ ተልኳል እና ተመዝግቧል።\n"
                  f"ተጠቃሚ: @{uname}\nMachine ID: <code>{mid}</code>")
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

                    if text.lower() in ("/start", "/start@amhariccaptionsbot", "/menu", "menu"):
                        if chat_type == "private":
                            send_text(chat["id"], hero(first), hero_keyboard())
                        else:
                            send_text(chat["id"], WELCOME, MENU_KEYBOARD)
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
