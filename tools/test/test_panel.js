#!/usr/bin/env node
/*
 * test_panel.js — unit tests for the panel's pure core helpers
 * (panel/js/core.js): SRT parsing/formatting, transcript cleanup, cue
 * serialization (SRT/VTT/TXT + speaker labels), and validateLicense paths.
 *
 * Run:  node tools/test/test_panel.js
 * No dependencies (Node's assert only). Exits non-zero on any failure.
 */
'use strict';

const assert = require('assert');
const core = require('../../panel/js/core.js');

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  [OK] ' + name); }
  catch (e) { fail++; console.log('  [FAIL] ' + name + '\n        ' + (e && e.message)); }
}

// ────────────────────────────────────────────────────────────── parseSrt
t('parseSrt: two well-formed cues', () => {
  const srt = [
    '1',
    '00:00:01,000 --> 00:00:02,500',
    'ሰላም ዓለም',
    '',
    '2',
    '00:00:03,000 --> 00:00:04,000',
    'ሁለተኛ',
    '',
  ].join('\n');
  const cues = core.parseSrt(srt);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 1);
  assert.strictEqual(cues[0].end, 2.5);
  assert.strictEqual(cues[0].text, 'ሰላም ዓለም');
  assert.strictEqual(cues[1].start, 3);
});

t('parseSrt: hours fold in', () => {
  const cues = core.parseSrt('1\n01:02:03,004 --> 01:02:04,000\nx\n\n');
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].start, 3723.004);
});

t('parseSrt: dot decimals accepted', () => {
  const cues = core.parseSrt('1\n00:00:01.250 --> 00:00:02.750\nhi\n\n');
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].start, 1.25);
});

t('parseSrt: malformed / index-less / no-text blocks are skipped', () => {
  const srt = [
    'not-a-time --> nope', 'body',            // no valid time line
    '', '00:00:01,000 --> 00:00:02,000', 'x', // missing index → only 2 lines
    '', '3', '00:00:05,000 --> 00:00:06,000', // no text line
    '',
  ].join('\n');
  assert.strictEqual(core.parseSrt(srt).length, 0);
});

t('parseSrt: round-trips through srtTextFromCues (times/text)', () => {
  const cues = [
    { start: 0.5, end: 2.25, text: 'ሰላም' },
    { start: 3, end: 4, text: 'ዓለም' },
  ];
  const back = core.parseSrt(core.srtTextFromCues(cues));
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].start, 0.5);
  assert.strictEqual(back[0].end, 2.25);
  assert.strictEqual(back[0].text, 'ሰላም');
  assert.strictEqual(back[1].text, 'ዓለም');
});

// ─────────────────────────────────────────────────────────── formatSrtTs
t('formatSrtTs: pads to hh:mm:ss,mmm and clamps negatives', () => {
  assert.strictEqual(core.formatSrtTs(3661.5), '01:01:01,500');
  assert.strictEqual(core.formatSrtTs(0), '00:00:00,000');
  assert.strictEqual(core.formatSrtTs(-4), '00:00:00,000');
});

// ────────────────────────────────────────────────────────── cleanCueLines
t('cleanCueLines: collapses spaces, tightens then spaces punctuation', () => {
  assert.strictEqual(core.cleanCueLines('ሰላም   ዓለም'), 'ሰላም ዓለም');
  assert.strictEqual(core.cleanCueLines('ነው .'), 'ነው.');
  assert.strictEqual(core.cleanCueLines('ነው.አዎ'), 'ነው. አዎ');
});

t('cleanCueLines: keeps decimals / thousands intact', () => {
  assert.strictEqual(core.cleanCueLines('1.5'), '1.5');
  assert.strictEqual(core.cleanCueLines('1,000'), '1,000');
});

t('cleanCueLines: strips zero-width chars, keeps line breaks', () => {
  assert.strictEqual(core.cleanCueLines('a\u200bb\nc'), 'ab\nc');
});

// ────────────────────────────────────────────────── cue serialization
const labelled = [
  { start: 1, end: 2, text: 'ሰላም', speaker: 'S1' },
  { start: 3, end: 4, text: 'ዓለም', speaker: 'S2' },
];

t('srtTextFromCues: numbered, ordered, [Sx] prefix', () => {
  const out = core.srtTextFromCues(labelled.slice().reverse()); // order-independent
  const srtCues = core.parseSrt(out);
  assert.strictEqual(srtCues.length, 2);
  assert.ok(out.indexOf('[S1] ሰላም') >= 0, 'missing S1 label');
  assert.ok(out.indexOf('[S2] ዓለም') >= 0, 'missing S2 label');
  assert.ok(/^1\n00:00:01,000/.test(out), 'first cue numbering/time wrong');
});

t('vttTextFromCues: WEBVTT header + <v> voice tags + dot times', () => {
  const out = core.vttTextFromCues(labelled);
  assert.ok(out.startsWith('WEBVTT\n\n'));
  assert.ok(out.indexOf('00:00:01.000 --> 00:00:02.000') >= 0);
  assert.ok(out.indexOf('<v S1>ሰላም</v>') >= 0);
});

t('txtTextFromCues: "Sx: text" lines, skips empties', () => {
  const out = core.txtTextFromCues([
    { start: 2, end: 3, text: 'b', speaker: 'S2' },
    { start: 0, end: 1, text: 'a', speaker: 'S1' },
    { start: 5, end: 6, text: '   ' },
  ]);
  assert.strictEqual(out, 'S1: a\nS2: b');
});

t('vttTextFromCues: escapes caption markup', () => {
  const text = core.vttTextFromCues([{ start: 0, end: 1, text: '<script>&' }]);
  assert.ok(text.includes('&lt;script&gt;&amp;'));
  assert.ok(!text.includes('<script>'));
});

t('unlabelled cues have no speaker decoration', () => {
  const c = [{ start: 0, end: 1, text: 'x' }];
  assert.strictEqual(core.txtTextFromCues(c), 'x');
  assert.strictEqual(core.speakerPrefix(c[0]), '');
});

// ───────────────────────────────────────────────── cue speaker detection
t('detectSpeaker: lifts "[S1] " prefix from engine SRT text', () => {
  const c = core.detectSpeaker({ start: 0, end: 1, text: '[S1] ሰላም' });
  assert.strictEqual(c.speaker, 'S1');
  assert.strictEqual(c.text, 'ሰላም');
  assert.strictEqual(c.start, 0);
  assert.strictEqual(c.end, 1);
});

t('detectSpeaker: supports "S2: " form and is idempotent', () => {
  const a = core.detectSpeaker({ start: 0, end: 1, text: 'S2: ዓለም' });
  assert.strictEqual(a.speaker, 'S2');
  assert.strictEqual(a.text, 'ዓለም');
  assert.strictEqual(core.detectSpeaker(a), a); // already tagged → as-is
});

t('normalizeCues: engine-labelled SRT exports correct per-format tags', () => {
  const cues = core.normalizeCues(core.parseSrt(
    '1\n00:00:01,000 --> 00:00:02,000\n[S1] ሰላም\n\n' +
    '2\n00:00:03,000 --> 00:00:04,000\n[S2] ዓለም\n\n'));
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].speaker, 'S1');
  assert.ok(core.vttTextFromCues(cues).indexOf('<v S1>ሰላም</v>') >= 0);
  assert.strictEqual(core.txtTextFromCues(cues), 'S1: ሰላም\nS2: ዓለም');
});

// ────────────────────────────────────────────────────────── validateLicense
// Key layout (after stripping AMH-/dashes): legacy mid(8) or new mid(16),
// followed by expiry(8) and signature(16).
const MID = 'a1b2c3d4';
const SIG = '0123456789abcdef';
const mk = (mid, exp, sig) =>
  'AMH-' + (mid + exp + sig).match(/.{4}/g).join('-');
const openKey = mk(MID, '00000000', SIG);

t('validateLicense: valid perpetual key for this machine', () => {
  const r = core.validateLicense(openKey, MID);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expiry, '00000000');
});

t('validateLicense: 16-hex installation IDs use the extended key layout', () => {
  const mid16 = 'a1b2c3d4e5f60718';
  const key16 = mk(mid16, '00000000', SIG);
  assert.strictEqual(core.validateLicense(key16, mid16).ok, true);
  assert.strictEqual(core.validateLicense(key16, MID).ok, false);
});

t('validateLicense: tolerated paste formats (case / dashless / spaces)', () => {
  assert.strictEqual(core.validateLicense(openKey.toUpperCase(), MID).ok, true);
  assert.strictEqual(core.validateLicense(openKey.toLowerCase(), MID).ok, true);
  assert.strictEqual(core.validateLicense(openKey.replace(/-/g, ''), MID).ok, true);
  assert.strictEqual(core.validateLicense('  ' + openKey + '  ', MID).ok, true);
});

t('validateLicense: foreign machine rejected', () => {
  const r = core.validateLicense(openKey, 'ffffffff');
  assert.strictEqual(r.ok, false);
  assert.ok(/different machine/i.test(r.error));
});

t('validateLicense: expired key rejected with date', () => {
  const r = core.validateLicense(mk(MID, '20200101', SIG), MID);
  assert.strictEqual(r.ok, false);
  assert.ok(/expired on 2020-01-01/.test(r.error), r.error);
});

t('validateLicense: future expiry accepted', () => {
  const r = core.validateLicense(mk(MID, '29991231', SIG), MID);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.expiry, '29991231');
});

t('validateLicense: malformed / short / non-hex rejected', () => {
  assert.strictEqual(core.validateLicense('', MID).ok, false);
  assert.strictEqual(core.validateLicense('AMH-1234', MID).ok, false);
  assert.strictEqual(core.validateLicense(mk(MID, '00000000', 'zzzzzzzzzzzzzzzz'), MID).ok, false);
  assert.strictEqual(core.validateLicense(null, MID).error, 'Invalid key format');
});

t('validateLicense: tampered *signature* still passes LOCALLY (server is authority)', () => {
  // The local check is structural only — a wrong-but-well-formed signature must
  // reach the server, which decides acceptance. This documents that design.
  const r = core.validateLicense(mk(MID, '00000000', 'ffffffffffffffff'), MID);
  assert.strictEqual(r.ok, true);
});

t('validateLicense: tampered machine-id section is caught locally', () => {
  const r = core.validateLicense(mk('deadbeef', '00000000', SIG), MID);
  assert.strictEqual(r.ok, false);
  assert.ok(/different machine/i.test(r.error));
});

// ─────────────────────────────── license token (signed lease) verify
// Round-trips a server-signed install lease through the panel's LOCAL verifier
// (panel/js/core.js verifyLicenseToken). Uses a throwaway P-256 keypair so the
// tests never touch the real signing key — and one test proves tokens signed by
// the throwaway key FAIL against the real embedded public key.
let pending = [];
function tAsync(name, fn) {
  pending.push(
    Promise.resolve().then(fn).then(
      () => { pass++; console.log('  [OK] ' + name); },
      (e) => { fail++; console.log('  [FAIL] ' + name + '\n        ' + (e && e.message)); }
    )
  );
}

// Cache the keypair as a PROMISE so concurrent tAsync tests that call
// tokenKey()/signToken() always share ONE key. (The old lazy `_kp` cache had a
// race: two concurrent generateKey() calls could hand one test a public key
// from key A while its token was signed with key B — flaky "signature
// invalid" failures on valid tokens. That was a test-harness bug only; the
// panel itself verifies single-shot with one key.)
let _tokKey = null; // Promise<{ kp, pem }>
function tokenKey() {
  if (!_tokKey) {
    _tokKey = (async () => {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
      const b64 = Buffer.from(spki).toString('base64');
      const pem = '-----BEGIN PUBLIC KEY-----\n' + b64.match(/.{1,64}/g).join('\n') + '\n-----END PUBLIC KEY-----';
      return { kp, pem };
    })();
  }
  return _tokKey;
}
async function signToken(mid, exp) {
  const { kp } = await tokenKey();
  const msg = new TextEncoder().encode(mid + '|' + exp);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, msg));
  const sigHex = [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
  return 'v1.' + String(mid).toLowerCase() + String(exp) + '.' + sigHex;
}

tAsync('license token: server-signed lease verifies locally (perpetual)', async () => {
  const { pem } = await tokenKey();
  const v = await core.verifyLicenseToken(await signToken(MID, '00000000'), pem, MID);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.expiry, '00000000');
});

tAsync('license token: 16-hex installation lease verifies', async () => {
  const { pem } = await tokenKey();
  const mid16 = 'a1b2c3d4e5f60718';
  const v = await core.verifyLicenseToken(await signToken(mid16, '00000000'), pem, mid16);
  assert.strictEqual(v.ok, true);
});

tAsync('license token: exped-limited lease verifies until expiry', async () => {
  const { pem } = await tokenKey();
  const exp = '29991231';
  const v = await core.verifyLicenseToken(await signToken(MID, exp), pem, MID);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.expiry, exp);
});

tAsync('license token: expired lease rejected with date', async () => {
  const { pem } = await tokenKey();
  const v = await core.verifyLicenseToken(await signToken(MID, '20200101'), pem, MID);
  assert.strictEqual(v.ok, false);
  assert.ok(/expired on 2020-01-01/.test(v.error), v.error);
});

tAsync('license token: different machine rejected', async () => {
  const { pem } = await tokenKey();
  const v = await core.verifyLicenseToken(await signToken('ffffffff', '00000000'), pem, MID);
  assert.strictEqual(v.ok, false);
  assert.ok(/different machine/i.test(v.error), v.error);
});

tAsync('license token: tampered signature rejected', async () => {
  const { pem } = await tokenKey();
  const token = await signToken(MID, '00000000');
  const flip = token.slice(0, token.length - 1) + (token.endsWith('0') ? '1' : '0');
  const v = await core.verifyLicenseToken(flip, pem, MID);
  assert.strictEqual(v.ok, false);
  assert.ok(/signature invalid/i.test(v.error), v.error);
});

tAsync('license token: wrong public key rejected (bind to embedded key)', async () => {
  // A lease signed by the throwaway test key must FAIL against the REAL
  // embedded public key — otherwise the embedded key could be substituted.
  const v = await core.verifyLicenseToken(await signToken(MID, '00000000'), core.LICENSE_TOKEN_PUBKEY_PEM, MID);
  assert.strictEqual(v.ok, false);
});

tAsync('license token: malformed token rejected', async () => {
  assert.strictEqual(core.licenseTokenParse(null), null);
  assert.strictEqual(core.licenseTokenParse('v2.a1b2c3d400000000.' + '0'.repeat(128)), null);
  assert.strictEqual(core.licenseTokenParse('v1.a1b2c3d4.00'), null);
  assert.strictEqual(core.licenseTokenParse('v1.zzzz' + '0'.repeat(150)), null);
  const v = await core.verifyLicenseToken('garbage', core.LICENSE_TOKEN_PUBKEY_PEM, MID);
  assert.strictEqual(v.ok, false);
});

tAsync('license token: embedded public key matches the real signing key', async () => {
  // Copy-paste guard: the PEM baked into core.js must be the actual keypair
  // generated for the worker's AMH_LICENSE_SIGNING_KEY. A pubkey that can sign
  // nothing (no matching private key) would still "verify" shape — this guards
  // against a mismatched paste. (Real signature binding is the test above.)
  const pem = core.LICENSE_TOKEN_PUBKEY_PEM;
  const b64 = pem.replace(/-----BEGIN[^-]*-----/g, '').replace(/-----END[^-]*-----/g, '').replace(/\n/g, '');
  assert.ok(b64.indexOf('MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEh4nYjxBierpwVmlfyDAGnpcqjZZl') === 0, 'embedded pubkey is the generated P-256 key');
});

(async () => {
  await Promise.all(pending);
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail) +
    '  (' + pass + ' passed, ' + fail + ' failed)');
  process.exit(fail === 0 ? 0 : 1);
})();
