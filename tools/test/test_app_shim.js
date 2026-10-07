#!/usr/bin/env node
/*
 * test_app_shim.js — app/node_shim.js, the Node stand-in the desktop app gives
 * the panel (see app/amh_app.py).
 *
 * The shim runs in a Node vm with a fake bridge: synchronous XHR answers from
 * an in-memory file system, fetch() answers /__api/poll with scripted child
 * process events. Checks that the panel sees what Node would give it:
 * path rules on Windows and macOS, fs *Sync semantics (ENOENT codes),
 * createHash, execFile / spawn events and errors, the license-server proxy,
 * __dirname and the __adobe_cep__ stand-in.
 *
 * Run:  node tools/test/test_app_shim.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'node_shim.js'), 'utf8');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  [OK] ' + name); }
  catch (e) { failed++; console.log('  [FAIL] ' + name + '\n         ' + (e && e.stack || e)); }
}

function load(platform, opts) {
  opts = opts || {};
  const files = {};             // in-memory fs for the fake bridge
  const calls = [];
  const posts = [];
  const children = {};
  let nextId = 1;
  const sync = (op, a) => {
    calls.push([op, a]);
    switch (op) {
      case 'existsSync': return a[0] in files;
      case 'readFileSync': if (!(a[0] in files)) return { err: { code: 'ENOENT', message: 'no such file: ' + a[0] } }; return files[a[0]];
      case 'writeFileSync': files[a[0]] = a[1]; return null;
      case 'unlinkSync': if (!(a[0] in files)) return { err: { code: 'ENOENT', message: 'missing' } }; delete files[a[0]]; return null;
      case 'statSync': if (!(a[0] in files)) return { err: { code: 'ENOENT', message: 'missing' } }; return { size: files[a[0]].length, mtimeMs: 1234.5, isFile: true, isDirectory: false };
      case 'hash': return nodeCrypto.createHash(a[0]).update(a[1]).digest('hex');
      case 'dialog': return opts.dialog || null;
      case 'spawn': { const id = 'c' + nextId++; children[id] = { cmd: a[0], args: a[1], env: a[2], cwd: a[3], timeout: a[4], events: (opts.events || {})[a[0]] || [{ t: 'exit', code: 0 }] }; return id; }
      default: return null;
    }
  };
  class XMLHttpRequest {
    open(m, url, async) { this.url = url; this.async = async; }
    setRequestHeader(k, v) { (this.h = this.h || {})[k] = v; }
    send(body) {
      assert.strictEqual(this.async, false, 'bridge calls are synchronous');
      assert.strictEqual(this.h['X-Amh-Token'], 'TOK', 'token header on every bridge call');
      const { op, args } = JSON.parse(body);
      const r = sync(op, args);
      this.status = 200;
      this.responseText = JSON.stringify(r && r.err ? r : { result: r });
    }
  }
  const fetchFn = async (url, o) => {
    o = o || {};
    if (url === '/__api/proxy') { posts.push(['proxy', JSON.parse(o.body)]); return { json: async () => ({ status: 403, body: '{"valid":false}' }) }; }
    if (url.startsWith('/__api/poll')) {
      // opts.pollDown: the app server does not answer the first N polls
      // (e.g. right after the computer wakes from sleep).
      if (opts.pollDown && opts.pollDown-- > 0) throw new TypeError('Failed to fetch');
      const q = new URLSearchParams(url.split('?')[1]);
      const c = children[q.get('id')];
      if (!c) return { status: 404, json: async () => ({}) };
      const since = +q.get('since');
      const evs = c.events.slice(since);
      return { status: 200, json: async () => ({ events: evs, done: true }) };
    }
    if (url === '/__api/stdin' || url === '/__api/kill') { posts.push([url, JSON.parse(o.body)]); return { json: async () => ({ ok: true }) }; }
    return { real: url };
  };
  class Response { constructor(body, init) { this.body = body; this.status = init.status; } async json() { return JSON.parse(this.body); } }
  const win = {
    __AMH_APP__: { token: 'TOK', ext: platform === 'win32' ? 'C:\\Ext\\com.amharic.captions' : '/Users/me/ext',
      api: 'https://api.example', files: [],
      info: { platform, arch: 'x64', pid: 7, env: { AMH_A: '1' }, home: platform === 'win32' ? 'C:\\Users\\me' : '/Users/me',
        tmp: platform === 'win32' ? 'C:\\Users\\me\\AppData\\Local\\Temp' : '/tmp', hostname: 'pc', username: 'me' } },
    crypto: nodeCrypto.webcrypto,
    matchMedia: () => ({ matches: false }),
    __amhPollGiveUpMs: opts.giveUpMs,
  };
  win.fetch = fetchFn;
  const ctx = { window: win, XMLHttpRequest, Response, URLSearchParams, setTimeout, console, Promise, JSON, Object, Error, TypeError, Uint8Array };
  win.window = win;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { win, files, calls, posts, children };
}

(async () => {
  await t('path: Windows rules (drive letters, both slashes, .., basename/dirname/extname)', () => {
    const p = load('win32').win.require('path');
    assert.strictEqual(p.sep, '\\');
    assert.strictEqual(p.join('C:\\a', 'b', '..', 'c.srt'), 'C:\\a\\c.srt');
    assert.strictEqual(p.join('C:/Users/me', 'Videos/x y.mp4'), 'C:\\Users\\me\\Videos\\x y.mp4');
    assert.strictEqual(p.dirname('C:\\a\\b\\c.mp4'), 'C:\\a\\b');
    assert.strictEqual(p.dirname('C:\\c.mp4'), 'C:\\');
    assert.strictEqual(p.basename('C:\\a\\clip(2) final.mp4'), 'clip(2) final.mp4');
    assert.strictEqual(p.basename('C:\\a\\b.mp4', '.mp4'), 'b');
    assert.strictEqual(p.extname('C:\\a\\b.tar.gz'), '.gz');
    assert.strictEqual(p.resolve('C:\\a', 'b'), 'C:\\a\\b');
    assert.strictEqual(p.resolve('C:\\a', 'D:\\x'), 'D:\\x');
    assert.ok(p.isAbsolute('C:\\x') && !p.isAbsolute('x\\y'));
  });
  await t('path: macOS rules', () => {
    const p = load('darwin').win.require('path');
    assert.strictEqual(p.join('/Users/me', 'Movies', '../Desktop', 'ሙከራ.mov'), '/Users/me/Desktop/ሙከራ.mov');
    assert.strictEqual(p.dirname('/a/b/c'), '/a/b');
    assert.strictEqual(p.dirname('/c'), '/');
    assert.strictEqual(p.basename('/a/b/'), 'b');
    assert.strictEqual(p.resolve('/a', 'b', '..', 'c'), '/a/c');
  });
  await t('fs: *Sync calls go to the bridge; missing files throw with code ENOENT', () => {
    const { win, files } = load('win32');
    const f = win.require('fs');
    f.writeFileSync('C:\\x\\a.srt', 'ሰላም', { encoding: 'utf8', mode: 0o600 });
    assert.strictEqual(files['C:\\x\\a.srt'], 'ሰላም');
    assert.strictEqual(f.readFileSync('C:\\x\\a.srt', 'utf8'), 'ሰላም');
    assert.ok(f.existsSync('C:\\x\\a.srt') && !f.existsSync('C:\\nope'));
    const st = f.statSync('C:\\x\\a.srt');
    assert.ok(st.isFile() && !st.isDirectory() && st.mtimeMs === 1234.5 && st.size === 3);
    assert.throws(() => f.readFileSync('C:\\nope'), (e) => e.code === 'ENOENT');
    assert.throws(() => f.statSync('C:\\nope'), (e) => e.code === 'ENOENT');
    f.unlinkSync('C:\\x\\a.srt');
    assert.ok(!f.existsSync('C:\\x\\a.srt'));
  });
  await t('os / process / crypto: what the panel reads at start-up', () => {
    const { win } = load('win32');
    const os = win.require('os');
    assert.strictEqual(os.tmpdir(), 'C:\\Users\\me\\AppData\\Local\\Temp');
    assert.strictEqual(os.homedir(), 'C:\\Users\\me');
    assert.strictEqual(os.userInfo().username, 'me');
    assert.strictEqual(win.process.platform, 'win32');
    assert.strictEqual(win.process.env.AMH_A, '1');
    const h = win.require('crypto').createHash('sha1');
    h.update('ab'); h.update(':ሀ');
    assert.strictEqual(h.digest('hex'), nodeCrypto.createHash('sha1').update('ab:ሀ').digest('hex'), 'update() pieces hash like Node');
    assert.match(win.require('crypto').randomUUID(), /^[0-9a-f-]{36}$/);
    assert.throws(() => win.require('http'), /Cannot find module/);
  });
  await t('__dirname and the __adobe_cep__ stand-in (host APP, evalScript answers "")', async () => {
    const { win } = load('win32');
    assert.strictEqual(win.__dirname, 'C:\\Ext\\com.amharic.captions\\js', 'main.js derives the extension folder from it');
    const env = JSON.parse(win.__adobe_cep__.getHostEnvironment());
    assert.strictEqual(env.appName, 'APP');
    assert.ok(env.appSkinInfo.appBackgroundColor.red < 140, 'dark skin when the OS is dark');
    const r = await new Promise((ok) => win.__adobe_cep__.evalScript('amharic_findFootage()', ok));
    assert.strictEqual(r, '');
  });
  await t('dialogs: cep.fs.showOpenDialog maps to the app dialog', () => {
    const { win } = load('win32', { dialog: 'D:\\Exports' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(win.cep.fs.showOpenDialog(false, true, 'Choose'))), { err: 0, data: ['D:\\Exports'] });
    const none = load('win32').win.cep.fs.showOpenDialog(false, true, 'Choose');
    assert.strictEqual(none.data.length, 0, 'cancel = empty list, like CEP');
  });
  await t('execFile: stdout/stderr collected, callback(null, stdout) on exit 0, live stderr events', async () => {
    const { win, children } = load('win32', { events: { 'ffmpeg.exe': [
      { t: 'stderr', d: '[progress] 0.5\n' }, { t: 'stdout', d: 'part1 ' }, { t: 'stdout', d: 'part2' }, { t: 'exit', code: 0 }] } });
    const cp = win.require('child_process');
    const live = [];
    const out = await new Promise((ok, no) => {
      const c = cp.execFile('ffmpeg.exe', ['-i', 'a b.mp4'], { timeout: 5000, env: { X: '1' } }, (err, so, se) => (err ? no(err) : ok([so, se])));
      c.stderr.setEncoding('utf8');
      c.stderr.on('data', (d) => live.push(d));
    });
    assert.deepStrictEqual(out, ['part1 part2', '[progress] 0.5\n']);
    assert.deepStrictEqual(live, ['[progress] 0.5\n']);
    const c = Object.values(children)[0];
    assert.deepStrictEqual([c.args, c.timeout, c.env.X], [['-i', 'a b.mp4'], 5000, '1']);
  });
  await t('execFile: a non-zero exit gives an Error with the stderr tail', async () => {
    const { win } = load('win32', { events: { 'python.exe': [{ t: 'stderr', d: 'Traceback: boom' }, { t: 'exit', code: 1 }] } });
    const err = await new Promise((ok) => win.require('child_process').execFile('python.exe', [], {}, (e) => ok(e)));
    assert.ok(err && err.code === 1 && /boom/.test(err.message), String(err));
  });
  await t('spawn: data events, stdin writes, kill, exit + close', async () => {
    const { win, posts } = load('win32', { events: { 'python.exe': [{ t: 'stdout', d: '{"ready":true}\n' }, { t: 'exit', code: 0 }] } });
    const c = win.require('child_process').spawn('python.exe', ['ethio_srt.py', '--server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const got = [];
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => got.push(d));
    const ended = new Promise((ok) => c.on('close', ok));
    assert.strictEqual(c.stdin.write('{"wav":"ሀ.wav"}\n'), true);
    await ended;
    assert.deepStrictEqual(got, ['{"ready":true}\n']);
    await new Promise((ok) => setTimeout(ok, 10));
    assert.deepStrictEqual(posts.find((p) => p[0] === '/__api/stdin')[1].data, '{"wav":"ሀ.wav"}\n');
    c.kill();
    assert.ok(c.killed);
    await new Promise((ok) => setTimeout(ok, 10));
    assert.ok(posts.some((p) => p[0] === '/__api/kill'));
  });
  await t('spawn: a few seconds without contact (waking from sleep) does not fail the job; a dead server does, in time', async () => {
    const ev = { 'python.exe': [{ t: 'stdout', d: 'done' }, { t: 'exit', code: 0 }] };
    const { win } = load('win32', { events: ev, pollDown: 2 });
    const code = await new Promise((ok) => win.require('child_process').spawn('python.exe', []).on('exit', ok));
    assert.strictEqual(code, 0, 'job finished normally after the outage');
    const dead = load('win32', { events: ev, pollDown: 1e9, giveUpMs: 1500 }).win;
    const t0 = Date.now();
    const code2 = await new Promise((ok) => dead.require('child_process').spawn('python.exe', []).on('exit', ok));
    assert.notStrictEqual(code2, 0, 'reported as failed');
    assert.ok(Date.now() - t0 >= 1400, 'only after the give-up time');
  });
  await t('fetch: only license-server URLs go through the app proxy', async () => {
    const { win, posts } = load('win32');
    const r = await win.fetch('https://api.example/api/validate', { method: 'POST', body: '{"mid":"m"}' });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(await r.json(), { valid: false });
    assert.deepStrictEqual(posts[0], ['proxy', { url: 'https://api.example/api/validate', method: 'POST', body: '{"mid":"m"}' }]);
    assert.deepStrictEqual(await win.fetch('./js/main.js'), { real: './js/main.js' }, 'other requests untouched');
  });

  console.log('\n' + (failed ? 'FAILURES: ' + failed : 'ALL PASS') + '  (' + passed + ' passed, ' + failed + ' failed)');
  process.exit(failed ? 1 : 0);
})();
