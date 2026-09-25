import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../jsx/host.jsx', import.meta.url), 'utf8')
  .replace(/^#include[^\n]*\n/m, '');

function collection(items) {
  const c = { numItems: items.length };
  items.forEach((item, i) => { c[i] = item; });
  return c;
}
function caption(name) {
  return {
    name,
    footage: { type: 'Caption' },
    deleteSelf() { this.deleted = true; },
  };
}
function clip(projectItem) { return { projectItem }; }
function sequence(name, tracks) {
  const captionTracks = collection(tracks);
  captionTracks.numTracks = tracks.length;
  return { name, captionTracks };
}
function track(items) { return { clips: collection(items.map(clip)) }; }

const shared = caption('amh_review_shared.srt');
const stale = caption('amh_review_stale.srt');
const user = caption('user captions.srt');
const seqA = sequence('A', [track([shared])]);
const seqB = sequence('B', [track([shared])]);
const mixed = track([shared, user]);
const root = { children: collection([seqA, seqB]) };
const context = {
  app: { project: { rootItem: root, activeSequence: seqA }, version: '2024' },
  Sequence: { CAPTION_FORMAT_SUBTITLE: 1 },
  JSON,
  console,
};
vm.createContext(context);
vm.runInContext(source, context);

assert.equal(context.amhCaptionItemIsReferenced(shared), true,
  'caption referenced by another sequence must be protected');
assert.equal(context.amhCaptionTrackIsOurs(seqA.captionTracks[0], 'amh_review_shared', 'amh_review_shared', ''), true,
  'all-extension track is recognized');
assert.equal(context.amhCaptionTrackIsOurs(mixed, 'amh_review_shared', 'amh_review_shared', ''), false,
  'mixed user/extension track is never removed');
assert.equal(context.amhDeleteImportedItem(shared), false,
  'referenced caption is not deleted');
assert.equal(shared.deleted, undefined, 'referenced caption remains in the project');
assert.equal(context.amhDeleteImportedItem(stale), true,
  'unreferenced extension caption can be removed');
assert.equal(stale.deleted, true, 'unreferenced caption deleteSelf is called');
const media = { name: 'amh_review_shared.mp4', deleteSelf() { this.deleted = true; } };
assert.equal(context.amhDeleteImportedItem(media), false,
  'unreferenced media is never deleted by caption cleanup');
assert.equal(media.deleted, undefined, 'media item remains untouched');
assert.equal(context.amhFindCaptionItem({ children: collection([{ name: 'amh_review_shared.srt.mp4' }]) }, 'amh_review_shared'), null,
  'substring media names are not treated as caption items');

// If Premiere exposes an unreadable sequence/track, cleanup must not infer
// that an unreferenced item is safe to delete.
const unknown = caption('amh_review_unknown.srt');
const badSequence = {};
Object.defineProperty(badSequence, 'captionTracks', { get() { throw new Error(' Premiere API unavailable '); } });
root.children[2] = badSequence;
root.children.numItems = 3;
assert.equal(context.amhCaptionItemIsReferenced(unknown), true,
  'inaccessible Premiere state is treated as potentially referenced');
assert.equal(context.amhDeleteImportedItem(unknown), false,
  'cleanup refuses deletion when project state is incomplete');
assert.equal(unknown.deleted, undefined, 'unknown caption remains untouched');

console.log('host safety: all green');
