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
  return { start: cue.start, end: cue.end, text: cue.text.replace(m[0], ''), speaker: m[1] || m[2] };
}

function normalizeCues(cues) {
  return (cues || []).map(detectSpeaker);
}

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
    const text = cleanCueLines(cue.text);
    out += (cue.speaker ? '<v ' + cue.speaker + '>' + text + '</v>' : text) + '\n\n';
  }
  return out;
}

// Plain-text transcript: one line per cue, "S1: text" when labelled.
function txtTextFromCues(cues) {
  const sortable = (cues || []).slice().sort((a, b) => a.start - b.start);
  return sortable.map((c) => {
    const text = cleanCueLines(c.text);
    if (!text) return '';
    return (c.speaker ? c.speaker + ': ' : '') + text;
  }).filter(Boolean).join('\n');
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
  if (!/^[0-9a-f]{32}$/.test(clean)) return { ok: false, error: 'Invalid key format' };

  const mid  = clean.substring(0, 8);
  const exp  = clean.substring(8, 16);
  const sig  = clean.substring(16, 32);

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

// Node (tests) — no-op in the CEP browser where `module` is undefined.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseSrt, formatSrtTs, cleanCueLines, AMH_PUNCT_CHARS,
    detectSpeaker, normalizeCues,
    speakerPrefix, srtTextFromCues, vttTextFromCues, txtTextFromCues,
    validateLicense,
  };
}
