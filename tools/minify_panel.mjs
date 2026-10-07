#!/usr/bin/env node
/*
 * minify_panel.mjs — the released panel / app JavaScript without comments and
 * whitespace (1.10.4).
 *
 *   node tools/minify_panel.mjs <extension folder>
 *
 * The source is written to be read: its comments explain, among everything
 * else, how licensing and the free trial work. The package customers install
 * does not need that. Rewrites <ext>/js/*.js and <ext>/app/*.js in place with
 * terser — no mangling and no compression, so every global name the other
 * files and index.html rely on stays exactly the same; only comments and
 * layout go. Strings (Amharic text, the ExtendScript snippets) are untouched.
 * CSInterface.js (Adobe's) and the ExtendScript .jsx files are left alone.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TERSER = 'terser@5.36.0';
const ext = process.argv[2];
if (!ext || !statSync(ext, { throwIfNoEntry: false })?.isDirectory()) {
  console.error('usage: node tools/minify_panel.mjs <extension folder>');
  process.exit(1);
}
const files = [];
for (const dir of ['js', 'app']) {
  const d = join(ext, dir);
  if (!statSync(d, { throwIfNoEntry: false })?.isDirectory()) continue;
  for (const f of readdirSync(d)) {
    if (f.endsWith('.js') && f !== 'CSInterface.js') files.push(join(d, f));
  }
}
let before = 0, after = 0;
for (const f of files) {
  before += statSync(f).size;
  // Windows runs npx through the shell (npx.cmd), so quote the paths there.
  const win = process.platform === 'win32';
  const q = (x) => (win ? '"' + x + '"' : x);
  execFileSync(win ? 'npx.cmd' : 'npx', ['--yes', TERSER, q(f), '-o', q(f), '--ecma', '2020', '--comments', 'false'],
    { stdio: ['ignore', 'inherit', 'inherit'], shell: win });
  // A file that no longer parses must fail the build, never ship.
  execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
  if (/\/\/ |\/\*/.test(readFileSync(f, 'utf8').replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ''))) {
    console.error('  [warn] comment-like text left in ' + f);
  }
  after += statSync(f).size;
}
console.log(`  [ok] minified ${files.length} JavaScript files (${Math.round(before / 1024)} KB -> ${Math.round(after / 1024)} KB)`);
