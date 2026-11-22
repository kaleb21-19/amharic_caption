// test_ui_tokens.js — the panel's design tokens (1.94.47, UI plan U1).
//
// Every colour, font size, weight, radius, space, layer and duration in the
// panel stylesheet (panel/index.html) and the markup's inline styles comes
// from panel/tokens.css. This test fails the build when a hard-coded value
// comes back, when a var() names a token that does not exist (a silent
// fallback - the audit found --bg-input and --line), and when a token pair
// falls under its WCAG 2.2 contrast.
//
//   node tools/test/test_ui_tokens.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'panel', 'index.html'), 'utf8');
const tokens = fs.readFileSync(path.join(ROOT, 'panel', 'tokens.css'), 'utf8');
const css = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const markup = html.slice(html.indexOf('</style>'));
const inline = (markup.match(/style="[^"]*"/g) || []).join('\n');
// caption colour swatches are content (the colours a caption can take), not UI
const cssUi = css.split('\n').filter((l) => !/\/\* content/.test(l)).join('\n');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  [OK] ' + name); };
const uniq = (a) => Array.from(new Set(a));
const vals = (src, prop) => (src.match(new RegExp('(?<![-\\w])' + prop + '\\s*:\\s*([^;}"]+)', 'g')) || [])
  .map((m) => m.replace(new RegExp('^.*?' + prop + '\\s*:\\s*'), '').trim());

t('tokens.css is loaded before the stylesheet', () => {
  const link = html.indexOf('<link rel="stylesheet" href="tokens.css">');
  assert.ok(link > 0 && link < html.indexOf('<style>'));
});

t('no hard-coded colour in the stylesheet or inline styles (caption swatches marked as content)', () => {
  const left = uniq((cssUi + inline).match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || []);
  assert.deepStrictEqual(left, []);
});

t('font sizes only from the type scale', () => {
  const bad = vals(css + inline, 'font-size').filter((v) => !/^var\(--font-size-(micro|xs|sm|md|lg|xl)\)$/.test(v) && v !== 'inherit');
  assert.deepStrictEqual(uniq(bad), []);
  assert.ok(!/font:\s*[^;]*\d+px\/\d/.test(css.replace(/var\(--font-size-[a-z]+\)\/18px/g, '')), 'the font shorthand uses a size token');
});

t('font weights only regular / semibold / bold', () => {
  const bad = vals(css + inline, 'font-weight').filter((v) => !/^var\(--font-weight-(regular|semibold|bold)\)$/.test(v) && v !== 'normal' && v !== 'inherit');
  assert.deepStrictEqual(uniq(bad), []);
});

t('radii only from the radius scale', () => {
  const bad = vals(css + inline, 'border-radius')
    .filter((v) => !v.split(/\s+/).every((p) => p === '0' || p === 'inherit' || /^var\(--radius(-(sm|md|lg|pill|round))?\)$/.test(p)));
  assert.deepStrictEqual(uniq(bad), []);
});

t('spacing from the 4 px scale; only a few layout reservations over 24 px', () => {
  const props = ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top', 'padding-right',
    'padding-bottom', 'padding-left', 'gap', 'row-gap', 'column-gap'];
  const parts = [].concat(...props.map((p) => vals(css + inline, p))).join(' ')
    .replace(/calc\(-1 \* var\(--space-\d\)\)/g, '').split(/\s+/).filter(Boolean);
  const px = parts.filter((p) => /^-?\d+(\.\d+)?px$/.test(p));
  const small = px.filter((p) => Math.abs(parseFloat(p)) <= 24);
  assert.deepStrictEqual(uniq(small), [], 'a space of 24 px or less is a token');
  assert.ok(uniq(px).length <= 4, 'layout reservations (room kept for buttons) stay few: ' + uniq(px).join(' '));
});

t('layers only from the layer tokens (0-2 inside a component)', () => {
  const bad = vals(css, 'z-index').filter((v) => !/^var\(--z-(sticky|menu|dialog|toast|badge)\)$/.test(v) && !/^[012]$/.test(v));
  assert.deepStrictEqual(uniq(bad), []);
});

t('shadows: elevation tokens, or rings / underlines in a token colour', () => {
  const bad = vals(css, 'box-shadow').filter((v) => v !== 'none' && !/^var\(--elevation-(raised|menu|dialog|accent)\)$/.test(v) &&
    !/^(inset )?-?\d+(px)? -?\d+(px)? \d+(px)?( \d+px)? var\(--[a-z-]+\)( inset)?$/.test(v));
  assert.deepStrictEqual(uniq(bad), []);
});

t('durations only from the motion tokens', () => {
  const bad = vals(css, 'transition').filter((v) => /(?<![\w-])\d*\.?\d+m?s\b/.test(v.replace(/var\(--[a-z-]+\)/g, '')));
  assert.deepStrictEqual(uniq(bad), []);
});

t('every var() is a real token (or one the code sets at runtime)', () => {
  const defined = new Set((tokens + css).match(/--[a-z0-9-]+(?=\s*:)/g));
  const runtime = new Set(['--review-font', '--sw-ink', '--my-color']);
  const used = uniq((css + inline).match(/var\(--[a-z0-9-]+/g).map((v) => v.slice(4)));
  assert.deepStrictEqual(used.filter((v) => !defined.has(v) && !runtime.has(v)), []);
});

t('1.94.49 keyboard focus is visible everywhere; no outline removed without a replacement', () => {
  assert.match(css, /button:focus-visible,[^{]*\{\s*outline: var\(--ring-width\) solid var\(--color-focus-ring\)/);
  (css.match(/[^{}]+\{[^}]*outline:\s*(none|0)[^}]*\}/g) || []).forEach((rule) => {
    assert.ok(/border-color:\s*var\(--accent\)/.test(rule), 'outline removed with no visible focus instead: ' + rule.trim().slice(0, 80));
  });
});

t('1.94.49 control edges use the 3:1 border; Ethiopic in the shipped Noto face; Cancel on the danger fill', () => {
  for (const sel of ['.seg {', '.btn-neutral {', '.sc-seg {', '.sc-compact .cc-seg {', '.cc-pick {', '.sc-name {', '.cc-name {', '.lang-toggle {']) {
    const i = css.indexOf(sel);
    assert.ok(i >= 0, sel);
    assert.ok(/var\(--color-border-control\)/.test(css.slice(i, css.indexOf('}', i))), sel + ' edge');
  }
  assert.match(css, /input\[type="text"\][^{]*\{[^}]*border: 1px solid var\(--color-border-control\)/);
  assert.match(tokens, /font-family: "AMH Ethiopic";\s*src: url\("runtime\/fonts\/NotoSansEthiopic-Regular\.ttf"\)/);
  assert.match(tokens, /unicode-range: U\+1200-139F/);
  assert.match(tokens, /--font-family-ui: "AMH Ethiopic",/);
  assert.match(css, /#cancelBtn \{[^}]*background: var\(--color-danger-solid\)/);
});

t('1.94.50 one component layer; notices are a component, not copied inline styles', () => {
  const at = css.indexOf('1.94.50 component layer');
  assert.ok(at > 0, 'the component layer');
  const layer = css.slice(at);
  for (const c of ['Button · primary', 'Button · secondary', 'Button · ghost', 'Button · add', 'Button · danger', 'Menu item', 'Chip', 'Segmented', 'IconButton', 'Disclosure', 'Notice']) {
    assert.ok(layer.indexOf(c) >= 0, c);
  }
  for (const id of ['zipWarn', 'renewBox', 'trialBanner', 'machineUnsaved', 'machineMismatch']) {
    const m = new RegExp('<div id="' + id + '"[^>]*>').exec(markup);
    assert.ok(m, id);
    assert.match(m[0], /class="notice notice-(warn|danger)/, id + ' is a notice');
    assert.match(m[0], /style="display:none;"/, id + ': no copied inline look');
  }
  assert.ok(!/border:1px solid var\(--(warn|err)\);border-radius/.test(markup), 'no inline banner look left');
});

// WCAG 2.2: text 4.5:1, a control's edge 3:1 (1.4.11)
const tok = {};
tokens.replace(/(--color-[a-z-]+):\s*(#[0-9a-fA-F]{6})/g, (m, k, v) => { tok[k] = v; });
const lum = (h) => [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16) / 255)
  .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
  .reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const x = lum(tok[a]), y = lum(tok[b]); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
t('token contrast: text 4.5:1, control edges and the focus ring 3:1', () => {
  const bgs = ['--color-bg-base', '--color-bg-raised', '--color-bg-sunken'];
  for (const bg of bgs) {
    for (const fg of ['--color-text-primary', '--color-text-secondary', '--color-accent', '--color-warning', '--color-info']) {
      assert.ok(ratio(fg, bg) >= 4.5, fg + ' on ' + bg + ' ' + ratio(fg, bg).toFixed(2));
    }
    assert.ok(ratio('--color-danger', bg) >= 4.5, 'danger text ' + ratio('--color-danger', bg).toFixed(2));
    assert.ok(ratio('--color-border-control', bg) >= 3, 'control edge on ' + bg + ' ' + ratio('--color-border-control', bg).toFixed(2));
    assert.ok(ratio('--color-focus-ring', bg) >= 3, 'focus ring on ' + bg);
  }
  assert.ok(ratio('--color-text-on-accent', '--color-accent') >= 4.5);
  assert.ok(ratio('--color-text-on-danger', '--color-danger-solid') >= 4.5, 'white on a danger button ' + ratio('--color-text-on-danger', '--color-danger-solid').toFixed(2));
  assert.ok(ratio('--color-text-on-danger', '--color-danger-solid-hover') >= 4.5);
  assert.ok(ratio('--color-text-on-accent', '--color-accent') >= 3, 'the dark focus ring on a green control');
});

t('the numbers the U1 plan promised', () => {
  const sizes = uniq(vals(css + inline, 'font-size'));
  const radii = uniq([].concat(...vals(css + inline, 'border-radius').map((v) => v.split(/\s+/))));
  const elev = uniq((css.match(/var\(--elevation-[a-z]+\)/g) || []));
  const z = uniq(vals(css, 'z-index'));
  console.log('      font sizes ' + sizes.length + ' · radii ' + radii.length + ' · elevations ' + elev.length + ' · layers ' + z.length);
  assert.ok(sizes.length <= 7 && radii.length <= 7 && elev.length <= 4 && z.length <= 8);
});

console.log('ALL PASS  (' + passed + ' tests)');
