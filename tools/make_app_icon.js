// node tools/make_app_icon.js — app/amh.ico, the desktop icon of Amharic
// Captions Studio, from the owner's logo (tools/brand/logo.jpg, 640x640).
// A desktop icon is shown at 16-48 px, where the words of the logo are dots,
// so the icon is the logo's mark: the big "A" with the gold play button, on
// its dark blue. Drawn at every size Windows uses (a canvas in the headless
// Microsoft Edge every Windows 10/11 has) and packed as PNG images in one .ico.
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'tools', 'brand', 'logo.jpg');
const OUT = path.join(ROOT, 'app', 'amh.ico');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// the mark in the 640x640 logo: the "A" and its play button
const CROP = { x: 125, y: 0, w: 390, h: 390 };
const BG = '#0b1a3a';   // the logo's dark blue
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
if (!EDGE) { console.error('Microsoft Edge not found'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'amh_icon_'));
  const img = 'data:image/jpeg;base64,' + fs.readFileSync(SRC).toString('base64');
  const port = 9600 + Math.floor(Math.random() * 300);
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + port,
    '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
  let tab = null;
  for (let i = 0; i < 50 && !tab; i++) {
    try { tab = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()).find((t) => t.type === 'page'); } catch (e) {}
    if (!tab) await sleep(200);
  }
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const waits = {};
  ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && waits[d.id]) { waits[d.id](d); delete waits[d.id]; } });
  const cmd = (method, params) => new Promise((r) => { const i = ++id; waits[i] = r; ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  // one canvas per size: rounded dark-blue square, the mark scaled in
  const js = `(async () => {
    const im = new Image(); im.src = ${JSON.stringify(img)}; await im.decode();
    const out = {};
    for (const n of ${JSON.stringify(SIZES)}) {
      const c = document.createElement('canvas'); c.width = n; c.height = n;
      const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
      const r = Math.round(n * 0.2);
      g.beginPath(); g.moveTo(r, 0); g.arcTo(n, 0, n, n, r); g.arcTo(n, n, 0, n, r); g.arcTo(0, n, 0, 0, r); g.arcTo(0, 0, n, 0, r); g.closePath();
      g.fillStyle = ${JSON.stringify(BG)}; g.fill(); g.clip();
      const pad = n <= 24 ? Math.round(n * 0.04) : Math.round(n * 0.09);
      g.drawImage(im, ${CROP.x}, ${CROP.y}, ${CROP.w}, ${CROP.h}, pad, pad, n - 2 * pad, n - 2 * pad);
      out[n] = c.toDataURL('image/png').split(',')[1];
    }
    return JSON.stringify(out);
  })()`;
  const r = await cmd('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
  ws.close(); edge.kill();
  try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  if (!r.result || !r.result.result || !r.result.result.value) { console.error('drawing failed', JSON.stringify(r).slice(0, 400)); process.exit(1); }
  const got = JSON.parse(r.result.result.value);
  const pngs = SIZES.map((n) => ({ n, data: Buffer.from(got[n], 'base64') }));
  // .ico: header, one 16-byte entry per image, then the PNG files themselves
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let off = 6 + dir.length;
  pngs.forEach((p, i) => {
    const o = i * 16;
    dir.writeUInt8(p.n >= 256 ? 0 : p.n, o); dir.writeUInt8(p.n >= 256 ? 0 : p.n, o + 1);
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(p.data.length, o + 8); dir.writeUInt32LE(off, o + 12);
    off += p.data.length;
  });
  fs.writeFileSync(OUT, Buffer.concat([head, dir, ...pngs.map((p) => p.data)]));
  for (const p of pngs) if ([32, 48, 256].includes(p.n)) fs.writeFileSync(path.join(os.tmpdir(), 'amh_icon_' + p.n + '.png'), p.data);
  console.log('wrote ' + OUT + ' (' + SIZES.join(', ') + ' px)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
