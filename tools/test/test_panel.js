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
  assert.strictEqual(out, 'Speaker 1: a\nSpeaker 2: b');
});

t('displaySrtTextFromCues: a dash only where the speaker changes, never [Sx]', () => {
  const out = core.displaySrtTextFromCues([
    { start: 0, end: 1, text: 'a', speaker: 'S1' },
    { start: 1, end: 2, text: 'b', speaker: 'S1' },
    { start: 2, end: 3, text: 'c', speaker: 'S2' },
    { start: 3, end: 4, text: 'd' },
    { start: 4, end: 5, text: 'e', speaker: 'S1' },
  ]);
  const texts = core.parseSrt(out).map((c) => c.text);
  assert.deepStrictEqual(texts, ['a', 'b', '– c', 'd', '– e']);
  assert.ok(out.indexOf('[S') < 0);
  assert.strictEqual(core.displaySrtTextFromCues([{ start: 0, end: 1, text: 'x' }]).indexOf('–'), -1, 'unlabelled: no dash');
});

t('speakerSummary: two / one / off', () => {
  assert.strictEqual(core.speakerSummary(labelled, true), 'two');
  assert.strictEqual(core.speakerSummary([{ start: 0, end: 1, text: 'x' }], true), 'one');
  assert.strictEqual(core.speakerSummary([{ start: 0, end: 1, text: 'x', speaker: 'S1' }], true), 'one');
  assert.strictEqual(core.speakerSummary(labelled, false), 'off');
});

t('replaceWords: whole words and phrases only, counts replacements', () => {
  assert.deepStrictEqual(core.replaceWords('ሰላም ሰላምታ ሰላም።', 'ሰላም', 'X'), { text: 'X ሰላምታ X።', n: 2 });
  assert.deepStrictEqual(core.replaceWords('ዶክተር  አበበ ነው', 'ዶክተር አበበ', 'ዶ/ር አበበ'), { text: 'ዶ/ር አበበ ነው', n: 1 });
  assert.deepStrictEqual(core.replaceWords('a (b) c', 'b', 'Z'), { text: 'a (Z) c', n: 1 });
  assert.strictEqual(core.replaceWords('x', '', 'y').n, 0, 'empty find does nothing');
  assert.strictEqual(core.replaceWords('a.b a+b', 'a+b', 'Q').text, 'a.b Q', 'regex characters are literal');
});

t('learnFixes: word-for-word fixes only, never split/merged/new captions', () => {
  const before = [{ _id: 1, text: 'ሰላም ፍንደ ነው' }, { _id: 2, text: 'አንድ ሁለት' }, { _id: 3, text: 'ሀ ለ' }];
  const after = [{ _id: 1, text: 'ሰላም ፍቅሬ ነው።' }, { _id: 2, text: 'አንድ' }, { _id: 3, text: 'ሀ ለ' }, { _id: 9, text: 'አዲስ' }];
  assert.deepStrictEqual(core.learnFixes(before, after), [['ፍንደ', 'ፍቅሬ']]);
  assert.deepStrictEqual(core.learnFixes([{ _id: 1, text: 'ነው' }], [{ _id: 1, text: 'ነው።' }]), [], 'punctuation-only edit teaches nothing');
});

t('splitTextAt: at the cursor, on a word boundary; middle when no cursor', () => {
  const t = 'ሰላም ውድ ተመልካቾቼ እንኳን';
  assert.deepStrictEqual(core.splitTextAt(t, 'ሰላም ውድ ተመ'.length), ['ሰላም ውድ', 'ተመልካቾቼ እንኳን'], 'inside a word → nearest space');
  assert.deepStrictEqual(core.splitTextAt(t, t.indexOf('እንኳን')), ['ሰላም ውድ ተመልካቾቼ', 'እንኳን']);
  assert.deepStrictEqual(core.splitTextAt(t, -1), ['ሰላም ውድ', 'ተመልካቾቼ እንኳን'], 'no cursor → middle');
  assert.deepStrictEqual(core.splitTextAt(t, 0), ['ሰላም ውድ', 'ተመልካቾቼ እንኳን'], 'cursor at the start → middle');
  assert.strictEqual(core.splitTextAt('ቻው', 1), null, 'one word cannot be split');
  assert.deepStrictEqual(core.splitTextAt('a  b', 2), ['a', 'b'], 'double space');
});

t('doubtRanges: where the unsure words sit (whole words, in order, no overlap)', () => {
  const t = 'ፈታን ነው፣ እሱ ፈታንታ ፈታን።';
  const r = core.doubtRanges(t, ['ፈታን']);
  assert.deepStrictEqual(r.map((x) => t.slice(x.start, x.end)), ['ፈታን', 'ፈታን'], 'both whole words, not ፈታንታ');
  assert.strictEqual(r[1].start, t.lastIndexOf('ፈታን'));
  const two = core.doubtRanges('ገላት አትክልትና ይመረታሉ', ['ይመረታሉ', 'ገላት']);
  assert.deepStrictEqual(two.map((x) => x.start), [0, 'ገላት አትክልትና '.length], 'sorted left to right');
  assert.deepStrictEqual(core.doubtRanges('ሰላም', []), []);
  assert.deepStrictEqual(core.doubtRanges('', ['ሰላም']), []);
  assert.deepStrictEqual(core.doubtRanges('a.b a', ['a.b']).length, 1, 'regex characters are literal');
});

t('applyFixes: applies remembered fixes and reports them', () => {
  const r = core.applyFixes('ሰላም ፍንደ፣ ፍንደ ሰላምታ', { 'ፍንደ': 'ፍቅሬ', 'ሰላም': 'ሰላም!' });
  assert.strictEqual(r.text, 'ሰላም! ፍቅሬ፣ ፍቅሬ ሰላምታ');
  assert.strictEqual(r.applied.reduce((a, x) => a + x.n, 0), 3);
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
  assert.strictEqual(core.txtTextFromCues(cues), 'Speaker 1: ሰላም\nSpeaker 2: ዓለም');
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

// ── ✂ Clean-up cut (1.16.20) ─────────────────────────────────────────────────
t('clean up: a repeated take (3+ words said again) cuts the FIRST try; two-word repeats stay', () => {
  const cues = [{ text: 'ዛሬ ስለ ቡና', start: 0, end: 1.5 }, { text: 'ዛሬ ስለ ቡና ታሪክ እናወራለን።', start: 2, end: 5 }];
  const r = core.findRepeats(cues);
  assert.strictEqual(r.length, 1);
  assert.deepStrictEqual([r[0].start, r[0].end, r[0].text], [0, 2, 'ዛሬ ስለ ቡና']);
  assert.deepStrictEqual(r[0].words, [[0, 0], [0, 1], [0, 2]]);
  assert.strictEqual(core.findRepeats([{ text: 'በጣም በጣም ጥሩ ነው', start: 0, end: 2 }]).length, 0, 'emphasis is how people talk');
  assert.strictEqual(core.findRepeats([{ text: 'ሀ ለ መ ሀ ለ መ', start: 0, end: 2 }]).length, 0, 'too short to be a sentence');
});

t('clean up: hesitation sounds are ticked, "filler words" (እንግዲህ, ያው, ማለቴ) are only offered', () => {
  const f = core.findFillers([{ text: 'እ… እንግዲህ ዛሬ ኧኧ', start: 0, end: 4 }]);
  assert.deepStrictEqual(f.map((x) => [x.text, x.word]), [['እ…', false], ['እንግዲህ', true], ['ኧኧ', false]]);
  assert.deepStrictEqual(f[2].words, [[0, 3]]);
});

t('clean up: pauses come from THIS recording (noisy room fine, no contrast = nothing), with breath kept', () => {
  const env = (quiet, loud) => {
    const db = [];
    for (let i = 0; i < 500; i++) db.push(i >= 100 && i < 200 ? quiet : loud + (i % 3));
    return { t0: 10, step: 0.02, db };
  };
  assert.deepStrictEqual(core.findSilences(env(-70, -20)), [{ start: 12.15, end: 13.85 }]);
  assert.strictEqual(core.findSilences(env(-45, -20)).length, 1, 'a noisy room still has its pauses');
  assert.strictEqual(core.findSilences(env(-24, -20)).length, 0, 'no clear voice/quiet difference: cut nothing');
  assert.strictEqual(core.findSilences(env(-70, -20), { minLen: 2.5 }).length, 0, 'shorter than asked');
});

t('clean up: captions and footage follow the cut', () => {
  const cuts = core.mergeRanges([{ start: 8, end: 9 }, { start: 3, end: 4 }, { start: 3.5, end: 4.2 }]);
  assert.deepStrictEqual(cuts, [{ start: 3, end: 4.2 }, { start: 8, end: 9 }]);
  assert.strictEqual(core.cutTime(10, cuts), 7.8);
  assert.strictEqual(core.cutTime(3.6, cuts), 3);
  const cues = [{ text: 'አንድ', start: 1, end: 2, _id: 'a' }, { text: 'ሁለት', start: 3.2, end: 4 }, { text: 'እ ሶስት', start: 5, end: 6 }];
  assert.deepStrictEqual(core.remapCuesAfterCut(cues, cuts, [[2, 0]]),
    [{ text: 'አንድ', start: 1, end: 2, _id: 'a' }, { text: 'ሶስት', start: 3.8, end: 4.8 }]);
  const m = core.remapMediaAfterCut([{ path: 'v.mp4', offset: 5, from: 0, to: 20 }], cuts);
  assert.deepStrictEqual(m.map((x) => [x.from, Math.round(x.to * 10) / 10, Math.round(x.offset * 10) / 10]),
    [[0, 3, 5], [3, 6.8, 6.2], [6.8, 17.8, 7.2]]);
});

// ── 🔍 Auto zoom (1.16.23) ───────────────────────────────────────────────────
t('auto zoom: ★ words and numbers/money, one per caption, never two within 3 s', () => {
  const cues = [{ text: 'ሰላም ናችሁ', start: 0, end: 1 }, { text: 'ዋጋው 5,000 ብር ነው', start: 1, end: 3 },
    { text: 'በጣም *ጥሩ* ነው', start: 3.5, end: 5 }, { text: 'ዛሬ *ልዩ ቅናሽ* አለ', start: 8, end: 10 }, { text: '20% ብቻ', start: 10, end: 11 },
    { text: 'አንድ ሚሊዮን ሰው', start: 20, end: 22 }];
  const m = core.findZoomMoments(cues);
  assert.deepStrictEqual(m.map((x) => [x.text, x.cue, x.star]), [['5,000', 1, false], ['ልዩ', 3, true], ['ሚሊዮን', 5, false]]);
  assert.ok(m[0].word > 1 && m[0].word < 3, 'the zoom lands on the word, inside its caption');
  assert.deepStrictEqual(core.findZoomMoments(cues, { auto: false }).map((x) => x.text), ['ጥሩ', 'ልዩ'], '★ only');
  assert.strictEqual(core.findZoomMoments([{ text: 'ምንም የለም', start: 0, end: 2 }]).length, 0);
});

// ── ✂ Text cuts (1.16.24) ────────────────────────────────────────────────────
t('text cuts: ~struck~ words become cuts; a whole struck caption is cut at its exact times', () => {
  const cues = [{ text: 'ዛሬ ~ስለ ቡና~ እናወራለን', start: 0, end: 3 }, { text: '~ይህንን ቁረጡ~', start: 3, end: 5 },
    { text: 'ሀ ~ለ~ መ ~ረ~', start: 5, end: 7 }, { text: 'ምንም የለም', start: 7, end: 8 }];
  const c = core.findTextCuts(cues);
  assert.deepStrictEqual(c.map((x) => [x.text, x.whole, x.words]), [
    ['ስለ ቡና', false, [[0, 1], [0, 2]]], ['ይህንን ቁረጡ', true, [[1, 0], [1, 1]]], ['ለ', false, [[2, 1]]], ['ረ', false, [[2, 3]]]]);
  assert.deepStrictEqual([c[1].start, c[1].end], [3, 5], 'whole caption: exact');
  assert.ok(c[0].start > 0 && c[0].end < 3 && c[0].start < c[0].end, 'inside a caption: estimated, inside it');
  assert.deepStrictEqual(core.cutRanges('ሀ ~ለ~ መ'), [{ start: 2, end: 5 }]);
});

t('text cuts: until cut from the video, the words stay in every subtitle file (only the marks go)', () => {
  const cues = [{ text: 'ዛሬ ~ስለ~ *ቡና*', start: 0, end: 2 }];
  assert.strictEqual(core.noEmph(cues[0].text), 'ዛሬ ስለ ቡና');
  assert.ok(core.displaySrtTextFromCues(cues).includes('ዛሬ ስለ ቡና') && !core.displaySrtTextFromCues(cues).includes('~'));
  assert.ok(!core.vttTextFromCues(cues).includes('~') && !core.txtTextFromCues(cues).includes('~'));
  // and repeats are found through the marks
  assert.strictEqual(core.findRepeats([{ text: '~ዛሬ ስለ ቡና~ ዛሬ ስለ ቡና ታሪክ', start: 0, end: 4 }]).length, 1);
});

// ── exact word times (1.16.26) ───────────────────────────────────────────────
t('word times: the engine\'s exact times are used while they still fit the text', () => {
  const c = { text: 'ዛሬ ~ስለ~ ቡና', start: 2, end: 3.1, wt: [[2.0, 2.3], [2.35, 2.55], [2.6, 3.1]] };
  const W = core.cleanupWords([c]);
  assert.deepStrictEqual(W.map((x) => [x.s, x.e, x.exact]), [[2.0, 2.3, true], [2.35, 2.55, true], [2.6, 3.1, true]]);
  const cut = core.findTextCuts([c]);
  assert.deepStrictEqual([cut[0].start, cut[0].end, cut[0].exact], [2.35, 2.55, true], 'a ✂ word: exactly that word');
  // the editor added a word: the times no longer fit -> estimated
  assert.ok(core.cleanupWords([Object.assign({}, c, { text: 'ዛሬ ስለ ቡና ታሪክ' })]).every((x) => !x.exact));
  // times outside the caption (they belong to something else) -> estimated
  assert.strictEqual(core.exactWordTimes({ text: 'ሀ', start: 10, end: 11, wt: [[2, 3]] }, 1), null);
  assert.strictEqual(core.exactWordTimes({ text: 'ሀ', start: 10, end: 11 }, 1), null);
});

t('word times: after a cut they follow the timeline, cut words drop out', () => {
  const cues = [{ text: 'ዛሬ ስለ ቡና', start: 2, end: 3.1, wt: [[2.0, 2.3], [2.35, 2.55], [2.6, 3.1]] }];
  const out = core.remapCuesAfterCut(cues, [{ start: 2.33, end: 2.58 }], [[0, 1]]);
  assert.strictEqual(out[0].text, 'ዛሬ ቡና');
  assert.deepStrictEqual(out[0].wt, [[2, 2.3], [2.35, 2.85]]);
  // a caption without times stays without
  assert.strictEqual(core.remapCuesAfterCut([{ text: 'ሀ ለ', start: 0, end: 1 }], [], [])[0].wt, undefined);
});

// ── regroup (Studio 1.18.0: decide later, never redo) ────────────────────────
t('regroup: words per caption change after transcription; the words, marks and edits stay', () => {
  const cues = [{ text: 'ሰላም ናችሁ', start: 0, end: 1, wt: [[0, 0.4], [0.5, 1]] }, { text: 'ዛሬ ስለ *ቡና* ታሪክ', start: 1.1, end: 3, doubt: ['ታሪክ'] },
    { text: '~እንግዲህ ቆይ~ እናወራለን።', start: 4.5, end: 6 }, { text: 'ጥሩ', start: 6.2, end: 6.4 }];
  const words = (qs) => qs.map((q) => q.text).join(' ');
  const one = core.regroupCues(cues, { words: 1 });
  assert.strictEqual(words(one), words(cues), 'every word, in order, as written');
  assert.deepStrictEqual(one.slice(0, 2).map((q) => [q.start, q.end, q.wt]), [[0, 0.4, [[0, 0.4]]], [0.5, 1, [[0.5, 1]]]], 'exact times stay exact');
  assert.strictEqual(one.find((q) => q.text === 'ታሪክ').doubt[0], 'ታሪክ', 'a doubtful word keeps its mark');
  assert.ok(one.some((q) => q.text === '~እንግዲህ ቆይ~'), 'a ✂ run is never split');
  const three = core.regroupCues(cues, { words: 3 });
  assert.deepStrictEqual(three.map((q) => q.text), ['ሰላም ናችሁ ዛሬ', 'ስለ *ቡና* ታሪክ', '~እንግዲህ ቆይ~ እናወራለን።', 'ጥሩ']);
  assert.ok(three.every((q, i) => q.end > q.start && (!three[i + 1] || q.end <= three[i + 1].start)), 'never overlapping');
  // a sentence end and a long pause always start a new caption
  const s = core.regroupCues([{ text: 'አንድ። ሁለት ሶስት', start: 0, end: 3 }, { text: 'አራት', start: 6, end: 7 }], { words: 5 });
  assert.deepStrictEqual(s.map((q) => q.text), ['አንድ።', 'ሁለት ሶስት', 'አራት']);
  // short lines for vertical video
  const long = [{ text: 'ዛሬ ስለ ኢትዮጵያ ቡና አስደናቂ ታሪክ እናወራለን', start: 0, end: 6 }];
  assert.ok(core.regroupCues(long, { words: 5, maxChars: 14 }).every((q) => Array.from(q.text).length <= 14 || q.text.split(' ').length === 1));
  // a karaoke word shorter than a frame is still readable
  assert.ok(core.regroupCues([{ text: 'ሀ', start: 1, end: 1.02 }], { words: 1 })[0].end >= 1.3);
});

(async () => {
  await Promise.all(pending);
  console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES: ' + fail) +
    '  (' + pass + ' passed, ' + fail + ' failed)');
  process.exit(fail === 0 ? 0 : 1);
})();
