/*
 * Amharic Captions — ExtendScript host layer for Premiere Pro.
 *
 * Every exported function returns a JSON string of the shape
 *   { ok: true,  ... }
 *   { ok: false, error: "message" }
 */

#include "json2.jsx"

var AMH_CAPTION_BIN = "Amharic Captions";
var AMH_TICKS_PER_SECOND = 254016000000;

function amhOk(obj) {
    obj = obj || {};
    obj.ok = true;
    return JSON.stringify(obj);
}

function amhErr(message) {
    return JSON.stringify({ ok: false, error: String(message) });
}

function amhGuard(fn) {
    try {
        return fn();
    } catch (e) {
        var where = (e.fileName ? (" [" + e.fileName + ":" + e.line + "]") : "");
        return amhErr(e.message ? (e.message + where) : e.toString());
    }
}

function amhSecondsToTicks(seconds) {
    return Math.round(parseFloat(seconds) * AMH_TICKS_PER_SECOND).toFixed(0);
}

/* ------------------------------------------------------------------ ping */

function amharic_ping() {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }
        return amhOk({ version: app.version, project: app.project.name });
    });
}

/**
 * Resolve an on-disk source path for a ProjectItem. Premiere stores media
 * paths on mediaPoolProjectItems; fall back to the display name if needed.
 */
function amhMediaPath(item) {
    if (!item) { return null; }
    try {
        var mp = item.getMediaPath();
        if (mp && mp !== "") { return mp; }
    } catch (e) {}
    return null;
}

/**
 * Dump the whole project tree with resolved media paths so we can see exactly
 * what Premiere reports. Returns { ok, lines:[...] }.
 */
function amharic_diag() {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }
        var lines = ["Project: " + app.project.name];
        amhDumpTree(app.project.rootItem, 0, lines);
        return amhOk({ lines: lines });
    });
}

function amhDumpTree(item, depth, lines) {
    if (!item || depth > 15) { return; }
    try {
        var kids = item.children;
        if (kids && kids.numItems > 0) {
            for (var i = 0; i < kids.numItems; i++) {
                var ch = kids[i];
                var name = "", t = "", p = "";
                var err = "";
                try {
                    name = ch.name;
                } catch (e) { name = "<name ERR: " + e.message + ">"; }
                try {
                    t = "type=" + ch.type;
                } catch (e) { t = "type ERR: " + e.message; }
                try {
                    var mp = ch.getMediaPath();
                    p = (mp && mp !== "") ? ("| path=" + mp) : "| path=(none)";
                } catch (e) { p = "| getMediaPath ERR: " + e.message; }
                lines.push(amhIndent(depth) + name + " [" + t + "]" + p);
                amhDumpTree(ch, depth + 1, lines);
            }
        } else {
            lines.push(amhIndent(depth) + "(leaf / no children read)");
        }
    } catch (e) {
        lines.push(amhIndent(depth) + "<children iteration ERR: " + e.message + ">");
    }
}

function amhIndent(depth) {
    var s = "";
    for (var i = 0; i < depth; i++) { s += "  "; }
    return s;
}

/**
 * Find the "current" footage. Priority:
 *   1) clip under the timeline playhead in the active sequence
 *   2) selected clip(s) in the active sequence
 *   3) first video clip on the timeline
 *   4) first clip of any open sequence
 *   5) first video media anywhere in the project tree
 * Returns rich diagnostics so failures are easy to diagnose.
 */
function amharic_findFootage() {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }

        var diag = { tries: [] };
        var seq = app.project.activeSequence;
        if (seq) {
            try { diag.sequence = seq.name; } catch (e) {}
            try { diag.videoTracks = seq.videoTracks.numTracks; } catch (e) {}
        } else {
            diag.sequence = "(none active)";
        }

        // 1) clip under the playhead (video + audio tracks)
        if (seq) {
            var ct = null;
            try { ct = seq.getPlayerPosition().seconds; } catch (e) { ct = null; }
            diag.tries.push("playhead=" + ct);
            if (ct !== null && ct !== undefined) {
                var hit = amhClipShapes(seq, function (clip) {
                    var cts = clip.start.seconds;
                    var duc = clip.duration.seconds;
                    return (ct >= cts && ct <= cts + duc + 0.05) ? clip : null;
                });
                if (hit) { return hit; }
            }
        }

        // 2) selected clip(s) in active sequence (video + audio)
        if (seq) {
            var selHit = amhClipShapes(seq, function (clip) {
                return clip.selected ? clip : null;
            });
            if (selHit) { return selHit; }
            diag.tries.push("seq-selected clips");
        }

        // 3) first clip in active sequence (video + audio)
        if (seq) {
            var firstHit = amhClipShapes(seq, function () { return undefined; }); // returns first
            if (firstHit) { return firstHit; }
            diag.tries.push("seq-first-clip");
        }

        // 4) any sequence (video + audio)
        try {
            for (var s = 0; s < app.project.sequences.numSequences; s++) {
                var aseq = app.project.sequences[s];
                var anyHit = amhClipShapes(aseq, function () { return undefined; });
                if (anyHit) { return anyHit; }
            }
        } catch (e) {}
        diag.tries.push("any-sequence");

        // 5) scan project tree (reliable; mirrors the working tree dump)
        try {
            var found = amhScanTree(app.project.rootItem, 0);
            if (found) { return amhOk({ path: found.path, name: found.name }); }
        } catch (e) {}
        diag.tries.push("project-scan");

        return amhErr("No footage with an on-disk path was found. Diagnostic: " +
                      JSON.stringify(diag) + " If a clip is on the timeline, make sure it " +
                      "links to a real file (not generated/offline media).");
    });
}

/**
 * Walk every video and audio track of a sequence; return the first clip whose
 * projectItem resolves to a path. `match(clip)` returns truthy to accept it,
 * or undefined to accept the first clip. Returns {path,name} or null.
 */
function amhClipShapes(seq, match) {
    if (!seq) { return null; }
    var collections = [];
    try { collections.push(seq.videoTracks); } catch (e) {}
    try { collections.push(seq.audioTracks); } catch (e) {}
    for (var k = 0; k < collections.length; k++) {
        try {
            for (var t = 0; t < collections[k].numTracks; t++) {
                var track = collections[k][t];
                for (var c = 0; c < track.clips.numItems; c++) {
                    var clip = track.clips[c];
                    if (!clip || !clip.projectItem) { continue; }
                    try {
                        var accepted = !match || match(clip);
                        if (accepted) {
                            var pp = amhMediaPath(clip.projectItem);
                            if (pp) { return { path: pp, name: clip.projectItem.name }; }
                        }
                    } catch (e) {}
                }
            }
        } catch (e) {}
    }
    return null;
}

/**
 * Recursively scan the project tree for the first piece of media that resolves
 * to an on-disk path. Mirrors the validated tree dump logic.
 */
function amhScanTree(item, depth) {
    if (depth > 12 || !item) { return null; }
    try {
        var p = amhMediaPath(item);
        if (p) { return { path: p, name: item.name }; }
        var kids = item.children;
        if (kids && kids.numItems > 0) {
            for (var i = 0; i < kids.numItems; i++) {
                var got = amhScanTree(kids[i], depth + 1);
                if (got) { return got; }
            }
        }
    } catch (e) {}
    return null;
}

/* -------------------------------------------------- selected-clip range */

/**
 * Read the selected timeline clip's trimmed source range and its position on
 * the timeline, so we can extract exactly that audio and offset the captions.
 *
 * Returns { sourcePath, sourceIn, duration, timelineStart, name } in seconds,
 * or ok:false if no clip is selected.
 */
function amharic_getSelectedClip() {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }

        // Find the clip. We do this in two passes:
        //   Pass 1 — only clips that are EXPLICITLY selected (across all
        //            video+audio tracks) qualify. This must not consult the
        //            playhead, otherwise an earlier unselected clip under the
        //            playhead can "win" before we reach the real selection.
        //   Pass 2 — only if nothing was selected, fall back to the clip
        //            under the playhead.
        var picked = null;
        var pickedVia = "";
        var collections = [];
        try { collections.push(seq.videoTracks); } catch (e) {}
        try { collections.push(seq.audioTracks); } catch (e) {}

        // Pass 1: explicit selection only.
        var findSelected = function () {
            for (var k = 0; k < collections.length; k++) {
                try {
                    for (var t = 0; t < collections[k].numTracks; t++) {
                        var track = collections[k][t];
                        for (var c = 0; c < track.clips.numItems; c++) {
                            var clip = track.clips[c];
                            var isSel = false;
                            try { if (clip.selected) { isSel = true; } } catch (e) {}
                            if (isSel) { return { clip: clip, via: "selected" }; }
                        }
                    }
                } catch (e) {}
            }
            return null;
        };
        var sel = findSelected();
        if (sel) {
            picked = sel.clip;
            pickedVia = sel.via;
        }

        // Pass 2: playhead fallback only when nothing was explicitly selected.
        if (!picked) {
            var playhead = null;
            try { playhead = seq.getPlayerPosition().seconds; } catch (e) { playhead = null; }
            if (playhead !== null && playhead !== undefined) {
                for (var k2 = 0; k2 < collections.length && !picked; k2++) {
                    try {
                        for (var t2 = 0; t2 < collections[k2].numTracks && !picked; t2++) {
                            var track2 = collections[k2][t2];
                            for (var c2 = 0; c2 < track2.clips.numItems && !picked; c2++) {
                                var clip2 = track2.clips[c2];
                                try {
                                    var cs = clip2.start.seconds;
                                    var cd = clip2.duration.seconds;
                                    if (playhead >= cs && playhead <= cs + cd + 0.05) {
                                        picked = clip2;
                                        pickedVia = "playhead (no explicit selection found)";
                                    }
                                } catch (e) {}
                            }
                        }
                    } catch (e) {}
                }
            }
        }

        if (!picked || !picked.projectItem) {
            return amhErr("No clip found. Select a clip on the timeline OR place the " +
                          "playhead on it, then try again.");
        }

        var src = amhMediaPath(picked.projectItem);
        if (!src) {
            return amhErr("The selected clip has no on-disk source path.");
        }

        // Read a Premiere time object (Tick) to seconds. Tick objects expose
        // .seconds in most versions, but that can be unreliable across builds;
        // fall back to .ticks / ticks-per-second. (254016000000 ticks/sec on
        // Mac, 254016000000 on Win too — Premiere uses a fixed 60fps timebase.)
        var toSec = function (timeObj) {
            if (timeObj === null || timeObj === undefined) { return null; }
            try {
                var s = Number(timeObj.seconds);
                if (!isNaN(s)) { return s; }
            } catch (e) {}
            try {
                var tk = Number(timeObj.ticks);
                if (!isNaN(tk)) { return tk / AMH_TICKS_PER_SECOND; }
            } catch (e) {}
            return null;
        };

        // For a trimmed/razored track clip the SOURCE range we must transcribe
        // is [inPoint, outPoint] in the media's timebase, and the TIMELINE
        // length is outPoint - inPoint. Reading .duration directly is less
        // reliable after trims on some versions, so prefer inPoint/outPoint.
        var sourceIn = toSec(picked.inPoint);
        var outPt    = toSec(picked.outPoint);
        if (outPt === null) { outPt = (sourceIn === null ? 0 : sourceIn) + toSec(picked.duration); }
        if (sourceIn === null) { sourceIn = 0; }
        if (outPt === null) { outPt = sourceIn + toSec(picked.duration); }
        var dur = outPt - sourceIn;
        if (!(dur > 0)) { dur = toSec(picked.duration); if (!(dur > 0)) { dur = 0; } }
        var tlStart = toSec(picked.start);
        if (tlStart === null) { tlStart = 0; }

        return amhOk({
            sourcePath: src,
            sourceIn: sourceIn,
            sourceOut: outPt,
            duration: dur,
            timelineStart: tlStart,
            name: picked.projectItem.name,
            mode: "clip",
            via: pickedVia
        });
    });
}

/* ------------------------------------------------------ whole-sequence info */

/**
 * Return every audio-bearing clip in the active sequence (in timeline order)
 * with the source range + timeline position needed to transcribe+offset each,
 * plus the sequence work-area bounds (in/out points).
 * Pass all=true to ignore the work area and return every clip.
 */
function amharic_getSequenceInfo(all) {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }

        var toSec = function (timeObj) {
            if (timeObj === null || timeObj === undefined) { return null; }
            try {
                var s = Number(timeObj.seconds);
                if (!isNaN(s)) { return s; }
            } catch (e) {}
            try {
                var tk = Number(timeObj.ticks);
                if (!isNaN(tk)) { return tk / AMH_TICKS_PER_SECOND; }
            } catch (e) {}
            return null;
        };

        // Work-area in/out (fall back to 0 / huge so everything is included).
        var inP = null, outP = null;
        try { inP = toSec(seq.getInPoint()); } catch (e) { inP = null; }
        try { outP = toSec(seq.getOutPoint()); } catch (e) { outP = null; }
        if (inP === null || isNaN(inP)) { inP = 0; }
        if (outP === null || isNaN(outP) || outP <= inP) { outP = 1e12; }

        var filterByWorkArea = !(all === true);

        var clips = [];
        var seen = {};
        var collections = [];
        try { collections.push(seq.videoTracks); } catch (e) {}
        try { collections.push(seq.audioTracks); } catch (e) {}
        for (var k = 0; k < collections.length; k++) {
            try {
                for (var t = 0; t < collections[k].numTracks; t++) {
                    var track = collections[k][t];
                    try {
                        for (var c = 0; c < track.clips.numItems; c++) {
                            var clip = track.clips[c];
                            if (!clip || !clip.projectItem) { continue; }
                            var tlStart = toSec(clip.start);
                            var sIn = toSec(clip.inPoint);
                            var outPt = toSec(clip.outPoint);
                            var dur = (outPt !== null && sIn !== null) ? (outPt - sIn) : toSec(clip.duration);
                            var src = amhMediaPath(clip.projectItem);
                            if (tlStart === null || dur === null || !(dur > 0)) { continue; }
                            if (!src) { continue; }
                            // skip clips entirely outside the work area
                            if (filterByWorkArea && ((tlStart + dur) < inP || tlStart > outP)) { continue; }
                            // avoid duplicate video+audio of the same linked clip
                            var key = src + "@" + tlStart;
                            if (seen[key]) { continue; }
                            seen[key] = true;
                            clips.push({
                                name: clip.projectItem.name,
                                sourcePath: src,
                                sourceIn: (sIn === null ? 0 : sIn),
                                duration: dur,
                                timelineStart: tlStart
                            });
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
        clips.sort(function (a, b) { return a.timelineStart - b.timelineStart; });

        return amhOk({ inPoint: inP, outPoint: outP, clips: clips });
    });
}

/* --------------------------------------------------------------- captions */

function amhFindOrCreateBin(name) {
    var root = app.project.rootItem;
    for (var i = 0; i < root.children.numItems; i++) {
        var child = root.children[i];
        if (child.name === name && child.type === 2 /* BIN */) { return child; }
    }
    return root.createBin(name);
}

function amh_importCaptions(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }

        var srt = new File(args.srtPath);
        if (!srt.exists) { return amhErr("Caption file not found: " + args.srtPath); }
        var baseName = srt.name.replace(/\.srt$/i, "");
        var bin = amhFindOrCreateBin(AMH_CAPTION_BIN);
        // Remove any pre-existing caption item with this name so a re-run
        // always lands a single, freshly-updated caption item (no duplicates,
        /// no stale content).
        amhRemoveCaptionItems(bin, baseName);

        // Import the SRT.
        var imported = app.project.importFiles([args.srtPath], true, bin, false);
        if (!imported && !amhFindCaptionItem(bin, baseName)) {
            return amhErr("Premiere refused to import the caption file.");
        }

        var captionItem = amhFindCaptionItem(bin, baseName);
        if (!captionItem) {
            return amhErr("Import reported success but no caption item was found in '" +
                          AMH_CAPTION_BIN + "' (looked for '" + baseName + "').");
        }

        var startSeconds = (args.startSeconds || 0);
        var ticks = amhSecondsToTicks(startSeconds);

        // Clear an old caption track from a previous run so re-running is clean.
        amhClearCaptionTrack(seq);

        var result = amhPlaceCaptions(seq, captionItem, ticks, startSeconds);

        // Diagnostic: read back where the caption actually landed on the
        // timeline so we can correlate "requested start" vs "real start".
        var landedStart = null, landedEnd = null;
        try {
            var cts = seq.captionTracks;
            if (cts && cts.numTracks > 0) {
                var t0 = cts[0];
                var sc = t0.clips.numItems > 0 ? t0.clips[0] : null;
                if (sc) {
                    var rd = function (to) {
                        if (!to) { return null; }
                        try { var s = Number(to.seconds); if (!isNaN(s)) { return s; } } catch (e) {}
                        try { var tk = Number(to.ticks); if (!isNaN(tk)) { return tk / AMH_TICKS_PER_SECOND; } } catch (e) {}
                        return null;
                    };
                    landedStart = rd(sc.start);
                    landedEnd = rd(sc.end);
                }
            }
        } catch (e) {}

        return amhOk({
            captionItemName: captionItem.name,
            placement: result.how,
            placed: result.placed,
            requestedStart: startSeconds,
            landedStart: landedStart,
            landedEnd: landedEnd,
            note: result.note || ""
        });
    });
}

function amhFindCaptionItem(bin, baseName) {
    try {
        for (var i = 0; i < bin.children.numItems; i++) {
            var ch = bin.children[i];
            var nm = "";
            try { nm = String(ch.name); } catch (e) {}
            if (nm.toLowerCase().indexOf(baseName.toLowerCase()) >= 0) {
                return ch;
            }
        }
    } catch (e) {}
    return null;
}

function amhRemoveCaptionItems(bin, baseName) {
    try {
        for (var i = bin.children.numItems - 1; i >= 0; i--) {
            var ch = bin.children[i];
            var nm = "";
            try { nm = String(ch.name); } catch (e) {}
            if (nm.toLowerCase().indexOf(baseName.toLowerCase()) >= 0) {
                try { ch.deleteMatchingFootage(); } catch (e) {}
                try { ch.deleteSelf(); } catch (e) {}
            }
        }
    } catch (e) {}
}

function amhClearCaptionTrack(seq) {
    try {
        var tracks = seq.captionTracks;
        if (tracks && tracks.numTracks > 0) {
            for (var i = 0; i < tracks.numTracks; i++) {
                var t = tracks[i];
                try { t.remove(); } catch (e) {}
            }
        }
    } catch (e) {}
}

function amhPlaceCaptions(seq, captionItem, startTicks, startSeconds) {
    var attempts = [];
    if (typeof seq.createCaptionTrack === "function") {
        // The 3rd arg (caption format) must be an integer constant, not a
        // string, or Premiere throws "Illegal Parameter type". Prefer the
        // subtitle format; fall back to other arities across versions.
        var fmt = null;
        try { fmt = Sequence.CAPTION_FORMAT_SUBTITLE; } catch (e) { fmt = null; }
        var forms = [];
        if (fmt !== null && fmt !== undefined) {
            forms.push({ how: "createCaptionTrack(item, ticks, CAPTION_FORMAT_SUBTITLE)",
                         run: function () { return seq.createCaptionTrack(captionItem, startTicks, fmt); } });
        }
        forms = forms.concat([
            { how: "createCaptionTrack(item, ticks, true)",
              run: function () { return seq.createCaptionTrack(captionItem, startTicks, true); } },
            { how: "createCaptionTrack(item, ticks)",
              run: function () { return seq.createCaptionTrack(captionItem, startTicks); } },
            { how: "createCaptionTrack(item, seconds)",
              run: function () { return seq.createCaptionTrack(captionItem, startSeconds); } },
            { how: "createCaptionTrack(item)",
              run: function () { return seq.createCaptionTrack(captionItem); } }
        ]);
        for (var i = 0; i < forms.length; i++) {
            try {
                var r = forms[i].run();
                if (r !== false && r !== undefined && r !== null) {
                    return { how: forms[i].how, placed: true };
                }
                attempts.push(forms[i].how + " -> returned " + r);
            } catch (e) {
                attempts.push(forms[i].how + " -> " + e.message);
            }
        }
    } else {
        attempts.push("Sequence.createCaptionTrack is not available");
    }
    return {
        how: "manual",
        placed: false,
        note: "Captions imported into '" + AMH_CAPTION_BIN + "'. Drag the caption " +
              "item onto the timeline. Details: " + attempts.join(" | ")
    };
}
