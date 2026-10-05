/*
 * node_shim.js — the few Node.js modules the panel uses, for the desktop app.
 *
 * Inside Premiere the panel runs in CEP, which gives it Node (require('fs'),
 * child_process, …) and Adobe's window.__adobe_cep__. The desktop app shows
 * the very same panel in a plain web view, so this file provides those pieces
 * on top of the app's local server (amh_app.py):
 *
 *   fs / os / crypto  → synchronous calls (sync XHR to /__api/sync), exactly
 *                       like Node's *Sync functions the panel relies on
 *   child_process     → spawn / execFile; output arrives by long-polling
 *                       /__api/poll and is delivered as 'data' / 'exit' events
 *   path              → pure JavaScript (Windows or POSIX rules)
 *   __adobe_cep__     → host = 'APP' (no Premiere: evalScript answers '')
 *
 * Must load before CSInterface.js and main.js.
 */
(function () {
  'use strict';
  const BOOT = window.__AMH_APP__ || {};
  const INFO = BOOT.info || {};
  const TOKEN = BOOT.token;
  const IS_WIN = INFO.platform === 'win32';

  // ── bridge ──────────────────────────────────────────────────────────────
  function call(op, args) {
    const x = new XMLHttpRequest();
    x.open('POST', '/__api/sync', false);           // synchronous, like fs.*Sync
    x.setRequestHeader('Content-Type', 'application/json');
    x.setRequestHeader('X-Amh-Token', TOKEN);
    x.send(JSON.stringify({ op, args }));
    if (x.status !== 200) throw new Error('app bridge: HTTP ' + x.status);
    const r = JSON.parse(x.responseText);
    if (r.err) {
      const e = new Error(r.err.message);
      e.code = r.err.code;
      throw e;
    }
    return r.result;
  }
  const realFetch = window.fetch.bind(window);
  function post(path, body) {
    return realFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Amh-Token': TOKEN },
      body: JSON.stringify(body),
    });
  }

  // ── license-server calls go through the app (see amh_app.py _proxy) ─────
  if (BOOT.api) {
    window.fetch = function (url, opts) {
      const u = typeof url === 'string' ? url : (url && url.url) || '';
      if (!u.startsWith(BOOT.api + '/')) return realFetch(url, opts);
      opts = opts || {};
      return realFetch('/__api/proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Amh-Token': TOKEN },
        body: JSON.stringify({ url: u, method: opts.method || 'GET', body: typeof opts.body === 'string' ? opts.body : null }),
        signal: opts.signal,
      }).then((r) => r.json()).then((r) => {
        if (r.status === 599) throw new TypeError('Failed to fetch');
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      });
    };
  }

  // ── tiny EventEmitter ───────────────────────────────────────────────────
  class Emitter {
    constructor() { this._h = {}; }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
    once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
    off(ev, fn) { this._h[ev] = (this._h[ev] || []).filter((f) => f !== fn); return this; }
    removeListener(ev, fn) { return this.off(ev, fn); }
    emit(ev, ...a) { (this._h[ev] || []).slice().forEach((f) => { try { f(...a); } catch (e) { console.error(e); } }); }
  }
  class Stream extends Emitter { setEncoding() { return this; } }

  // ── path ────────────────────────────────────────────────────────────────
  const SEP = IS_WIN ? '\\' : '/';
  const splitRe = IS_WIN ? /[\\/]+/ : /\/+/;
  function root(p) {
    if (IS_WIN) {
      const m = /^([a-zA-Z]:)?[\\/]?/.exec(p);
      if (/^[\\/]{2}[^\\/]/.test(p)) return '\\\\';            // UNC
      return m[0].replace(/\//g, '\\');
    }
    return p.startsWith('/') ? '/' : '';
  }
  function normalize(p) {
    p = String(p);
    if (!p) return '.';
    const r = root(p);
    const out = [];
    p.slice(r.length).split(splitRe).forEach((s) => {
      if (!s || s === '.') return;
      if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!r) out.push('..'); return; }
      out.push(s);
    });
    const body = out.join(SEP);
    return (r + body) || (r ? r : '.');
  }
  const path = {
    sep: SEP,
    delimiter: IS_WIN ? ';' : ':',
    normalize,
    join(...parts) { return normalize(parts.filter((x) => x !== '' && x != null).map(String).join(SEP)); },
    isAbsolute(p) { return IS_WIN ? /^([a-zA-Z]:)?[\\/]/.test(p) : String(p).startsWith('/'); },
    resolve(...parts) {
      let r = '';
      for (let i = parts.length - 1; i >= 0 && !path.isAbsolute(r); i--) r = parts[i] + (r ? SEP + r : '');
      return normalize(r);
    },
    dirname(p) {
      p = String(p);
      const r = root(p);
      const rest = p.slice(r.length).replace(IS_WIN ? /[\\/]+$/ : /\/+$/, '');
      const i = Math.max(rest.lastIndexOf('/'), IS_WIN ? rest.lastIndexOf('\\') : -1);
      if (i < 0) return r || '.';
      return r + rest.slice(0, i);
    },
    basename(p, ext) {
      const parts = String(p).replace(IS_WIN ? /[\\/]+$/ : /\/+$/, '').split(splitRe);
      let b = parts[parts.length - 1] || '';
      if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
      return b;
    },
    extname(p) { const b = path.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
  };
  path.win32 = path; path.posix = path;

  // ── fs ──────────────────────────────────────────────────────────────────
  const fs = {
    existsSync: (p) => { try { return call('existsSync', [String(p)]); } catch (e) { return false; } },
    readFileSync: (p) => call('readFileSync', [String(p)]),
    writeFileSync: (p, d, o) => { call('writeFileSync', [String(p), String(d), typeof o === 'string' ? { encoding: o } : (o || null)]); },
    unlinkSync: (p) => { call('unlinkSync', [String(p)]); },
    statSync: (p) => {
      const s = call('statSync', [String(p)]);
      return { size: s.size, mtimeMs: s.mtimeMs, mtime: new Date(s.mtimeMs),
               isFile: () => s.isFile, isDirectory: () => s.isDirectory };
    },
    readdirSync: (p) => call('readdirSync', [String(p)]),
    mkdirSync: (p, o) => { call('mkdirSync', [String(p), o || null]); },
    renameSync: (a, b) => { call('renameSync', [String(a), String(b)]); },
    copyFileSync: (a, b) => { call('copyFileSync', [String(a), String(b)]); },
    chmodSync: (p, m) => { call('chmodSync', [String(p), m]); },
  };

  // ── os / process ────────────────────────────────────────────────────────
  const os = {
    tmpdir: () => INFO.tmp,
    homedir: () => INFO.home,
    hostname: () => INFO.hostname,
    platform: () => INFO.platform,
    userInfo: () => ({ username: INFO.username, homedir: INFO.home }),
    EOL: IS_WIN ? '\r\n' : '\n',
  };
  window.process = { env: Object.assign({}, INFO.env || {}), platform: INFO.platform,
                     arch: INFO.arch, pid: INFO.pid, versions: {} };

  // ── crypto ──────────────────────────────────────────────────────────────
  const crypto = {
    randomUUID: () => window.crypto.randomUUID(),
    getRandomValues: (a) => window.crypto.getRandomValues(a),
    randomBytes: (n) => window.crypto.getRandomValues(new Uint8Array(n)),
    createHash(alg) {
      const parts = [];
      return {
        update(s) { parts.push(String(s)); return this; },
        digest() { return call('hash', [alg, parts.join('')]); },
      };
    },
  };

  // ── child_process ───────────────────────────────────────────────────────
  class Child extends Emitter {
    constructor(cmd, args, opts, collect) {
      super();
      this.stdout = new Stream();
      this.stderr = new Stream();
      this.killed = false;
      this.exitCode = null;
      this._out = []; this._err = []; this._collect = collect;
      const self = this;
      let q = Promise.resolve();
      this.stdin = {
        write(d) { if (!self.id) return false; q = q.then(() => post('/__api/stdin', { id: self.id, data: String(d) })).catch(() => {}); return true; },
        end() {},
        on() {}, once() {},
      };
      this.id = call('spawn', [cmd, args || [], (opts && opts.env) || null, (opts && opts.cwd) || null, (opts && opts.timeout) || 0]);
      this._poll(0);
    }
    kill() {
      if (this.killed) return true;
      this.killed = true;
      post('/__api/kill', { id: this.id }).catch(() => {});
      return true;
    }
    async _poll(since) {
      let failures = 0;
      for (;;) {
        let r;
        try {
          const res = await realFetch('/__api/poll?id=' + this.id + '&since=' + since, { headers: { 'X-Amh-Token': TOKEN } });
          if (res.status === 404) { this._finish(null); return; }
          r = await res.json();
          failures = 0;
        } catch (e) {
          // The app's own server stopped answering: report the child as
          // failed rather than waiting forever.
          if (++failures >= 50) { this._finish(null); return; }
          await new Promise((ok) => setTimeout(ok, 200));
          continue;
        }
        for (const ev of r.events) {
          since++;
          if (ev.t === 'stdout') { if (this._collect) this._out.push(ev.d); this.stdout.emit('data', ev.d); }
          else if (ev.t === 'stderr') { if (this._collect) this._err.push(ev.d); this.stderr.emit('data', ev.d); }
          else if (ev.t === 'exit') { this._finish(ev.code); return; }
        }
        if (r.done) { this._finish(null); return; }
      }
    }
    _finish(code) {
      if (this.exitCode !== null) return;
      this.exitCode = code === null ? -1 : code;
      this.emit('exit', this.exitCode, this.killed ? 'SIGTERM' : null);
      this.emit('close', this.exitCode, this.killed ? 'SIGTERM' : null);
    }
  }
  const child_process = {
    spawn(cmd, args, opts) {
      const c = new Child(cmd, args, opts, false);
      return c;
    },
    execFile(cmd, args, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      const c = new Child(cmd, args, opts, true);
      c.on('close', (code) => {
        if (!cb) return;
        const stdout = c._out.join(''), stderr = c._err.join('');
        if (code !== 0 || c.killed) {
          const e = new Error('Command failed: ' + cmd + (c.killed ? ' (killed)' : ' (exit ' + code + ')') +
            (stderr ? '\n' + stderr.slice(-2000) : ''));
          e.code = code; e.killed = c.killed;
          cb(e, stdout, stderr);
        } else cb(null, stdout, stderr);
      });
      return c;
    },
  };

  const MODULES = { fs, path, os, crypto, child_process };
  window.require = function (name) {
    if (MODULES[name]) return MODULES[name];
    throw new Error("Cannot find module '" + name + "'");
  };
  // main.js derives the extension folder from __dirname (= <ext>/js).
  window.__dirname = path.join(BOOT.ext, 'js');

  // ── Adobe CEP stand-in ──────────────────────────────────────────────────
  function skin() {
    const dark = !(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
    const v = dark ? 35 : 235;
    return { appBackgroundColor: { red: v, green: v, blue: v } };
  }
  window.__adobe_cep__ = {
    getHostEnvironment: () => JSON.stringify({ appName: 'APP', appVersion: '1', appSkinInfo: skin() }),
    evalScript: (script, cb) => { if (cb) setTimeout(() => cb(''), 0); },
    getSystemPath: () => BOOT.ext,
    getExtensionId: () => 'com.amharic.captions.app',
    getHostCapabilities: () => '{}',
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {},
    invokeSync: () => '', invokeAsync: () => {},
  };
  window.cep = {
    util: { openURLInDefaultBrowser: (u) => { try { call('openURL', [String(u)]); } catch (e) {} } },
    fs: {
      showOpenDialog(multi, chooseDir, title) {
        try {
          const p = call('dialog', [chooseDir ? 'folder' : 'open', title || '']);
          return p ? { err: 0, data: [p] } : { err: 0, data: [] };
        } catch (e) { return { err: 1, data: [] }; }
      },
    },
  };
  // For app_mode.js
  window.__amhApp = { call, IS_WIN, path };
})();
