"""
amh_license.py — machine identity, signed-lease licensing and server trials
for the standalone SRT maker (amh_standalone.py).

This is a Python port of the panel's own logic (panel/js/main.js + core.js),
and it reads/writes the SAME files, so one license key and one trial counter
cover both the Premiere/After Effects panel and the standalone tool:

  ~/.amharic_captions_machine.json   {"id": <16 hex>, "host": <fp8>, "hv": 2}
  ~/.amharic_captions_license.json   {key, valid, expiry, activated,
                                      serverValidated, token}

(AMH_MACHINE_HOME relocates both, exactly as in the panel.)

A license is valid only if its lease token carries a valid ECDSA P-256
signature from the license server over "<mid>|<expiry>" for THIS machine ID.
The bundled Python has no crypto package, so verification is a small pure-
Python P-256 implementation below — verification only, public data only.

Unlike the panel, trials here are server-authoritative with NO offline
fallback: an unlicensed user needs a connection for each free transcription.
"""

import hashlib
import json
import os
import secrets
import sys
import time
import urllib.error
import urllib.request

API_URL = os.environ.get("AMH_API_URL", "https://amharic-captions-bot.amhcaps.workers.dev")
API_TIMEOUT = 15
TRIAL_ALLOWED = 2
HOST_FP_VERSION = 2
MACHINE_ID_LENGTH = 16

# Public half of the server's lease-signing key (same as core.js
# LICENSE_TOKEN_PUBKEY_PEM). Uncompressed point 04||X||Y of a P-256 SPKI.
LICENSE_TOKEN_PUBKEY_PEM = (
    "-----BEGIN PUBLIC KEY-----\n"
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEh4nYjxBierpwVmlfyDAGnpcqjZZl\n"
    "u61OCN5dwuvbSoP0mmQoptRb/7PM5UOi4GBY0Wmn0kKHQLZtEanqvq9nbQ==\n"
    "-----END PUBLIC KEY-----"
)

# ── ECDSA P-256 verification (pure Python) ──────────────────────────────────
_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A = _P - 3
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296,
      0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5)
_SPKI_P256_PREFIX = bytes.fromhex(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200")


def _on_curve(pt):
    x, y = pt
    return (y * y - (x * x * x + _A * x + _B)) % _P == 0


def _add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    (x1, y1), (x2, y2) = p1, p2
    if x1 == x2 and (y1 + y2) % _P == 0:
        return None
    if p1 == p2:
        lam = (3 * x1 * x1 + _A) * pow(2 * y1, -1, _P) % _P
    else:
        lam = (y2 - y1) * pow(x2 - x1, -1, _P) % _P
    x3 = (lam * lam - x1 - x2) % _P
    return (x3, (lam * (x1 - x3) - y1) % _P)


def _mul(k, pt):
    acc = None
    while k:
        if k & 1:
            acc = _add(acc, pt)
        pt = _add(pt, pt)
        k >>= 1
    return acc


def _pubkey_from_pem(pem):
    import base64
    body = "".join(l for l in pem.strip().splitlines() if "-----" not in l)
    der = base64.b64decode(body)
    if len(der) != 91 or not der.startswith(_SPKI_P256_PREFIX) or der[26] != 4:
        raise ValueError("not an uncompressed P-256 SPKI public key")
    q = (int.from_bytes(der[27:59], "big"), int.from_bytes(der[59:91], "big"))
    if not _on_curve(q):
        raise ValueError("public key is not on P-256")
    return q


def ecdsa_p256_verify(pubkey_pem, message, sig_raw):
    """Verify a raw 64-byte (r||s) ECDSA P-256/SHA-256 signature."""
    if len(sig_raw) != 64:
        return False
    q = _pubkey_from_pem(pubkey_pem)
    r = int.from_bytes(sig_raw[:32], "big")
    s = int.from_bytes(sig_raw[32:], "big")
    if not (1 <= r < _N and 1 <= s < _N):
        return False
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    w = pow(s, -1, _N)
    pt = _add(_mul(e * w % _N, _G), _mul(r * w % _N, q))
    return pt is not None and pt[0] % _N == r


# ── lease tokens (mirror of core.js licenseTokenParse/verifyLicenseToken) ───
def parse_token(token):
    if not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) != 3 or parts[0] != "v1":
        return None
    payload, sig = parts[1], parts[2]
    mid_len = 8 if len(payload) == 16 else (16 if len(payload) == 24 else 0)
    hexd = set("0123456789abcdef")
    if not mid_len or not set(payload) <= hexd or len(sig) != 128 or not set(sig) <= hexd:
        return None
    mid, exp = payload[:mid_len], payload[mid_len:mid_len + 8]
    return {"mid": mid, "exp": exp, "sig": bytes.fromhex(sig),
            "message": (mid + "|" + exp).encode()}


def verify_token(token, machine_id, pubkey_pem=LICENSE_TOKEN_PUBKEY_PEM):
    """Return (ok, expiry_or_error)."""
    tok = parse_token(token)
    if not tok:
        return False, "Malformed license token"
    if tok["mid"] != str(machine_id or "").lower():
        return False, "License token is for a different machine"
    if tok["exp"] != "00000000":
        exp = tok["exp"]
        # core.js: expired once now > midnight UTC of the expiry date.
        today = time.strftime("%Y%m%d", time.gmtime())
        if not exp.isdigit() or today >= exp:
            return False, "License expired on %s-%s-%s" % (exp[:4], exp[4:6], exp[6:])
    try:
        ok = ecdsa_p256_verify(pubkey_pem, tok["message"], tok["sig"])
    except Exception:
        return False, "License token verification failed"
    return (True, tok["exp"]) if ok else (False, "License token signature invalid")


# ── machine identity (mirror of main.js getOrCreateMachineId) ───────────────
def _home():
    return os.environ.get("AMH_MACHINE_HOME") or os.path.expanduser("~")


def _machine_path():
    return os.path.join(_home(), ".amharic_captions_machine.json")


def _license_path():
    return os.path.join(_home(), ".amharic_captions_license.json")


def host_fingerprint():
    """sha256(username|homedir|platform)[:8], identical to main.js
    hostFingerprint() (Node os.userInfo() + os.platform())."""
    if sys.platform == "win32":
        user = os.environ.get("USERNAME", "")
        home = os.environ.get("USERPROFILE", "") or os.path.expanduser("~")
    else:
        import pwd
        pw = pwd.getpwuid(os.getuid())
        user, home = pw.pw_name, pw.pw_dir
    raw = "|".join([user, home, sys.platform])
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:8]


def _valid_mid(v):
    return isinstance(v, str) and len(v) in (8, 16) and all(c in "0123456789abcdef" for c in v)


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            obj = json.load(f)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _atomic_write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = "%s.tmp-%d-%d" % (path, os.getpid(), int(time.time() * 1000))
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, separators=(",", ":"))
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
        return True
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False


def get_or_create_machine_id():
    path = _machine_path()
    for candidate in (path, path + ".bak"):
        rec = _read_json(candidate)
        if rec and _valid_mid(rec.get("id")):
            if candidate != path:
                _atomic_write_json(path, rec)   # recover from a torn primary
            return rec["id"]
    mid = secrets.token_hex(MACHINE_ID_LENGTH // 2)
    if not _atomic_write_json(path, {"id": mid, "host": host_fingerprint(), "hv": HOST_FP_VERSION}):
        raise OSError("cannot write machine record at " + path)
    return mid


# ── license state ───────────────────────────────────────────────────────────
def licensed(machine_id):
    """(True, expiry) when the stored lease verifies for this machine."""
    lic = _read_json(_license_path())
    if not lic or not lic.get("token"):
        return False, None
    return verify_token(lic["token"], machine_id)


def canonical_key(value):
    s = str(value or "").strip()
    if s[:3].lower() == "amh":
        s = s[3:]
    return "".join(c for c in s if c not in " \t-").lower()


def _api(method, path, body=None, timeout=API_TIMEOUT):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(API_URL + path, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": "AmharicCaptions-SRT"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return None
    except Exception:
        return None


# ── update-available notice ─────────────────────────────────────────────────
SITE_INSTALL_URL = "https://amharic-caption-pro.vercel.app/install/"


def _ver_tuple(v):
    return tuple(int(x) for x in str(v).split("."))


def installed_version(runtime_dir):
    """ExtensionBundleVersion from the extension's CSXS/manifest.xml."""
    import re
    try:
        with open(os.path.join(runtime_dir, "..", "CSXS", "manifest.xml"), "r", encoding="utf-8") as f:
            m = re.search(r'ExtensionBundleVersion="(\d+\.\d+\.\d+)"', f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def newer_release(current):
    """The newer published version (str) if there is one, else None. Quick
    (5 s) and silent when offline; the answer comes from our Worker's cache."""
    if not current:
        return None
    res = _api("GET", "/api/latest", timeout=5)
    v = str((res or {}).get("version") or "")
    try:
        return v if _ver_tuple(v) > _ver_tuple(current) else None
    except ValueError:
        return None


def activate(machine_id, key):
    """Validate a key with the server and store the signed lease exactly like
    the panel does. Returns (ok, message_en)."""
    ck = canonical_key(key)
    if len(ck) not in (32, 40) or not all(c in "0123456789abcdef" for c in ck):
        return False, "Invalid key format"
    if not ck.startswith(machine_id):
        return False, "Key is for a different machine"
    res = _api("POST", "/api/validate", {"mid": machine_id, "key": key.strip()})
    if res is None:
        return False, "Cannot verify license — no connection to the license server. Try again online."
    if res.get("valid") is not True:
        reason = res.get("reason")
        if reason == "expired":
            return False, "License expired"
        if reason == "revoked":
            return False, "License revoked — contact @sumpak6 on Telegram"
        if reason == "throttled":
            return False, "Too many attempts — wait one minute and try again."
        return False, "Key not recognized — contact @sumpak6 on Telegram"
    token = res.get("token")
    ok, info = verify_token(token, machine_id)
    if not ok:
        return False, "Server returned no valid lease token. Contact support."
    store = {"key": key.strip(), "valid": True, "expiry": res.get("expiry") or info,
             "activated": int(time.time() * 1000), "serverValidated": True, "token": token}
    if not _atomic_write_json(_license_path(), store):
        return False, "Could not save the signed lease to this installation. Check folder permissions and try again."
    return True, "Licensed"


# ── server-authoritative trial ──────────────────────────────────────────────
def trial_status(machine_id):
    """{'used','max','remaining'} or None when offline."""
    res = _api("GET", "/api/trial?mid=" + machine_id)
    if res and isinstance(res.get("used"), int):
        return res
    return None


def trial_charge(machine_id, run_id):
    """Charge one free transcription. Returns (charged, remaining|None)."""
    for attempt in range(2):
        res = _api("POST", "/api/trial/use", {"mid": machine_id, "run_id": run_id})
        if res and res.get("pending") and attempt == 0:
            time.sleep(1.0)
            continue
        if res and isinstance(res.get("used"), int) and not res.get("pending"):
            charged = res.get("charged")
            if charged is None:
                charged = res["used"] <= TRIAL_ALLOWED
            return bool(charged), res.get("remaining")
        return False, None
    return False, None


def new_run_id():
    return "srt-" + secrets.token_hex(12)
