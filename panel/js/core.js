/*
 * Amharic Captions — pure core helpers.
 *
 * Loaded as a classic <script> BEFORE main.js (so main.js can use these as
 * globals) and also requireable from Node for unit tests:
 *
 *   const core = require('./panel/js/core.js');
 *
 * Keep this file free of DOM / CEP / Node-fs dependencies so it stays testable.
 */
'use strict';

// ─────────────────────────────────────────────────────────────── SRT parsing
function parseSrt(text) {
  const cues = [];
  const blocks = String(text || '').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').map((l) => l.trim()).filter((l) => l.length);
    if (lines.length < 3) continue;
    const timeMatch = lines[1].match(/([\d:,.]+)\s*-->\s*([\d:,.]+)/);
    if (!timeMatch) continue;
    const toSec = (s) => {
      const p = s.trim().replace(',', '.').split(':');
      let sec = 0;
      for (const part of p) sec = sec * 60 + parseFloat(part);
      return sec;
    };
    const start = toSec(timeMatch[1]);
    const end = toSec(timeMatch[2]);
    const text = lines.slice(2).join('\n');
    if (text && start >= 0) cues.push({ start, end, text });
  }
  return cues;
}

function formatSrtTs(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  const p = (n, w) => String(n).padStart(w, '0');
  return p(h, 2) + ':' + p(m, 2) + ':' + p(s, 2) + ',' + p(ms, 3);
}

// ──────────────────────────────────────────────────────── transcript cleanup
// Smart spacing/punctuation cleanup for caption lines. Runs per line so intended
// line breaks survive. Only normalizes whitespace, tightens spaces before
// punctuation, and adds one space after it (never between digits, so numbers
// like "1.5" and "1,000" are preserved). Ethiopic punctuation (። ፣ ፤ ፥ ፦) is
// treated the same as Latin punctuation.
const AMH_PUNCT_CHARS = '.,;:!?\u2026\u060c\u1362\u1363\u1364\u1365\u1366';
function cleanCueLines(text) {
  if (!text) return '';
  return String(text).split('\n').map((ln) => {
    return ln
      .replace(/[\u200b\u200c\u200d]/g, '')                       // zero-width
      .replace(/\s+/g, ' ')                                        // collapse spaces
      .replace(new RegExp('\\s+([' + AMH_PUNCT_CHARS + '])', 'g'), '$1')   // no space before punct
      // one space after punct (but not before digits, spaces or more punct)
      .replace(new RegExp('([' + AMH_PUNCT_CHARS + '])(?![\\s\\d])', 'g'), '$1 ')
      .trim();
  }).join('\n');
}

// ───────────────────────────────────────────────────────── cue serialization
// Optional 2-speaker diarization labels: cues may carry a `speaker` field
// ("S1"/"S2"). SRT/TXT use a "[S1] " prefix; VTT uses the <v> voice tag.
function speakerPrefix(cue) {
  return cue && cue.speaker ? '[' + cue.speaker + '] ' : '';
}

// Pull a leading "[S1] " (engine SRT/TXT label) or "S1: " out of cue.text and
// into cue.speaker, so exporters can emit the right tag per format. Idempotent.
function detectSpeaker(cue) {
  if (!cue || cue.speaker) return cue;
  const m = String(cue.text || '').match(/^\s*(?:\[(S\d+)\]|(S\d+):)\s*/);
  if (!m) return cue;
  // Preserve any other fields the cue already carries (e.g. `conf`) — only
  // text/speaker actually change here.
  return Object.assign({}, cue, { text: cue.text.replace(m[0], ''), speaker: m[1] || m[2] });
}

function normalizeCues(cues) {
  return (cues || []).map(detectSpeaker);
}

// Internal SRT (engine output, caches): keeps the "[S1] " labels so speaker
// information survives a round trip. NOT what viewers see — see
// displaySrtTextFromCues.
function srtTextFromCues(cues) {
  const sortable = (cues || []).slice().sort((a, b) => a.start - b.start);
  let out = '';
  let idx = 0;
  for (const cue of sortable) {
    idx += 1;
    out += idx + '\n';
    out += formatSrtTs(cue.start) + ' --> ' + formatSrtTs(cue.end) + '\n';
    out += speakerPrefix(cue) + cleanCueLines(cue.text) + '\n\n';
  }
  return out;
}

// What viewers see (Premiere captions, the saved .srt): the subtitle
// convention — a "– " dash where the speaker CHANGES, nothing otherwise.
// "[S1]" on screen meant nothing to a viewer and every editor deleted it.
function displaySrtTextFromCues(cues) {
  const sortable = (cues || []).slice().sort((a, b) => a.start - b.start);
  let out = '';
  let idx = 0;
  let prev = null;
  for (const cue of sortable) {
    idx += 1;
    const changed = !!(cue.speaker && prev && cue.speaker !== prev);
    if (cue.speaker) prev = cue.speaker;
    out += idx + '\n';
    out += formatSrtTs(cue.start) + ' --> ' + formatSrtTs(cue.end) + '\n';
    out += (changed ? '– ' : '') + cleanCueLines(cue.text) + '\n\n';
  }
  return out;
}

function vttEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function vttTextFromCues(cues) {
  const ts = (sec) => {
    sec = Math.max(0, sec);
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.floor((sec - Math.floor(sec)) * 1000)).padStart(3, '0');
    return h + ':' + m + ':' + s + '.' + ms;
  };
  const sortable = (cues || []).slice().sort((a, b) => a.start - b.start);
  let out = 'WEBVTT\n\n';
  for (const cue of sortable) {
    out += ts(cue.start) + ' --> ' + ts(cue.end) + '\n';
    const text = vttEscape(cleanCueLines(cue.text));
    const voice = cue.speaker ? String(cue.speaker).replace(/[^A-Za-z0-9_-]/g, '') : '';
    out += (voice ? '<v ' + voice + '>' + text + '</v>' : text) + '\n\n';
  }
  return out;
}

// Plain-text transcript: one line per cue, "Speaker 1: text" when labelled —
// a transcript is read, so the speaker is spelled out.
function txtTextFromCues(cues) {
  const sortable = (cues || []).slice().sort((a, b) => a.start - b.start);
  return sortable.map((c) => {
    const text = cleanCueLines(c.text);
    if (!text) return '';
    const n = c.speaker ? String(c.speaker).replace(/^S/, '') : '';
    return (n ? 'Speaker ' + n + ': ' : '') + text;
  }).filter(Boolean).join('\n');
}

// What the "Label speakers" option found, for the message after a run:
// 'two' (labels added), 'one' (a single voice — nothing added), 'off'.
function speakerSummary(cues, enabled) {
  if (!enabled) return 'off';
  const set = new Set((cues || []).map((c) => c && c.speaker).filter(Boolean));
  return set.size >= 2 ? 'two' : 'one';
}

// ────────────────────────────────────────────────────────── license check
// Local pre-flight for a license key. This is STRICTLY structural (shape,
// machine-id match, expiry range) — deliberately NOT a keyed HMAC check.
//
// WHY no HMAC here: the key's signature is HMAC-SHA256 over "mid|exp", and the
// verifying secret is the same secret used to MINT keys (tools/keygen.py,
// tools/telegram-worker worker.js). That minting secret must never be shipped
// in a bundle distributed to every buyer, or anyone could extract it and forge
// keys that pass BOTH the server and the client. The server is the authority:
//   - /api/validate re-derives the HMAC and only accepts authentic signatures
//     that also have a matching D1 customer row (see worker.js).
//   - first activation requires the server (fail-closed, see activateLicense());
//     offline re-activation is allowed only for keys previously confirmed
//     server-side and cached.
// So this function's only job is fast local rejection of obviously-wrong keys
// (typos, wrong case/length, a key pasted for a different machine).
function validateLicense(key, machineId) {
  // Tolerate how users paste keys: any-case "AMH" prefix, grouping dashes,
  // surrounding whitespace, and no separators at all.
  const clean = String(key || '').trim()
    .replace(/^amh/i, '')
    .replace(/[\s-]+/g, '')
    .toLowerCase();
  const midLength = clean.length === 32 ? 8 : (clean.length === 40 ? 16 : 0);
  if (!midLength || !/^[0-9a-f]+$/.test(clean)) return { ok: false, error: 'Invalid key format' };

  const mid  = clean.substring(0, midLength);
  const exp  = clean.substring(midLength, midLength + 8);
  const sig  = clean.substring(midLength + 8, midLength + 24);

  if (mid !== String(machineId || '').toLowerCase()) return { ok: false, error: 'Key is for a different machine' };

  // Check expiry
  if (exp !== '00000000') {
    const expDate = new Date(exp.substring(0,4) + '-' + exp.substring(4,6) + '-' + exp.substring(6,8));
    if (isNaN(expDate.getTime()) || Date.now() > expDate.getTime()) {
      return { ok: false, error: 'License expired on ' + exp.substring(0,4) + '-' + exp.substring(4,6) + '-' + exp.substring(6,8) };
    }
  }

  // Format/date valid. Acceptance still requires the server to confirm the key
  // (or a previously server-validated cached license) — see activateLicense().
  return { ok: true, expiry: exp };
}

// ─────────────────────────────────────────────── leased-license token check
// Server-signed install lease, verified locally with an embedded PUBLIC key.
//
// The old model ("valid:true" in localStorage, no local auth — see audit) let
// anyone unlock the panel by editing storage, once the client logic was public.
// The fix is asymmetric: the license server signs an install lease with an
// ECDSA P-256 key whose PRIVATE half lives only in the Worker (env secret
// AMH_LICENSE_SIGNING_KEY); the panel ships only the PUBLIC half below and
// rejects any stored license whose signature doesn't verify. Offline still
// works — a lease is signed once (at activation/about-to-expire) and then
// honored locally until its expiry — but a forged localStorage object has no
// valid signature and is refused.
//
// Token format (v1): "v1." + hex(mid|exp8) + "." + hex(64-byte raw ECDSA
// signature over the ASCII string "mid|exp"). New mid values are 16 hex
// characters; the parser also accepts legacy 8-hex IDs.

const LICENSE_TOKEN_PUBKEY_PEM =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEh4nYjxBierpwVmlfyDAGnpcqjZZl\n' +
  'u61OCN5dwuvbSoP0mmQoptRb/7PM5UOi4GBY0Wmn0kKHQLZtEanqvq9nbQ==\n' +
  '-----END PUBLIC KEY-----';

function licenseTokenParse(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;
  const payloadHex = parts[1];
  const sigHex = parts[2];
  const midLength = payloadHex.length === 16 ? 8 : (payloadHex.length === 24 ? 16 : 0);
  if (!midLength || !/^[0-9a-f]+$/.test(payloadHex) || !/^[0-9a-f]{128}$/.test(sigHex)) return null;
  return {
    mid: payloadHex.slice(0, midLength),
    exp: payloadHex.slice(midLength, midLength + 8),
    sigHex: sigHex,
    message: payloadHex.slice(0, midLength) + '|' + payloadHex.slice(midLength, midLength + 8),
  };
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

function pemToBytes(pem) {
  const b64 = String(pem || '')
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Verify a stored lease token locally against mid + expiry. pubKeyPem is the
// server's public key (defaults to the embedded constant; tests may pass their
// own keypair). Async: uses WebCrypto (available in the CEP Chromium, modern
// browsers, and Node ≥ 20).
async function verifyLicenseToken(token, pubKeyPem, machineId) {
  try {
    const tok = licenseTokenParse(token);
    if (!tok) return { ok: false, error: 'Malformed license token' };
    if (tok.mid !== String(machineId || '').toLowerCase()) {
      return { ok: false, error: 'License token is for a different machine' };
    }
    if (tok.exp !== '00000000') {
      const expDate = new Date(tok.exp.slice(0, 4) + '-' + tok.exp.slice(4, 6) + '-' + tok.exp.slice(6, 8));
      if (isNaN(expDate.getTime()) || Date.now() > expDate.getTime()) {
        return { ok: false, error: 'License expired on ' + tok.exp.slice(0, 4) + '-' + tok.exp.slice(4, 6) + '-' + tok.exp.slice(6, 8) };
      }
    }
    const subtle = globalThis.crypto && globalThis.crypto.subtle ? globalThis.crypto.subtle : null;
    if (!subtle) return { ok: false, error: 'No WebCrypto available' };
    const key = await subtle.importKey(
      'spki', pemToBytes(pubKeyPem),
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const sig = hexToBytes(tok.sigHex);
    const data = new TextEncoder().encode(tok.message);
    const valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, data);
    return valid
      ? { ok: true, mid: tok.mid, expiry: tok.exp }
      : { ok: false, error: 'License token signature invalid' };
  } catch (e) {
    return { ok: false, error: 'License token verification failed' };
  }
}

// Inside After Effects every host call is wrapped so the After Effects
// implementations are the active ones at the moment of the call: load
// host.jsx if nothing is loaded yet, then (re)load host_ae.jsx whenever its
// stamp is missing (host.jsx loaded later replaces the same function names).
function aeHostCall(call, hostJsx, aeJsx) {
  const H = JSON.stringify(String(hostJsx));
  const A = JSON.stringify(String(aeJsx));
  return '(function(){' +
    'try{if(typeof amhGuard==="undefined"){$.evalFile(new File(' + H + '));}}catch(e){}' +
    'try{if(typeof amharic_getSelectedClip==="undefined"||amharic_getSelectedClip.amhAE!==true){' +
    '$.evalFile(new File(' + A + '));}}catch(e){}' +
    'return ' + call + ';})()';
}

// ─────────────────────────────────────────── find & replace / auto-correct
// Whole-word (or whole-phrase) replacement: "ሰላም" never matches inside
// "ሰላምታ". Word edges are the text ends, whitespace and punctuation.
const WORD_EDGE = '[\\s' + AMH_PUNCT_CHARS.replace(/[\]\\^-]/g, '\\$&') + '"\'«»“”()\\[\\]]';
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function replaceWords(text, find, repl) {
  const f = String(find || '').trim().replace(/\s+/g, ' ');
  if (!f) return { text: String(text || ''), n: 0 };
  const re = new RegExp('(^|' + WORD_EDGE + ')' + escRe(f).replace(/ /g, '\\s+') + '(?=$|' + WORD_EDGE + ')', 'g');
  let n = 0;
  const out = String(text || '').replace(re, (m, pre) => { n++; return pre + String(repl || ''); });
  return { text: out, n };
}

const STRIP_PUNCT_RE = new RegExp('^[' + AMH_PUNCT_CHARS.replace(/[\]\\^-]/g, '\\$&') + ']+|[' +
  AMH_PUNCT_CHARS.replace(/[\]\\^-]/g, '\\$&') + ']+$', 'g');
const bareWord = (w) => String(w || '').replace(STRIP_PUNCT_RE, '');

// Word fixes an editor made: for each caption still carrying the id it had
// when the review opened, and still the same number of words, every word
// that changed (ignoring punctuation) is a [wrong, right] pair. Captions that
// were split / merged / rewritten teach nothing — too ambiguous to learn from.
function learnFixes(beforeCues, afterCues) {
  const before = {};
  (beforeCues || []).forEach((c) => { if (c && c._id != null) before[c._id] = String(c.text || ''); });
  const pairs = [];
  (afterCues || []).forEach((c) => {
    if (!c || c._id == null || !(c._id in before)) return;
    const a = before[c._id].split(/\s+/).filter(Boolean);
    const b = String(c.text || '').split(/\s+/).filter(Boolean);
    if (!a.length || a.length !== b.length) return;
    for (let i = 0; i < a.length; i++) {
      const w = bareWord(a[i]);
      const r = bareWord(b[i]);
      if (!w || !r || w === r) continue;
      if (!/[ሀ-᎟]/.test(w) || !/[ሀ-᎟]/.test(r)) continue;   // Amharic words only
      if (w.length < 2) continue;
      pairs.push([w, r]);
    }
  });
  return pairs;
}

// Apply remembered fixes (wrong -> right) to one caption. Returns the new
// text and what was changed (for the "auto-fixed" note and Undo).
// Split a caption's text at `pos` (the cursor), moved to the nearest space so
// a word is never cut in half. No usable position -> the middle word. Returns
// [first, second] (both non-empty, trimmed) or null for a one-word caption.
function splitTextAt(text, pos) {
  const t = String(text || '').trim();
  const spaces = [];
  for (let k = 0; k < t.length; k++) if (/\s/.test(t[k]) && !/\s/.test(t[k - 1] || '')) spaces.push(k);
  if (!spaces.length) return null;
  let cut;
  if (typeof pos === 'number' && pos > 0 && pos < t.length) {
    cut = spaces.reduce((best, k) => (Math.abs(k - pos) < Math.abs(best - pos) ? k : best), spaces[0]);
  } else {
    cut = spaces[Math.floor((spaces.length - 1) / 2)];
  }
  const first = t.slice(0, cut).trim();
  const second = t.slice(cut).trim();
  return first && second ? [first, second] : null;
}

// Where the model's unsure words sit in a caption: [{start, end}], whole
// words only, left to right, never overlapping — for the review highlight.
function doubtRanges(text, words) {
  const t = String(text || '');
  const all = [];
  (words || []).forEach((w) => {
    w = String(w || '').trim();
    if (!w) return;
    const re = new RegExp('(^|' + WORD_EDGE + ')(' + escRe(w) + ')(?=$|' + WORD_EDGE + ')', 'g');
    let m;
    while ((m = re.exec(t))) {
      const s = m.index + m[1].length;
      all.push({ start: s, end: s + m[2].length });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  });
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  all.forEach((r) => { if (!out.length || r.start >= out[out.length - 1].end) out.push(r); });
  return out;
}

function applyFixes(text, fixes) {
  let t = String(text || '');
  const applied = [];
  Object.keys(fixes || {}).forEach((wrong) => {
    const r = replaceWords(t, wrong, fixes[wrong]);
    if (r.n) { t = r.text; applied.push({ from: wrong, to: fixes[wrong], n: r.n }); }
  });
  return { text: t, applied };
}

// Node (tests) — no-op in the CEP browser where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSrt, formatSrtTs, cleanCueLines, AMH_PUNCT_CHARS,
    detectSpeaker, normalizeCues,
    speakerPrefix, srtTextFromCues, displaySrtTextFromCues, vttTextFromCues, txtTextFromCues,
    speakerSummary, aeHostCall, replaceWords, learnFixes, applyFixes, doubtRanges, splitTextAt,
    validateLicense,
    LICENSE_TOKEN_PUBKEY_PEM, licenseTokenParse, verifyLicenseToken,
  };
}
