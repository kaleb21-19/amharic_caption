/*
 * davinci_core.js — Amharic Captions Studio, ⬆ Export → DaVinci (1.43.0):
 * the pure part (tested in tools/test/test_davinci.js).
 *
 * DaVinci Resolve (also the free one) runs Lua scripts from its Workspace →
 * Scripts menu. The Studio installs app/amh_davinci.lua there (with the place
 * of the captions file written in) and writes the captions + the style as a
 * small Lua table; the script builds them as Text+ titles over the timeline.
 * Times stay in each video FILE's seconds: the script finds every piece of
 * the video on the timeline and places the captions of that part.
 */
(function (root) {
  'use strict';
  // the style's font id -> family name + style inside the font files (amh_styles.FONTS)
  const FONTS = {
    sans: ['Noto Sans Ethiopic', 'Bold'], menbere: ['Menbere', 'Bold'], serif: ['Noto Serif Ethiopic', 'Bold'],
    abyssinica: ['Abyssinica SIL', 'Regular'], yebse: ['Ethiopic Yebse', 'Regular'], washra: ['Ethiopic WashRa Bold', 'Regular'],
    agbalumo: ['Agbalumo', 'Regular'], tint: ['Ethiopic Tint', 'Regular'], fantuwua: ['Ethiopic Fantuwua', 'Regular'],
    jiret: ['Ethiopia Jiret', 'Regular'], hibur: ['Hibur Mono', 'Regular'], gothic: ['Ethiopic Yigezu Bisrat Gothic', 'Regular'],
  };
  const SIZES = { s: 0.8, m: 1, l: 1.2, xl: 1.45 };

  // a Lua string literal (any text: quotes, backslashes, new lines, Amharic)
  function luaStr(s) {
    return '"' + String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\0/g, '') + '"';
  }
  const num = (n) => String(Math.round(Number(n) * 1000) / 1000);
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [1, 1, 1];
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => Math.round(c / 255 * 1000) / 1000);
  }
  // the caption's words as DaVinci shows them: no *pop* marks, no ~cut~ words
  function plain(text) {
    return String(text || '').replace(/~[^~]*~/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').trim();
  }

  // the Studio style (styleOpts) -> what the script needs; y = the bottom
  // edge of the text, 0-1 from the top (the Studio's dragged height first)
  function lookFor(style, o, capY) {
    o = o || {};
    const f = FONTS[o.font] || FONTS.sans;
    const k = typeof o.size === 'number' ? o.size : (SIZES[o.size] || 1);
    const y = typeof o.y === 'number' ? o.y : (typeof capY === 'number' ? capY : null);
    return { font: f[0], style: f[1], k: Math.round(k * 100) / 100, color: rgb(o.text || '#FFFFFF'),
      pos: ['bottom', 'middle', 'top', 'safe'].indexOf(o.pos) >= 0 ? o.pos : 'bottom', y, box: !!o.box, outline: !o.box };
  }

  // the captions file: items = [{ path, cues: [{ start, end, text }] }] (file seconds)
  function dataLua(items, look, lang) {
    const L = look || {};
    const out = ['-- Amharic Captions Studio: captions for DaVinci Resolve (made ' + new Date().toISOString().slice(0, 10) + ')', 'return {',
      '  version = 1, lang = ' + luaStr(lang === 'en' ? 'en' : 'am') + ',',
      '  look = { font = ' + luaStr(L.font || 'Noto Sans Ethiopic') + ', style = ' + luaStr(L.style || 'Bold') + ', k = ' + num(L.k || 1) +
        ', color = { ' + (L.color || [1, 1, 1]).map(num).join(', ') + ' }, pos = ' + luaStr(L.pos || 'bottom') +
        (typeof L.y === 'number' ? ', y = ' + num(L.y) : '') + ', box = ' + (L.box ? 'true' : 'false') + ', outline = ' + (L.outline === false ? 'false' : 'true') + ' },',
      '  videos = {'];
    let n = 0;
    (items || []).forEach((it) => {
      const cues = (it.cues || []).map((c) => ({ a: Number(c.start), b: Number(c.end), t: plain(c.text) }))
        .filter((c) => isFinite(c.a) && isFinite(c.b) && c.b > c.a && c.t);
      if (!it.path || !cues.length) return;
      out.push('    { path = ' + luaStr(String(it.path).replace(/\\/g, '/')) + ', cues = {');
      cues.forEach((c) => out.push('      { ' + num(c.a) + ', ' + num(c.b) + ', ' + luaStr(c.t) + ' },'));
      out.push('    } },');
      n += cues.length;
    });
    out.push('  },', '}', '');
    return { text: out.join('\n'), cues: n };
  }

  // the installed script = ours with the captions file's place written in
  function withData(src, dataPath) {
    const line = 'local DATA = ' + luaStr(String(dataPath).replace(/\\/g, '/'));
    const re = /^local DATA = nil\b.*$/m;
    if (!re.test(src)) throw new Error('amh_davinci.lua: no DATA line');
    return src.replace(re, line);
  }

  // where DaVinci Resolve looks for Workspace → Scripts → (Utility) scripts
  function scriptsDir(platform, env, home, join) {
    env = env || {};
    if (platform === 'win32') {
      return env.APPDATA ? join(env.APPDATA, 'Blackmagic Design', 'DaVinci Resolve', 'Support', 'Fusion', 'Scripts', 'Utility') : '';
    }
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve', 'Fusion', 'Scripts', 'Utility');
    return join(home, '.local', 'share', 'DaVinciResolve', 'Fusion', 'Scripts', 'Utility');
  }
  // DaVinci's own settings folder: there = DaVinci is (or was) installed
  function resolveHome(platform, env, home, join) {
    env = env || {};
    if (platform === 'win32') return env.APPDATA ? join(env.APPDATA, 'Blackmagic Design', 'DaVinci Resolve') : '';
    if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Blackmagic Design', 'DaVinci Resolve');
    return join(home, '.local', 'share', 'DaVinciResolve');
  }

  const SCRIPT_NAME = 'Amharic Captions.lua';
  const api = { FONTS, luaStr, rgb, plain, lookFor, dataLua, withData, scriptsDir, resolveHome, SCRIPT_NAME };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmhDaVinci = api;
})(typeof window !== 'undefined' ? window : this);
