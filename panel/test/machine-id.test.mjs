// Panel machine-identity test. Loads the identity block OUT of the real
// panel/js/main.js (so it tests the shipped source, not a copy), stubs only the
// browser bits it needs, points the Node FS at a temp HOME via AMH_MACHINE_HOME,
// and drives the create / persist / migrate / corrupt / mismatch paths.
import { readFileSync, writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const src = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const marker = 'const MACHINE_ID = getOrCreateMachineId();';
const start = src.indexOf('// ── Machine identity');
const end = src.indexOf(marker);
assert.ok(start > 0 && end > start, 'identity markers found in main.js');
const block = src.slice(start, end + marker.length);

let store = new Map();
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
};

async function run(home, seedLocalMid) {
  store.clear();
  if (seedLocalMid) localStorage.setItem('amh.machineId', seedLocalMid);
  const ctx = { require: nodeRequire, process, console, localStorage };
  ctx.globalThis = ctx;
  ctx.window = { crypto: globalThis.crypto };
  process.env.AMH_MACHINE_HOME = home;
  vm.createContext(ctx);
  // Top-level const in a vm script is script-scoped, so export through globalThis.
  vm.runInContext(block + '\nglobalThis.__mid = { id: MACHINE_ID, mismatch: MACHINE_HOST_MISMATCH };', ctx);
  return {
    mid: ctx.__mid.id,
    mismatch: ctx.__mid.mismatch,
    file: join(home, '.amharic_captions_machine.json'),
    localStored: localStorage.getItem('amh.machineId'),
  };
}

const home = mkdtempSync(join(tmpdir(), 'amh-mid-'));
try {
  // 1) brand-new machine -> file created, id echoed to localStorage, no mismatch
  let r = await run(home);
  assert.match(r.mid, /^[0-9a-f]{16}$/, 'fresh id is 16-hex');
  assert.ok(existsSync(r.file), 'node file created');
  const first = r.mid;
  assert.equal(r.localStored, first, 'localStorage mirrors the node id');
  assert.equal(r.mismatch, false, 'fresh machine: no host mismatch');

  // 2) reload with localStorage wiped -> same id from the node file
  r = await run(home);
  assert.equal(r.mid, first, 'id survives localStorage clear');

  // 3) legacy localStorage id migrates into the node file and stays
  rmSync(r.file);
  r = await run(home, 'cafebabe');
  assert.equal(r.mid, 'cafebabe', 'legacy id adopted');
  assert.ok(existsSync(r.file), 'legacy id persisted to node file');
  r = await run(home);
  assert.equal(r.mid, 'cafebabe', 'migrated id survives reload');

  // 4) corrupt node file -> fresh id, never crashes
  writeFileSync(r.file, '{oops');
  r = await run(home);
  assert.match(r.mid, /^[0-9a-f]{16}$/, 'corrupt file falls through to fresh id');

  // A truncated primary with a valid backup must recover the paid identity.
  const recovered = r.mid;
  writeFileSync(r.file + '.bak', JSON.stringify({ id: recovered, host: null, hv: 2 }));
  writeFileSync(r.file, '{truncated');
  r = await run(home);
  assert.equal(r.mid, recovered, 'valid backup recovers a truncated machine record');
  assert.equal(JSON.parse(readFileSync(r.file, 'utf8')).id, recovered, 'primary record is healed');

  // 5) node record with a foreign host fingerprint -> mismatch flagged.
  //    hv must match HOST_FP_VERSION, otherwise the record predates the
  //    current fingerprint algorithm and is deliberately not comparable.
  writeFileSync(r.file, JSON.stringify({ id: 'deadc0de', host: '11111111', hv: 2 }));
  r = await run(home);
  assert.equal(r.mid, 'deadc0de', 'foreign-host id preserved (license still keyed to it)');
  assert.equal(r.mismatch, true, 'host mismatch detected and surfaced');

  // 6) LEGACY record (no hv): written by the old hostname-based fingerprint,
  //    which drifted with the network on macOS. It must NOT warn — otherwise
  //    every existing install shows "created on another computer" once — and
  //    it must be re-stamped in place, keeping the id so the license survives.
  writeFileSync(r.file, JSON.stringify({ id: 'feedface', host: '11111111' }));
  r = await run(home);
  assert.equal(r.mid, 'feedface', 'legacy id preserved through re-stamping');
  assert.equal(r.mismatch, false, 'legacy record must not raise a false mismatch');
  let healed = JSON.parse(readFileSync(r.file, 'utf8'));
  assert.equal(healed.id, 'feedface', 're-stamp keeps the machine id');
  assert.equal(healed.hv, 2, 're-stamped to the current fingerprint version');
  assert.match(healed.host, /^[0-9a-f]{8}$/, 're-stamped host is a real fingerprint');

  // 7) re-stamped record is stable on the next boot (no repeat warning)
  r = await run(home);
  assert.equal(r.mid, 'feedface', 'id still stable after re-stamp');
  assert.equal(r.mismatch, false, 'no mismatch on the boot after re-stamping');

  // 8) the fingerprint must not depend on os.hostname(): macOS returns
  //    Name.local / Name.lan / Name depending on the network, and that drift
  //    fired the false "another computer" warning at paying customers.
  //    Create the record under one hostname, then reload the SAME record
  //    under a different one — the record must survive without warning.
  {
    const os = nodeRequire('node:os');
    const realHostname = os.hostname;
    try {
      rmSync(r.file, { force: true });
      os.hostname = () => 'machine-on-wifi.local';
      const created = await run(home);
      const idA = created.mid;
      const recA = JSON.parse(readFileSync(created.file, 'utf8'));

      // same machine, same user, different network name
      os.hostname = () => 'machine-on-ethernet.lan';
      const reloaded = await run(home);
      const recB = JSON.parse(readFileSync(reloaded.file, 'utf8'));

      assert.equal(reloaded.mid, idA, 'machine id survives a hostname change');
      assert.equal(reloaded.mismatch, false,
        'hostname change must NOT be reported as another computer');
      assert.equal(recB.host, recA.host,
        'fingerprint is identical across hostnames (hostname is not an input)');
    } finally {
      os.hostname = realHostname;
    }
  }

  console.log('panel machine-identity: all green');
} finally {
  rmSync(home, { recursive: true, force: true });
}