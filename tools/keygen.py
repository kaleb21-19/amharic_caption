#!/usr/bin/env python3
"""Generate Amharic Captions license keys.

Usage:
    python3 keygen.py <machine_id> [expiry_YYYYMMDD]

Examples:
    python3 keygen.py a1b2c3d4                # perpetual license
    python3 keygen.py a1b2c3d4 20270101        # expires 2027-01-01

Machine IDs are 8-char hex strings shown in the panel's License section.
"""
import hmac
import hashlib
import sys

# ── HMAC secret (same as in panel/js/main.js) ──────────────────────────────
SECRET = b"7JBrcWoJAXZYNDczdPjIn1Kyv2Wynqz1_d73_-fdC4g="

def generate_key(machine_id: str, expiry: str = "00000000") -> str:
    """Return an AMH-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX license key."""
    mid = machine_id.strip().lower()
    exp = expiry.strip()
    if len(mid) != 8 or not all(c in "0123456789abcdef" for c in mid):
        raise ValueError(f"Invalid machine ID: {mid!r} (need 8 hex chars)")
    if len(exp) != 8 or not exp.isdigit():
        raise ValueError(f"Invalid expiry: {exp!r} (need YYYYMMDD or 00000000)")

    msg = f"{mid}|{exp}".encode()
    sig = hmac.new(SECRET, msg, hashlib.sha256).hexdigest()[:16]

    raw = f"{mid}{exp}{sig}"
    # Format as AMH-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX (32 chars total)
    parts = [raw[i:i+4] for i in range(0, len(raw), 4)]
    return "AMH-" + "-".join(parts)


def main():
    if len(sys.argv) < 2:
        print(__doc__.strip())
        sys.exit(1)

    mid = sys.argv[1]
    exp = sys.argv[2] if len(sys.argv) > 2 else "00000000"

    try:
        key = generate_key(mid, exp)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"Machine ID : {mid}")
    print(f"Expiry     : {'perpetual' if exp == '00000000' else exp}")
    print(f"License key: {key}")
    print()
    print("Send this key to the buyer. They paste it into the panel's License section.")
    print("Buyer pays ETB 2,000 via Telebirr to 0907 628 809 to unlock.")


if __name__ == "__main__":
    main()
