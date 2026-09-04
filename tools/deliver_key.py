#!/usr/bin/env python3
"""Deliver an Amharic Captions license key and log the sale.

Ties a Machine ID to a buyer so you can track who paid (Telegram sales).

Usage:
    python3 deliver_key.py <machine_id> [--name "Telegram Handle"] [--expiry YYYYMMDD]

Examples:
    python3 deliver_key.py a1b2c3d4 --name "@kaleb"
    python3 deliver_key.py a1b2c3d4 --name "Abebe" --expiry 20270101
    python3 deliver_key.py --search "@kaleb"     # see past key for that buyer
    python3 deliver_key.py --list                # show the whole ledger

Machine IDs are 8-char hex strings shown in the panel's License section.
Buyer already pays ETB 2,500 via Telebirr to 0907 628 809 before this runs.
"""
import argparse
import csv
import hmac
import hashlib
import os
import sys

# ── HMAC secret (same as in panel/js/main.js and keygen.py) ────────────────
SECRET = b"7JBrcWoJAXZYNDczdPjIn1Kyv2Wynqz1_d73_-fdC4g="
LEDGER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "customers.csv")
TELEBIRR = "0907 628 809"
PRICE = "ETB 2,500"


def generate_key(machine_id: str, expiry: str = "00000000") -> str:
    mid = machine_id.strip().lower()
    exp = expiry.strip()
    if len(mid) != 8 or not all(c in "0123456789abcdef" for c in mid):
        raise ValueError(f"Invalid machine ID: {mid!r} (need 8 hex chars)")
    if len(exp) != 8 or not exp.isdigit():
        raise ValueError(f"Invalid expiry: {exp!r} (need YYYYMMDD or 00000000)")
    msg = f"{mid}|{exp}".encode()
    sig = hmac.new(SECRET, msg, hashlib.sha256).hexdigest()[:16]
    raw = f"{mid}{exp}{sig}"
    parts = [raw[i:i + 4] for i in range(0, len(raw), 4)]
    return "AMH-" + "-".join(parts)


def read_ledger():
    rows = []
    if os.path.exists(LEDGER):
        with open(LEDGER, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    return rows


def search(rows, name):
    name = (name or "").strip().lstrip("@").lower()
    return [r for r in rows if name in r["name"].lower()]


def save(mid, name, expiry, key):
    rows = read_ledger()
    header = ["machine_id", "name", "expiry", "key", "status"]
    exists = [r for r in rows if r["machine_id"] == mid]
    if exists:
        print(f"(!) Machine ID {mid} already in ledger. Updating that row.", file=sys.stderr)
        rows = [r for r in rows if r["machine_id"] != mid]
    new = {"machine_id": mid, "name": name or "-", "expiry": expiry,
           "key": key, "status": "sold"}
    rows.append(new)
    with open(LEDGER, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=header)
        w.writeheader()
        w.writerows(rows)


def telegram_message(mid, name, key, expiry):
    lines = [
        f"✅ {name or 'የእርስዎ'} license key ተዘጋጅቷል!",
        "",
        f"<code>{key}</code>",
        "",
        "1. ይህን ኬይ ቅዳ (copy)",
        "2. Premiere Pro ውስጥ ፓነሉን ክፈት → License",
        "3. ኬዩን paste አድርግ → **Activate** ተጫን",
    ]
    if expiry != "00000000":
        lines.append("")
        lines.append(f"⏰ የሚቆይበት ጊዜ: እስከ {expiry}")
    lines += ["", "አመሰግናለሁ! 🙏 ችግር ካለ DM ይጻፉ።"]
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description="Deliver + log a license key")
    ap.add_argument("machine_id", nargs="?", help="8-char hex Machine ID from the panel")
    ap.add_argument("--name", default="", help="Telegram handle or buyer name")
    ap.add_argument("--expiry", default="00000000", help="YYYYMMDD or 00000000 (perpetual)")
    ap.add_argument("--search", nargs="?", const="", help="find a buyer by name/handle")
    ap.add_argument("--list", action="store_true", help="print the whole ledger")
    args = ap.parse_args()

    if args.list:
        rows = read_ledger()
        if not rows:
            print("No sales yet.")
            return
        for r in rows:
            print(f"{r['machine_id']}\t{r['name']}\t{r.get('expiry','00000000')}\t{r['key']}")
        return

    if args.search is not None:
        rows = search(read_ledger(), args.search)
        if not rows:
            print(f"No buyer found for @{args.search.lstrip('@')}.")
            return
        for r in rows:
            print(f"{r['machine_id']}\t{r['name']}\t{r.get('expiry','00000000')}\t{r['key']}")
        return

    if not args.machine_id:
        ap.print_help()
        return

    try:
        key = generate_key(args.machine_id, args.expiry)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    save(args.machine_id.strip().lower(), args.name, args.expiry, key)
    print("─" * 50)
    print(telegram_message(args.machine_id, args.name, key, args.expiry))
    print("─" * 50)
    print(f"\nLedger: {LEDGER}")
    print(f"Reminder: confirm the buyer paid {PRICE} via Telebirr to {TELEBIRR} before sending.")


if __name__ == "__main__":
    main()
