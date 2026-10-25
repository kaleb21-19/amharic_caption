/*
 * Amharic Captions - ExtendScript host layer for Premiere Pro.
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

// The media of a clip Generate may listen to: never our own styled caption
// layers ("amhstyle_..." videos the panel placed above the footage - they
// have no sound). Owner report 1.16.8: after cutting, the playhead picked the
// Glide layer instead of the video.
function amhListenPath(item) {
    var mp = amhMediaPath(item);
    if (!mp) { return null; }
    var nm = "";
    try { nm = String(item.name || ""); } catch (e) {}
    if (nm.indexOf("amhstyle_") === 0 || /[\\\/]amhstyle_[^\\\/]*$/.test(mp)) { return null; }
    return mp;
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
        //   Pass 1 - only clips that are EXPLICITLY selected (across all
        //            video+audio tracks) qualify. This must not consult the
        //            playhead, otherwise an earlier unselected clip under the
        //            playhead can "win" before we reach the real selection.
        //   Pass 2 - only if nothing was selected, fall back to the clip
        //            under the playhead.
        var picked = null;
        var pickedVia = "";
        var collections = [];
        // Audio tracks first: they carry the voice. A stock video with no
        // sound on V1 and the voice on A1 must give the voice (1.16.2).
        try { collections.push(seq.audioTracks); } catch (e) {}
        try { collections.push(seq.videoTracks); } catch (e) {}

        // Pass 1: explicit selection only.
        // A selection after cutting often also holds titles, captions,
        // adjustment layers or nested sequences: they have no media file. Take
        // the first selected clip that HAS one; only when none has, the first
        // selected item (so the error can say what it is) (1.16.7).
        var findSelected = function () {
            var first = null;
            for (var k = 0; k < collections.length; k++) {
                try {
                    for (var t = 0; t < collections[k].numTracks; t++) {
                        var track = collections[k][t];
                        for (var c = 0; c < track.clips.numItems; c++) {
                            var clip = track.clips[c];
                            var isSel = false;
                            try { if (clip.selected) { isSel = true; } } catch (e) {}
                            if (!isSel) { continue; }
                            if (clip.projectItem && amhListenPath(clip.projectItem)) {
                                return { clip: clip, via: "selected" };
                            }
                            if (!first) { first = { clip: clip, via: "selected" }; }
                        }
                    }
                } catch (e) {}
            }
            return first;
        };
        var sel = findSelected();
        if (sel) {
            picked = sel.clip;
            pickedVia = sel.via;
        }

        // Pass 2: playhead fallback only when nothing was explicitly selected.
        var nestedUnder = null;   // a nested sequence under the playhead (1.16.10)
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
                                    if (playhead >= cs && playhead <= cs + cd + 0.05 && clip2.projectItem) {
                                        if (amhListenPath(clip2.projectItem)) {
                                            picked = clip2;
                                            pickedVia = "playhead (no explicit selection found)";
                                        } else if (!nestedUnder && amhNestedSequence(clip2.projectItem)) {
                                            nestedUnder = clip2;
                                        }
                                    }
                                } catch (e) {}
                            }
                        }
                    } catch (e) {}
                }
            }
        }

        // A nested sequence (selected, or under the playhead) has no media file
        // of its own: take the clips INSIDE it for the same part of the timeline,
        // like Work Area / Whole edit do (owner report, 1.16.10).
        var nestedClip = null;
        if (picked && picked.projectItem && !amhListenPath(picked.projectItem) && amhNestedSequence(picked.projectItem)) {
            nestedClip = picked;
        } else if (!picked && nestedUnder) {
            nestedClip = nestedUnder;
        }
        if (nestedClip) {
            var nsec = function (t) {
                if (t === null || t === undefined) { return null; }
                try { var s0 = Number(t.seconds); if (!isNaN(s0)) { return s0; } } catch (e) {}
                try { var tk0 = Number(t.ticks); if (!isNaN(tk0)) { return tk0 / AMH_TICKS_PER_SECOND; } } catch (e) {}
                return null;
            };
            var nS = nsec(nestedClip.start), nE = nsec(nestedClip.end);
            if (nE === null && nS !== null) { nE = nS + (nsec(nestedClip.duration) || 0); }
            if (nS !== null && nE !== null && nE > nS) {
                var inner = amhCollectClips(seq, 0, nS, nE, 0, nsec).clips;
                var best = null;
                for (var ib = 0; ib < inner.length; ib++) {
                    if (/^amhstyle_/.test(String(inner[ib].name || ""))) { continue; }
                    if (!best || inner[ib].duration > best.duration) { best = inner[ib]; }
                }
                var alt = null;   // another file in the same part: the voice when best is a silent video
                for (var ia = 0; best && ia < inner.length; ia++) {
                    var cand = inner[ia];
                    if (cand.sourcePath === best.sourcePath || /^amhstyle_/.test(String(cand.name || ""))) { continue; }
                    if (!alt || cand.duration > alt.duration) {
                        alt = { sourcePath: cand.sourcePath, sourceIn: cand.sourceIn, duration: cand.duration,
                                timelineStart: cand.timelineStart, name: cand.name };
                    }
                }
                if (best) {
                    return amhOk({
                        sourcePath: best.sourcePath, sourceIn: best.sourceIn, sourceOut: best.sourceIn + best.duration,
                        duration: best.duration, timelineStart: best.timelineStart, timelineEnd: best.timelineEnd,
                        name: best.name, mode: "clip", via: "inside nested sequence " + nestedClip.projectItem.name,
                        audioAlt: alt
                    });
                }
            }
            return amhErr("This nested sequence has no clip with sound in that part. Open it and select the clip, or use Whole edit.");
        }

        if (!picked || !picked.projectItem) {
            return amhErr("No clip found. Select a clip on the timeline OR place the " +
                          "playhead on it, then try again.");
        }

        var src = amhListenPath(picked.projectItem);
        if (!src) {
            if (amhMediaPath(picked.projectItem)) {
                return amhErr("That is a caption layer made by Amharic Captions. Select your video or audio clip instead.");
            }
            return amhErr("The selected clip has no on-disk source path.");
        }

        // Read a Premiere time object (Tick) to seconds. Tick objects expose
        // .seconds in most versions, but that can be unreliable across builds;
        // fall back to .ticks / ticks-per-second. (254016000000 ticks/sec on
        // Mac, 254016000000 on Win too - Premiere uses a fixed 60fps timebase.)
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

        // The source range and timeline range are separate. A speed change or
        // reverse makes source seconds impossible to map with the fields
        // exposed here, so reject it explicitly instead of placing wrong cues.
        var sourceIn = toSec(picked.inPoint);
        var outPt = toSec(picked.outPoint);
        var tlStart = toSec(picked.start);
        var tlEnd = toSec(picked.end);
        var pickedDuration = toSec(picked.duration);
        if (tlEnd === null && tlStart !== null && pickedDuration !== null) {
            tlEnd = tlStart + pickedDuration;
        }
        if (tlStart === null) { tlStart = 0; }
        if (tlEnd === null || !(tlEnd > tlStart)) { return amhErr("The selected clip has no usable timeline range."); }
        var timelineDuration = tlEnd - tlStart;
        var hasSourceRange = (sourceIn !== null && outPt !== null && outPt > sourceIn);
        var sourceDuration = hasSourceRange ? (outPt - sourceIn) : timelineDuration;
        if (sourceIn === null) { sourceIn = 0; }
        if (!hasSourceRange) { outPt = sourceIn + sourceDuration; }
        var reverse = false;
        try {
            if (typeof picked.isReverse === "function") { reverse = !!picked.isReverse(); }
            else if (typeof picked.isReverse !== "undefined") { reverse = !!picked.isReverse; }
        } catch (e) {}
        if (reverse || Math.abs(sourceDuration - timelineDuration) > 0.05) {
            return amhErr("This clip has speed, retime, or reverse playback that is not supported yet.");
        }
        var dur = sourceDuration;

        // A video file may have no sound at all (screen recording, stock
        // video) while the voice is a separate clip on an audio track under
        // it. Send the audio clip that covers most of the same timeline range
        // along, so the panel can switch to it when the video has no audio
        // stream (owner report, 1.16.8). Same source/timeline mapping rules.
        var audioAlt = null;
        try {
            var at = seq.audioTracks;
            for (var ta = 0; ta < at.numTracks; ta++) {
                var trk = at[ta];
                for (var ca = 0; ca < trk.clips.numItems; ca++) {
                    var a = trk.clips[ca];
                    if (a === picked || !a.projectItem) { continue; }
                    var aPath = amhListenPath(a.projectItem);
                    if (!aPath) { continue; }
                    var aStart = toSec(a.start), aEnd = toSec(a.end), aIn = toSec(a.inPoint), aOut = toSec(a.outPoint);
                    if (aStart === null || aEnd === null || aIn === null || aOut === null) { continue; }
                    if (Math.abs((aOut - aIn) - (aEnd - aStart)) > 0.05) { continue; }   // retimed
                    var ovS = Math.max(tlStart, aStart), ovE = Math.min(tlEnd, aEnd);
                    if (!(ovE - ovS > 0.2)) { continue; }
                    if (aPath === src && Math.abs((aIn - aStart) - (sourceIn - tlStart)) < 0.05) { continue; }   // the same audio
                    if (!audioAlt || ovE - ovS > audioAlt.duration) {
                        audioAlt = { sourcePath: aPath, sourceIn: aIn + (ovS - aStart), duration: ovE - ovS,
                                     timelineStart: ovS, name: a.projectItem.name };
                    }
                }
            }
        } catch (e) { audioAlt = null; }

        return amhOk({
            sourcePath: src,
            sourceIn: sourceIn,
            sourceOut: outPt,
            duration: dur,
            timelineStart: tlStart,
            timelineEnd: tlEnd,
            name: picked.projectItem.name,
            mode: "clip",
            via: pickedVia,
            audioAlt: audioAlt
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

        // Work-area bounds. The bar the editor drags is the Work Area bar
        // (workAreaBarStart/End). Sequence getInPoint()/getOutPoint() are the
        // separate In/Out MARKERS - reading those made "Work Area" silently
        // transcribe the whole edit (or the marker span) instead of the bar,
        // which is exactly what a customer reports as "doesn't work".
        var inP = null, outP = null;
        try { inP = toSec(seq.workAreaBarStart); } catch (e) { inP = null; }
        try { outP = toSec(seq.workAreaBarEnd); } catch (e) { outP = null; }
        // If Premiere does not expose the bar on this build, fall back to the
        // sequence In/Out points; last resort is the full timeline.
        if (inP === null || isNaN(inP)) { try { inP = toSec(seq.getInPoint()); } catch (e) { inP = null; } }
        if (outP === null || isNaN(outP) || outP <= inP) { try { outP = toSec(seq.getOutPoint()); } catch (e) { outP = null; } }
        if (inP === null || isNaN(inP)) { inP = 0; }
        if (outP === null || isNaN(outP) || outP <= inP) { outP = 1e12; }

        var filterByWorkArea = !(all === true);
        var lo = filterByWorkArea ? inP : -1e12;
        var hi = filterByWorkArea ? outP : 1e12;
        var found = amhCollectClips(seq, 0, lo, hi, 0, toSec);
        var clips = found.clips;
        clips.sort(function (a, b) { return a.timelineStart - b.timelineStart; });

        // Nothing to caption: say WHY, so the panel can tell the editor what
        // to do instead of "no clips" (customer report, 1.10.15).
        var seqName = '';
        try { seqName = String(seq.name || ''); } catch (e) { seqName = ''; }
        var result = { inPoint: inP, outPoint: outP, clips: clips, unsupported: found.unsupported,
                       noMedia: found.noMedia, sequence: seqName };
        if (!clips.length && filterByWorkArea) {
            var everything = amhCollectClips(seq, 0, -1e12, 1e12, 0, toSec);
            if (everything.clips.length) {
                var first = 1e12, last = 0;
                for (var i = 0; i < everything.clips.length; i++) {
                    first = Math.min(first, everything.clips[i].timelineStart);
                    last = Math.max(last, everything.clips[i].timelineEnd);
                }
                result.outside = { count: everything.clips.length, first: first, last: last };
            }
        }
        return amhOk(result);
    });
}

// Is this ProjectItem a sequence (a nested sequence or multicam on the
// timeline)? Returns that Sequence, or null.
function amhNestedSequence(item) {
    if (!item) { return null; }
    var isSeq = false;
    try { isSeq = typeof item.isSequence === "function" && !!item.isSequence(); } catch (e) {}
    if (!isSeq) { return null; }
    try {
        var all = app.project.sequences;
        for (var i = 0; i < all.numSequences; i++) {
            var s = all[i];
            try {
                if (s && s.projectItem && (s.projectItem === item ||
                        (item.nodeId && s.projectItem.nodeId === item.nodeId))) { return s; }
            } catch (e) {}
        }
    } catch (e) {}
    return null;
}

/**
 * Every clip of `seq` with a media file, in OUTER timeline seconds.
 * shift: inner time + shift = outer time. Only [lo, hi] (outer time) is
 * used. A nested sequence (a sequence used as a clip) is opened and its own
 * clips are taken, up to 4 levels deep - before 1.10.15 a nested sequence
 * had no media path and was silently skipped, so an edit made of nested
 * sequences gave "no clips".
 */
function amhCollectClips(seq, shift, lo, hi, depth, toSec) {
    var out = { clips: [], unsupported: [], noMedia: 0 };
    var seen = {};
    var walk = function (sq, sh, a, b, d) {
        var collections = [];
        try { collections.push(sq.videoTracks); } catch (e) {}
        try { collections.push(sq.audioTracks); } catch (e) {}
        for (var k = 0; k < collections.length; k++) {
            try {
                for (var t = 0; t < collections[k].numTracks; t++) {
                    var track = collections[k][t];
                    try {
                        for (var c = 0; c < track.clips.numItems; c++) {
                            var clip = track.clips[c];
                            if (!clip || !clip.projectItem) { continue; }
                            var tlStart = toSec(clip.start);
                            var tlEnd = toSec(clip.end);
                            var timelineDuration = toSec(clip.duration);
                            if (tlEnd === null && tlStart !== null && timelineDuration !== null) {
                                tlEnd = tlStart + timelineDuration;
                            }
                            if (tlStart === null || tlEnd === null || !(tlEnd > tlStart)) { continue; }
                            timelineDuration = tlEnd - tlStart;

                            var sIn = toSec(clip.inPoint);
                            var sOut = toSec(clip.outPoint);
                            var hasSourceRange = (sIn !== null && sOut !== null && sOut > sIn);
                            var sourceDuration = hasSourceRange ? (sOut - sIn) : timelineDuration;
                            if (sIn === null) { sIn = 0; }

                            var reverse = false;
                            try {
                                if (typeof clip.isReverse === "function") { reverse = !!clip.isReverse(); }
                                else if (typeof clip.isReverse !== "undefined") { reverse = !!clip.isReverse; }
                            } catch (e) {}
                            try {
                                if (!reverse && typeof clip.projectItem.isReverse === "function") {
                                    reverse = !!clip.projectItem.isReverse();
                                }
                            } catch (e) {}

                            var oStart = tlStart + sh, oEnd = tlEnd + sh;
                            var segStart = Math.max(oStart, a);
                            var segEnd = Math.min(oEnd, b);
                            if (!(segEnd > segStart)) { continue; }

                            var nested = amhNestedSequence(clip.projectItem);
                            var src = nested ? null : amhListenPath(clip.projectItem);
                            // our own styled caption layer: not footage, skip quietly (1.16.10)
                            if (!nested && !src && amhMediaPath(clip.projectItem)) { continue; }
                            if (!nested && !src) { out.noMedia++; continue; }

                            // A source duration that differs from the timeline
                            // duration means a speed change/retime. We cannot
                            // map source seconds to timeline seconds correctly
                            // from these fields, so skip it explicitly rather
                            // than placing captions at the wrong times.
                            if (reverse || Math.abs(sourceDuration - timelineDuration) > 0.05) {
                                out.unsupported.push({
                                    name: clip.projectItem.name,
                                    reason: reverse ? "reverse playback" : "speed/retime mapping"
                                });
                                continue;
                            }

                            if (nested) {
                                // Inner time x shows at outer time oStart + (x - sIn).
                                if (d < 4 && nested !== sq) { walk(nested, oStart - sIn, segStart, segEnd, d + 1); }
                                else { out.noMedia++; }
                                continue;
                            }

                            var clippedSourceIn = sIn + (segStart - oStart);
                            var clippedDuration = segEnd - segStart;
                            // Linked video/audio instances share this key. A
                            // different trim at the same timeline position is
                            // intentionally a separate clip.
                            var key = src + "|" + segStart.toFixed(3) + "|" +
                                clippedSourceIn.toFixed(3) + "|" + clippedDuration.toFixed(3);
                            if (seen[key]) { continue; }
                            seen[key] = true;
                            out.clips.push({
                                name: clip.projectItem.name,
                                sourcePath: src,
                                sourceIn: clippedSourceIn,
                                duration: clippedDuration,
                                timelineStart: segStart,
                                timelineEnd: segEnd
                            });
                        }
                    } catch (e) {}
                }
            } catch (e) {}
        }
    };
    walk(seq, shift, lo, hi, depth);
    return out;
}

/**
 * Styled captions (1.11): the frame size and frame rate of the active
 * sequence, so the transparent caption layer is rendered to match it.
 */
function amharic_getFrame() {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var w = 0, h = 0, fps = 0;
        try { w = Number(seq.frameSizeHorizontal); h = Number(seq.frameSizeVertical); } catch (e) {}
        try {
            var st = seq.getSettings();
            if (st) {
                if (!w || !h) { w = Number(st.videoFrameWidth); h = Number(st.videoFrameHeight); }
                var fr = st.videoFrameRate;
                var secs = fr ? Number(fr.seconds) : 0;
                if (secs > 0) { fps = 1 / secs; }
            }
        } catch (e) {}
        if (!(fps > 0)) {
            try {
                var tb = Number(seq.timebase);
                if (tb > 0) { fps = AMH_TICKS_PER_SECOND / tb; }
            } catch (e) {}
        }
        if (!(w > 0 && h > 0)) { return amhErr("Could not read the sequence frame size."); }
        if (!(fps > 0)) { fps = 30; }
        return amhOk({ width: w, height: h, fps: fps });
    });
}

// A video track with nothing on it between start and end (seconds).
function amhTrackFree(track, start, end) {
    try {
        for (var c = 0; c < track.clips.numItems; c++) {
            var cl = track.clips[c];
            var s = Number(cl.start.seconds), e = Number(cl.end.seconds);
            if (s < end && e > start) { return false; }
        }
    } catch (err) { return false; }
    return true;
}

// Import a styled caption file into our bin and return its project item.
function amhImportCaptionFile(filePath) {
    var f = new File(filePath);
    if (!f.exists) { return { error: "Styled caption file not found: " + filePath }; }
    var bin = amhFindOrCreateBin(AMH_CAPTION_BIN);
    var fileName = String(filePath).replace(/\\/g, "/").split("/").pop();
    var ok = app.project.importFiles([filePath], true, bin, false);
    if (!ok) { return { error: "Premiere refused to import the styled caption file." }; }
    var item = amhCaptionItem(fileName);
    if (!item) { return { error: "The styled caption file was imported but could not be found in the bin." }; }
    return { item: item };
}
function amhCaptionItem(fileName) {
    var bin = amhFindOrCreateBin(AMH_CAPTION_BIN);
    for (var i = bin.children.numItems - 1; i >= 0; i--) {
        var ch = bin.children[i];
        if (ch && String(ch.name) === fileName) { return ch; }
    }
    return null;
}

// Placing again (after an edit) replaces: our earlier styled clips for the
// same captions (file name starts with prefix) in this time range are taken
// off the timeline first. Nothing else is ever touched.
function amhRemoveStyled(seq, prefix, start, end) {
    var removed = 0;
    var pre = String(prefix || "");
    if (!(pre.length > 9 && pre.indexOf("amhstyle_") === 0)) { return 0; }
    var vts = seq.videoTracks;
    for (var r = 0; r < vts.numTracks; r++) {
        try {
            for (var k = vts[r].clips.numItems - 1; k >= 0; k--) {
                var cl = vts[r].clips[k];
                var nm = "";
                try { nm = String(cl.projectItem.name || ""); } catch (e) {}
                if (nm.indexOf(pre) !== 0) { continue; }
                var cs = Number(cl.start.seconds), ce = Number(cl.end.seconds);
                // Only a layer MOSTLY inside the new captions' time is the
                // same captions placed before; a neighbouring cut part of the
                // same video only touches it and stays (owner report, 1.16.12).
                var ov = Math.min(ce, end) - Math.max(cs, start);
                if (ce > cs && ov > 0.5 * (ce - cs)) {
                    try { cl.remove(false, false); removed++; } catch (e) {}
                }
            }
        } catch (e) {}
    }
    return removed;
}

// The first empty video track ABOVE every track with something between
// start and end (a track is added when there is none); prefer = a track
// index to use when it is free (an update goes back where it was).
function amhStyledTarget(seq, start, end, prefer) {
    var tracks = seq.videoTracks;
    if (prefer >= 0 && prefer < tracks.numTracks && amhTrackFree(tracks[prefer], start, end)) {
        return { target: prefer, added: false };
    }
    var top = -1;
    for (var t = 0; t < tracks.numTracks; t++) {
        if (!amhTrackFree(tracks[t], start, end)) { top = t; }
    }
    var target = -1;
    for (var u = top + 1; u < tracks.numTracks; u++) {
        if (amhTrackFree(tracks[u], start, end)) { target = u; break; }
    }
    var added = false;
    if (target < 0) {
        try {
            app.enableQE();
            qe.project.getActiveSequence().addTracks(1, tracks.numTracks, 0);
            added = true;
        } catch (e) {}
        tracks = seq.videoTracks;
        if (added && tracks.numTracks > 0 && amhTrackFree(tracks[tracks.numTracks - 1], start, end)) {
            target = tracks.numTracks - 1;
        }
    }
    return { target: target, added: added };
}

/**
 * Put the transparent styled-caption video (args.path) on the timeline at
 * args.startSeconds, on the first empty video track ABOVE every track that
 * has something in that time range (a new track is added when there is none).
 * One layer for all the captions (the fallback since 1.27.0).
 */
function amh_placeOverlay(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var start = Number(args.startSeconds || 0);
        var end = start + Number(args.duration || 0);
        var imp = amhImportCaptionFile(args.path);
        if (imp.error) { return amhErr(imp.error); }
        var removed = amhRemoveStyled(seq, args.replacePrefix, start, end);
        var tg = amhStyledTarget(seq, start, end, -1);
        if (tg.target < 0) {
            return amhErr("No empty video track above your video. Add one video track (right-click the track headers > Add Track), then press Place again.");
        }
        seq.videoTracks[tg.target].overwriteClip(imp.item, start);
        return amhOk({ placed: true, track: tg.target + 1, addedTrack: tg.added, replaced: removed, itemName: String(imp.item.name) });
    });
}

// -- Styled captions as one clip per phrase (1.27.0) ------------------------------
// Each caption on screen is its own clip (move, trim, delete it on its own),
// cut from one rendered file with the project item's in / out points. The
// scripting guide gives the in point in ticks and the out point in seconds,
// so both are tried and read back; the way that works is remembered.
var AMH_RANGE_WAY = -1;
function amhSetRange(item, a, b) {
    var ways = [
        function () { item.setInPoint(a, 4); item.setOutPoint(b, 4); },
        function () { item.setInPoint(amhSecondsToTicks(a), 4); item.setOutPoint(amhSecondsToTicks(b), 4); },
        function () { item.setInPoint(amhSecondsToTicks(a), 4); item.setOutPoint(b, 4); }
    ];
    var order = AMH_RANGE_WAY >= 0 ? [AMH_RANGE_WAY] : [0, 1, 2];
    for (var k = 0; k < order.length; k++) {
        try {
            ways[order[k]]();
            var gi = Number(item.getInPoint().seconds), go = Number(item.getOutPoint().seconds);
            if (Math.abs(gi - a) < 0.02 && Math.abs(go - b) < 0.06) { AMH_RANGE_WAY = order[k]; return true; }
        } catch (e) {}
    }
    return false;
}
function amhClearRange(item) {
    try { item.clearInPoint(); } catch (e) {}
    try { item.clearOutPoint(); } catch (e) {}
}

// args: { path, rangeStart, rangeEnd, replacePrefix, preferTrack (1-based, optional) }
// -> imports the file, removes our earlier clips in the range, picks the track.
function amh_overlayPrepare(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var start = Number(args.rangeStart || 0), end = Number(args.rangeEnd || 0);
        var imp = amhImportCaptionFile(args.path);
        if (imp.error) { return amhErr(imp.error); }
        var removed = amhRemoveStyled(seq, args.replacePrefix, start, end);
        var tg = amhStyledTarget(seq, start, end, Number(args.preferTrack || 0) - 1);
        if (tg.target < 0) {
            return amhErr("No empty video track above your video. Add one video track (right-click the track headers > Add Track), then press Place again.");
        }
        return amhOk({ itemName: String(imp.item.name), track: tg.target + 1, addedTrack: tg.added, replaced: removed });
    });
}

// args: { itemName, track (1-based), base (sequence seconds of the file's 0),
// spans: [[a, b], ...] (file seconds) } -> one clip per span. The first clip
// is checked: if Premiere ignored the in / out points it is taken off and
// { ok: false, range: true } tells the panel to place one layer instead.
function amh_overlaySpans(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var item = amhCaptionItem(String(args.itemName));
        if (!item) { return amhErr("The styled caption file is not in the bin any more."); }
        var track = seq.videoTracks[Number(args.track) - 1];
        if (!track) { return amhErr("The caption track is gone."); }
        var base = Number(args.base || 0);
        var spans = args.spans || [];
        var placed = 0;
        try {
            for (var i = 0; i < spans.length; i++) {
                var a = Number(spans[i][0]), b = Number(spans[i][1]);
                if (!(b > a)) { continue; }
                if (!amhSetRange(item, a, b)) {
                    return JSON.stringify({ ok: false, range: true, placed: placed, error: "Premiere did not take the caption in / out points." });
                }
                track.overwriteClip(item, base + a);
                if (placed === 0 && args.check) {
                    // the clip just placed must be this phrase only
                    var got = null;
                    for (var c = 0; c < track.clips.numItems; c++) {
                        var cl = track.clips[c];
                        if (Math.abs(Number(cl.start.seconds) - (base + a)) < 0.05) { got = cl; }
                    }
                    var len = got ? Number(got.end.seconds) - Number(got.start.seconds) : -1;
                    if (!got || Math.abs(len - (b - a)) > 0.1) {
                        if (got) { try { got.remove(false, false); } catch (e) {} }
                        return JSON.stringify({ ok: false, range: true, placed: 0, error: "Premiere placed the whole file, not the caption (" + len + " s)." });
                    }
                }
                placed++;
            }
        } finally {
            amhClearRange(item);
        }
        return amhOk({ placed: placed });
    });
}

// args: { replacePrefix, rangeStart, rangeEnd } -> our styled clips mostly in
// that range are taken off (a caption deleted in the panel).
function amh_removeStyledRange(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        return amhOk({ removed: amhRemoveStyled(seq, args.replacePrefix, Number(args.rangeStart || 0), Number(args.rangeEnd || 0)) });
    });
}

// The styled caption clip selected on the timeline (ours: its file name starts
// with amhstyle_), so the panel can open that caption for editing.
function amh_selectedStyled() {
    return amhGuard(function () {
        var seq = app.project.activeSequence;
        if (!seq) { return amhOk({ none: true }); }
        var sel = [];
        try { sel = seq.getSelection() || []; } catch (e) { sel = []; }
        for (var i = 0; i < sel.length; i++) {
            var nm = "";
            try { nm = String(sel[i].projectItem.name || ""); } catch (e) {}
            if (nm.indexOf("amhstyle_") === 0) {
                return amhOk({ name: nm, start: Number(sel[i].start.seconds), end: Number(sel[i].end.seconds) });
            }
        }
        return amhOk({ none: true });
    });
}

/**
 * Move the playhead of the active sequence to a given time (seconds).
 * Used by the review step so a click on a caption jumps the timeline there.
 */
function amharic_seekPlayhead(secondsJSON) {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var sec = Number(JSON.parse(secondsJSON));
        if (isNaN(sec) || !isFinite(sec) || sec < 0) { return amhErr("Bad time: " + secondsJSON); }

        // Ticks are the safest unit across Premiere versions/timebases.
        var ticks = amhSecondsToTicks(sec);
        var attempts = [];
        var done = false;
        try { seq.setCurrentTime(ticks, true); done = true; } catch (e) { attempts.push("setCurrentTime(ticks, true) -> " + e.message); }
        if (!done) {
            try { seq.setCurrentTime(ticks); done = true; } catch (e) { attempts.push("setCurrentTime(ticks) -> " + e.message); }
        }
        if (!done) {
            try { seq.setTimeDisplay(ticks); done = true; } catch (e) { attempts.push("setTimeDisplay -> " + e.message); }
        }
        if (!done) {
            return amhErr("Could not move the playhead. Attempts: " + attempts.join(" | "));
        }
        return amhOk({ seconds: sec, ticks: ticks });
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
        // baseName is the clean, human-facing label used to find/remove caption
        // items (e.g. "mehari"), so recreating with a uniquely-named temp SRT
        // file never leaves stale or duplicate items in the bin.
        var baseName = (args.baseName || "").replace(/\.srt$/i, "") || "captions";
        // Premiere names the imported caption item after the SRT *file's* base
        // name (e.g. "amh_captions_169387..."), NOT after our human label. So we
        // must also match by the file base name, otherwise the lookup fails and
        // the captions never get placed (Selected Clip bug).
        var srtBase = (String(args.srtPath || "").replace(/\\/g, "/").split("/").pop() || "")
                          .replace(/\.srt$/i, "");
        var bin = amhFindOrCreateBin(AMH_CAPTION_BIN);
        // Keep the previous caption track and bin items until the replacement
        // has imported AND Premiere confirms placement. Destructive cleanup is
        // intentionally deferred until after amhPlaceCaptions() succeeds.

        // Import the SRT. Do not fall back to an old item with the same name:
        // deferred cleanup means stale extension items can still be in the bin.
        var imported = app.project.importFiles([args.srtPath], true, bin, false);
        if (!imported) return amhErr("Premiere refused to import the caption file.");
        var importedItem = null;
        try {
            if (typeof imported.length === "number" && imported.length > 0) {
                for (var ii = imported.length - 1; ii >= 0; ii--) {
                    var candidate = imported[ii];
                    var candidateName = "";
                    try { candidateName = String(candidate.name || ""); } catch (e) {}
                    if (amhIsCaptionItem(candidate) || /\.(srt|vtt)$/i.test(candidateName)) {
                        importedItem = candidate;
                        break;
                    }
                }
                if (!importedItem) importedItem = imported[imported.length - 1];
            }
        } catch (e) {}

        // Find the imported item by (in order) human label, SRT file base name,
        // or the most recently added caption item as a last resort.
        // Find the caption item. The human label (baseName) can COLLIDE with a
        // media clip's name - a caption on a Selected Clip is labeled with the
        // clip's name (e.g. "Tiktok.mp3"), and the clip itself lives in this bin,
        // so a baseName lookup can silently hand Sequence.createCaptionTrack the
        // *media clip*, which makes it return false (no error thrown). Prefer the
        // SRT file base name first - it uniquely names the imported caption item
        // (amh_review_*/amh_file_*/amh_captions_*) - and only accept a baseName
        // match when it's caption-typed or .srt/.vtt-named.
        var captionItem = importedItem;
        var firstMatch = null;
        var tryFind = function (name) {
            var it = amhFindCaptionItem(bin, name);
            if (!it) { return null; }
            if (firstMatch === null) { firstMatch = it; }
            var nm = "";
            try { nm = String(it.name || ""); } catch (e) {}
            if (amhIsCaptionItem(it) || /\.(srt|vtt)$/i.test(nm)) { return it; }
            return null;
        };
        captionItem = captionItem || tryFind(srtBase) || tryFind(baseName) || firstMatch;
        if (!captionItem) {
            try { captionItem = amhFindLastCaptionItem(bin); } catch (e) {}
        }
        if (!captionItem) {
            return amhErr("Import reported success but no caption item was found in '" +
                          AMH_CAPTION_BIN + "' (looked for '" + baseName + "' / '" + srtBase + "').");
        }
        // Windows quirk: with suppressUI=true an .srt sometimes lands in the bin
        // as a PLAIN clip. Only when we found nothing caption-ish do we risk a UI
        // re-import (caption files usually import without a dialog anyway) and
        // pick a genuine caption item if one then appears.
        {
            var foundN = "";
            try { foundN = String(captionItem.name || ""); } catch (e) {}
            if (!amhIsCaptionItem(captionItem) && !/\.(srt|vtt)$/i.test(foundN)) {
                try {
                    var reimported = app.project.importFiles([args.srtPath], false, bin, false);
                    if (reimported && typeof reimported.length === "number" && reimported.length > 0) {
                        importedItem = reimported[reimported.length - 1];
                        for (var ri = reimported.length - 1; ri >= 0; ri--) {
                            var rc = reimported[ri];
                            var rn = "";
                            try { rn = String(rc.name || ""); } catch (e) {}
                            if (amhIsCaptionItem(rc) || /\.(srt|vtt)$/i.test(rn)) {
                                importedItem = rc;
                                break;
                            }
                        }
                    }
                    captionItem = importedItem || tryFind(srtBase) || tryFind(baseName) || firstMatch;
                } catch (e) {}
            }
        }

        var startSeconds = (args.startSeconds || 0);
        var ticks = amhSecondsToTicks(startSeconds);

        var result = amhPlaceCaptions(seq, captionItem, ticks, startSeconds);

        if (result.placed) {
            // Transactional cleanup: the new caption is live first. Only then
            // remove old extension-owned tracks/items, and never the current
            // unique import name.
            amhClearCaptionTrack(seq, baseName, srtBase, srtBase);
            amhRemoveCaptionItems(bin, baseName, srtBase);
            amhRemoveCaptionItems(bin, "amh_captions_", srtBase);
            amhRemoveCaptionItems(bin, "amh_sequence_", srtBase);
            amhRemoveCaptionItems(bin, "amh_file_", srtBase);
            amhRemoveCaptionItems(bin, "amh_review_", srtBase);
        } else {
            // Placement failed: remove only the exact unused import we just
            // created. Existing captions remain untouched.
            amhDeleteImportedItem(captionItem);
        }

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
            captionItemName: (function () { try { return String(captionItem && captionItem.name || ""); } catch (e) { return ""; } })(),
            placement: result.how,
            placed: result.placed,
            requestedStart: startSeconds,
            landedStart: landedStart,
            landedEnd: landedEnd,
            note: result.note || "",
            diag: {
                captionItemName: (function () {
                    try { return String(captionItem.name || ""); } catch (e) { return ""; }
                })(),
                isCaptionItem: !!amhIsCaptionItem(captionItem),
                footageType: (function () {
                    try { return String(captionItem.footage ? captionItem.footage.type : ""); } catch (e) { return ""; }
                })(),
                videoComp: (function () {
                    try { return String(captionItem.videoComponent ? captionItem.videoComponent.name : ""); } catch (e) { return ""; }
                })(),
                captionTracks: (function () {
                    try { return seq.captionTracks ? seq.captionTracks.numTracks : -1; } catch (e) { return -1; }
                })(),
                seqName: (function () {
                    try { return String(seq.name || ""); } catch (e) { return ""; }
                })(),
                premVer: (function () {
                    try { return String(app.version || ""); } catch (e) { return ""; }
                })()
            }
        });
    });
}

function amhFindCaptionItem(bin, baseName) {
    // Only exact/generated names are eligible. Substring matching could select
    // a media clip whose name happens to contain a user's label.
    var target = String(baseName || "").toLowerCase();
    var found = null;
    try {
        for (var i = 0; i < bin.children.numItems; i++) {
            var ch = bin.children[i];
            var nm = "";
            try { nm = String(ch.name || ""); } catch (e) {}
            var lower = nm.toLowerCase();
            var exact = lower === target || lower === target + ".srt" || lower === target + ".vtt";
            var generated = target.indexOf("amh_") === 0 && lower.indexOf(target) === 0;
            if ((exact || generated) && amhIsCaptionItem(ch)) found = ch;
        }
    } catch (e) {}
    return found;
}

function amhIsCaptionItem(ch) {
    try {
        var nm0 = String(ch.name || "");
        if (/\.(srt|vtt)$/i.test(nm0)) return true;
    } catch (e) {}
    try {
        // Caption items in PPRO have a media type/tapeline of caption; inspect
        // the footage type if exposed, else fall back to name heuristics below.
        var ft = ch.footage ? ch.footage.type : null;
        if (ft !== null && ft !== undefined) {
            var t = String(ft);
            if (t.toLowerCase().indexOf("caption") >= 0) { return true; }
        }
    } catch (e) {}
    try {
        var et = ch.videoComponent ? String(ch.videoComponent.name).toLowerCase() : "";
        if (et.indexOf("caption") >= 0) { return true; }
    } catch (e) {}
    return false;
}

function amhFindLastCaptionItem(bin) {
    // Last resort: return the most recently added caption-matching item.
    var found = null;
    try {
        for (var i = bin.children.numItems - 1; i >= 0; i--) {
            var ch = bin.children[i];
            var nm = "";
            try { nm = String(ch.name).toLowerCase(); } catch (e) {}
            if (amhIsCaptionItem(ch) || (nm.indexOf("amh_") === 0 && nm.indexOf(".srt") >= 0)) {
                found = ch;
                break;
            }
        }
    } catch (e) {}
    return found;
}

function amhCanonicalCaptionName(name) {
    var n = String(name || "").toLowerCase();
    n = n.replace(/\.(srt|vtt)$/, "");
    return n;
}

function amhForEachSequence(fn) {
    var seen = [];
    var complete = true;
    function sameObject(a, b) {
        for (var i = 0; i < seen.length; i++) if (seen[i] === a) return true;
        return false;
    }
    function visit(seq) {
        if (!seq || sameObject(seq)) return;
        seen.push(seq);
        try {
            if (fn(seq) === false) complete = false;
        } catch (e) { complete = false; }
    }
    try {
        var project = app && app.project;
        if (!project) return { complete: false, count: 0 };
        var root = project.rootItem;
        var walk = function (container) {
            if (!container) { complete = false; return; }
            var children;
            try { children = container.children; } catch (e) { complete = false; return; }
            if (!children) return; // ordinary media/leaf project item
            if (typeof children.numItems !== 'number') { complete = false; return; }
            for (var i = 0; i < children.numItems; i++) {
                var child;
                try { child = children[i]; } catch (e) { complete = false; continue; }
                var isSequence = false;
                var hasCaptionField = false;
                try {
                    var trackValue = child.captionTracks;
                    hasCaptionField = trackValue !== undefined;
                    isSequence = !!trackValue;
                } catch (e) { complete = false; }
                if (isSequence) visit(child);
                else if (hasCaptionField) complete = false;
                else walk(child);
            }
        };
        walk(root);

        // Some Premiere versions expose unsaved/non-active sequences only via
        // project.sequences. Include them rather than assuming the root tree is
        // complete.
        try {
            var sequences = project.sequences;
            if (sequences) {
                if (typeof sequences.numItems !== 'number') complete = false;
                else for (var si = 0; si < sequences.numItems; si++) {
                    try { visit(sequences[si]); } catch (e) { complete = false; }
                }
            }
        } catch (e) { complete = false; }

        // The active sequence can be outside the project-item tree until saved.
        try { if (project.activeSequence) visit(project.activeSequence); }
        catch (e) { complete = false; }
        return { complete: complete, count: seen.length };
    } catch (e) { return { complete: false, count: seen.length }; }
}

// A bin item is unsafe to remove if any sequence in the project references it.
// Checking only app.project.activeSequence used to delete a caption still used
// by another sequence. Any incomplete Premiere API view is treated as a
// possible reference and therefore blocks deletion.
function amhCaptionItemIsReferenced(item) {
    if (!item) return false;
    var target = amhCanonicalCaptionName(item.name);
    if (!target) return true; // unnamed/ambiguous item: fail closed
    var found = false;
    var scan = amhForEachSequence(function (seq) {
        if (found) return true;
        try {
            var tracks = seq.captionTracks;
            if (!tracks || typeof tracks.numTracks !== 'number') return false;
            for (var i = 0; i < tracks.numTracks; i++) {
                var track = tracks[i];
                var clips = track && track.clips;
                if (!clips || typeof clips.numItems !== 'number') return false;
                for (var j = 0; j < clips.numItems; j++) {
                    var pj;
                    try { pj = clips[j].projectItem; } catch (e) { return false; }
                    if (!pj) return false;
                    if (pj === item || amhCanonicalCaptionName(pj.name) === target) {
                        found = true;
                        return true;
                    }
                }
            }
            return true;
        } catch (e) { return false; }
    });
    // If Premiere could not expose every sequence/track/clip, fail closed.
    if (!scan || !scan.complete || !scan.count) return true;
    return found;
}

function amhRemoveCaptionItems(bin, baseName, keepName) {
    try {
        var wanted = amhCanonicalCaptionName(baseName);
        var keep = amhCanonicalCaptionName(keepName);
        var isGenerated = wanted.indexOf("amh_") === 0;
        for (var i = bin.children.numItems - 1; i >= 0; i--) {
            var ch = bin.children[i];
            var lower = amhCanonicalCaptionName(ch.name);
            if (keep && lower === keep) { continue; }

            // Prefix cleanup is intentionally limited to our generated names.
            // Human labels use exact matching, never substring matching against
            // arbitrary media/project items.
            var owned = isGenerated
                ? lower.indexOf(wanted) === 0
                : (lower === wanted);
            if (!owned || !amhIsCaptionItem(ch) || amhCaptionItemIsReferenced(ch)) { continue; }
            amhDeleteImportedItem(ch);
        }
    } catch (e) {}
}

// Delete an exact item created by this extension. Never use
// deleteMatchingFootage(): that API can remove unrelated project/media items.
// If Premiere refuses deleteSelf, leave the item in the bin for manual review.
function amhDeleteImportedItem(item) {
    if (!item || !amhIsCaptionItem(item) || amhCaptionItemIsReferenced(item)) return false;
    try { item.deleteSelf(); return true; } catch (e) { return false; }
}

// Non-destructive: remove a caption track only when every clip is known to be
// extension-owned. A track containing one user clip is never removed.
function amhCaptionTrackIsOurs(t, baseName, srtBase, keepSrtBase) {
    try {
        var clips = t && t.clips;
        if (!clips || clips.numItems < 1) return false;
        var wantedBase = amhCanonicalCaptionName(baseName);
        var wantedSrt = amhCanonicalCaptionName(srtBase);
        var keep = amhCanonicalCaptionName(keepSrtBase);
        for (var i = 0; i < clips.numItems; i++) {
            var ci = clips[i];
            var pj = null;
            try { pj = ci.projectItem; } catch (e) { pj = null; }
            if (!pj || !amhIsCaptionItem(pj)) return false;
            var nm = pj ? String(pj.name || "") : "";
            if (nm === "") {
                try { nm = String(ci.name || ""); } catch (e) { nm = ""; }
            }
            var canonical = amhCanonicalCaptionName(nm);
            if (!canonical) return false;
            if (keep && canonical === keep) return false;
            var generated = canonical.indexOf("amh_captions_") === 0 ||
                canonical.indexOf("amh_sequence_") === 0 ||
                canonical.indexOf("amh_file_") === 0 ||
                canonical.indexOf("amh_review_") === 0;
            if (generated && pj && !amhIsCaptionItem(pj)) return false;
            if (!generated && canonical !== wantedBase && canonical !== wantedSrt) return false;
        }
        return true;
    } catch (e) {}
    return false;
}

// Take our previous captions off the timeline after a new set was placed.
// Premiere's scripting Track has no remove() - only TrackItem does - so the
// old `t.remove()` threw, the catch swallowed it, and every re-place stacked
// one more caption track: each word showed twice (three times after a third
// try). Users reported "duplicated words" on their first tries. Remove the
// track's clips instead; an empty caption track shows nothing. Walk the
// tracks backwards so a removal cannot shift the next one past the loop.
function amhClearCaptionTrack(seq, baseName, srtBase, keepSrtBase) {
    try {
        var tracks = seq.captionTracks;
        if (!tracks || !(tracks.numTracks > 0)) return;
        for (var i = tracks.numTracks - 1; i >= 0; i--) {
            var t = tracks[i];
            try {
                if (!amhCaptionTrackIsOurs(t, baseName, srtBase, keepSrtBase)) continue;
                var removed = false;
                if (typeof t.remove === "function") {
                    try { t.remove(); removed = true; } catch (e) {}
                }
                if (!removed) {
                    for (var k = t.clips.numItems - 1; k >= 0; k--) {
                        try { t.clips[k].remove(false, false); } catch (e) {}
                    }
                }
            } catch (e) {}
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
        // The documented, current signature is (captionItem, startSeconds, format)
        // - start in SECONDS (a raw TickTime as the 2nd arg reads as ~26 trillion
        // seconds and Premiere caps it), 3rd arg an integer constant, NOT a
        // string/boolean ("Illegal Parameter type" otherwise). Try seconds far
        // ahead of ticks so every modern version gets the correct unit first.
        if (fmt !== null && fmt !== undefined) {
            forms.push({ how: "createCaptionTrack(item, seconds, CAPTION_FORMAT_SUBTITLE)",
                         run: function () { return seq.createCaptionTrack(captionItem, startSeconds, fmt); } });
            forms.push({ how: "createCaptionTrack(item, ticks, CAPTION_FORMAT_SUBTITLE)",
                         run: function () { return seq.createCaptionTrack(captionItem, startTicks, fmt); } });
        }
        forms = forms.concat([
            { how: "createCaptionTrack(item, seconds)",
              run: function () { return seq.createCaptionTrack(captionItem, startSeconds); } },
            { how: "createCaptionTrack(item, ticks)",
              run: function () { return seq.createCaptionTrack(captionItem, startTicks); } },
            { how: "createCaptionTrack(item, ticks, true)",
              run: function () { return seq.createCaptionTrack(captionItem, startTicks, true); } },
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

/* ------------------------------------------------------------ clean-up cut */

// Clean-up cut (1.16.20): take the given time ranges (pauses, repeated takes,
// hesitation sounds the editor ticked) out of the timeline and close the gaps,
// on every track, so picture, sound, music and titles stay in sync.
// Never on the editor's own sequence: it is copied first and the COPY is cut
// and opened; the original stays exactly as it was. Times are timeline
// seconds; args = { cuts: [[start, end], ...], media: [paths the captions were
// made from] }.
function amhCleanupTc(seq, seconds) {
    var t = new Time();
    t.seconds = seconds;
    var st = seq.getSettings();
    return t.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
}

function amhCleanupTracks(seq) {
    var out = [];
    var v = seq.videoTracks, a = seq.audioTracks;
    for (var i = 0; i < v.numTracks; i++) { out.push({ kind: "v", i: i, track: v[i] }); }
    for (var j = 0; j < a.numTracks; j++) { out.push({ kind: "a", i: j, track: a[j] }); }
    return out;
}

// Same file? (Windows/macOS paths: slash direction and letter case differ
// between Premiere's answers.)
function amhCleanupKey(p) {
    return String(p || "").replace(/\\/g, "/").toLowerCase();
}

// Does the sequence use one of these files - directly, or inside a nested
// sequence (up to 4 levels; owner report 1.16.20: the captions were made
// from a nested sequence's video, the check only looked at the top level).
function amhCleanupHasMedia(seq, wantSet, depth) {
    if (!seq || depth > 4) { return false; }
    var tracks = amhCleanupTracks(seq);
    for (var w = 0; w < tracks.length; w++) {
        var cl = tracks[w].track.clips;
        for (var k = 0; k < cl.numItems; k++) {
            var item = null;
            try { item = cl[k].projectItem; } catch (e) {}
            var mp = amhMediaPath(item);
            if (mp && wantSet[amhCleanupKey(mp)]) { return true; }
            var inner = amhNestedSequence(item);
            if (inner && inner !== seq && amhCleanupHasMedia(inner, wantSet, depth + 1)) { return true; }
        }
    }
    return false;
}

// 1.74: which clips lie under edit time t (every track): [{ name, media, nested }]
function amhCleanupUnder(seq, t) {
    var out = [];
    var tracks = amhCleanupTracks(seq);
    for (var w = 0; w < tracks.length; w++) {
        var cl = tracks[w].track.clips;
        var k = amhCleanupFirstAfter(cl, t);
        if (k >= cl.numItems) { continue; }
        var it = cl[k];
        var s0 = Number(it.start.seconds);
        if (s0 > t) { continue; }
        var item = null;
        try { item = it.projectItem; } catch (e) {}
        out.push({ name: amhClipName(it), media: amhMediaPath(item) || "", nested: !!amhNestedSequence(item), kind: tracks[w].kind });
    }
    return out;
}

// A cut must fall on the clip the captions were made from (owner report: with
// several clips, "Edit with text" cut another clip). If one does not, nothing
// is cut and the editor is told which clip it would have hit.
function amhCleanupCheckCuts(seq, cuts, wantSet) {
    var fmt = function (x) { var m = Math.floor(x / 60), r = x - m * 60; return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1); };
    for (var i = 0; i < cuts.length; i++) {
        var mid = (cuts[i][0] + cuts[i][1]) / 2;
        var under = amhCleanupUnder(seq, mid);
        var ours = false, other = "";
        for (var u = 0; u < under.length; u++) {
            if (under[u].nested || (under[u].media && wantSet[amhCleanupKey(under[u].media)])) { ours = true; break; }
            if (!other && under[u].media && under[u].kind === "v") { other = under[u].name; }
            if (!other && under[u].media) { other = under[u].name; }
        }
        if (!ours) {
            return { at: fmt(cuts[i][0]) + "-" + fmt(cuts[i][1]), other: other };
        }
    }
    return null;
}

function amhClipName(cl) {
    try { return String(cl.name || (cl.projectItem && cl.projectItem.name) || ""); } catch (e) { return ""; }
}

// Seconds -> frame-exact cuts, sorted (a cut between two frames leaves a
// sliver; a cut under 2 frames is dropped).
function amhCleanupFrames(raw, fps) {
    var cuts = [];
    for (var c = 0; c < (raw || []).length; c++) {
        var s = Math.ceil(Number(raw[c][0]) * fps - 0.001) / fps;
        var e = Math.floor(Number(raw[c][1]) * fps + 0.001) / fps;
        if (e - s >= 2 / fps) { cuts.push([s, e]); }
    }
    cuts.sort(function (x, y) { return x[0] - y[0]; });
    return cuts;
}

function amhCleanupFps() {
    try { var fr = JSON.parse(amharic_getFrame()); if (fr.ok && fr.fps > 0) { return fr.fps; } } catch (e) {}
    return 30;
}

// First clip (index) of a track that ends after t. Premiere keeps a track's
// clips in time order, so this is a binary search: a few reads instead of
// walking the whole track (1.16.22: walking every track after every cut made
// 200 cuts take ~8 million reads).
function amhCleanupFirstAfter(clips, t) {
    var lo = 0, hi = clips.numItems;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        if (Number(clips[mid].end.seconds) > t) { hi = mid; } else { lo = mid + 1; }
    }
    return lo;
}

// One cut [a, b] on the open sequence, every track: razor both edges, take
// out what lies inside (ripple closes the gap), and if a track's later clips
// did not move with it (a Premiere version that leaves the gap), move them.
function amhCleanupOne(seq, a, b, fps) {
    var eps = 0.5 / fps, len = b - a;
    app.enableQE();
    var qseq = qe.project.getActiveSequence();
    var tcA = amhCleanupTc(seq, a), tcB = amhCleanupTc(seq, b);
    var vN = seq.videoTracks.numTracks, aN = seq.audioTracks.numTracks;
    for (var vi = 0; vi < vN; vi++) { try { qseq.getVideoTrackAt(vi).razor(tcB); qseq.getVideoTrackAt(vi).razor(tcA); } catch (e) {} }
    for (var ai = 0; ai < aN; ai++) { try { qseq.getAudioTrackAt(ai).razor(tcB); qseq.getAudioTrackAt(ai).razor(tcA); } catch (e) {} }
    var tracks = amhCleanupTracks(seq);
    var removed = 0, moved = 0;
    for (var t = 0; t < tracks.length; t++) {
        var track = tracks[t].track;
        var cl = track.clips;
        var inside = [], next = null;
        for (var k = amhCleanupFirstAfter(cl, a + eps); k < cl.numItems; k++) {
            var it = cl[k];
            var s = Number(it.start.seconds), e = Number(it.end.seconds);
            if (s >= b - eps) { next = { name: amhClipName(it), s: s }; break; }
            if (s >= a - eps && e <= b + eps) { inside.push(it); }
        }
        for (var r = inside.length - 1; r >= 0; r--) {
            try { inside[r].remove(true, true); removed++; } catch (e) {}
        }
        if (!next) { continue; }
        cl = track.clips;
        var j = amhCleanupFirstAfter(cl, next.s - eps);
        if (j < cl.numItems && Math.abs(Number(cl[j].start.seconds) - next.s) < eps && amhClipName(cl[j]) === next.name) {
            for (var m = j; m < cl.numItems; m++) {
                var shift = new Time();
                shift.seconds = -len;
                try { cl[m].move(shift); moved++; } catch (e) {}
            }
        }
    }
    return { removed: removed, moved: moved, len: len };
}

// Step 1: checks, then copy the sequence and open the copy. Nothing is cut
// yet. args = { cuts: [[start, end], ...], media: [paths] }.
function amh_cleanupPrepare(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        if (!app || !app.project) { return amhErr("No project is open."); }
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var fps = amhCleanupFps();
        var cuts = amhCleanupFrames(args.cuts, fps);
        if (!cuts.length) { return amhErr("Nothing to cut."); }

        // The open sequence must be the one these captions were made from.
        var want = args.media || [];
        if (want.length) {
            var wantSet = {};
            for (var m = 0; m < want.length; m++) { wantSet[amhCleanupKey(want[m])] = true; }
            if (!amhCleanupHasMedia(seq, wantSet, 0)) {
                return amhErr("The open sequence is not the one these captions were made from. Open that sequence, then press Cut again.");
            }
        }
        if (want.length) {
            var bad = amhCleanupCheckCuts(seq, cuts, wantSet);
            if (bad) {
                return amhErr("The cut at " + bad.at + " would remove part of " + (bad.other ? "\"" + bad.other + "\"" : "an empty part of the timeline") +
                              ", not the clip these captions were made from. Nothing was cut. Transcribe the clip again (select it, then Generate) and try again.");
            }
        }
        var tracks = amhCleanupTracks(seq);
        for (var L = 0; L < tracks.length; L++) {
            var locked = false;
            try { locked = tracks[L].track.isLocked(); } catch (e) {}
            if (locked) { return amhErr("A track is locked. Unlock all tracks (the lock icons), then press Cut again."); }
        }

        var before = {};
        for (var q = 0; q < app.project.sequences.numSequences; q++) { before[String(app.project.sequences[q].sequenceID)] = true; }
        var origName = String(seq.name);
        seq.clone();
        var copy = null;
        for (var r = 0; r < app.project.sequences.numSequences; r++) {
            var sq = app.project.sequences[r];
            if (!before[String(sq.sequenceID)]) { copy = sq; }
        }
        if (!copy) { return amhErr("Premiere could not copy the sequence. Nothing was cut."); }
        try { copy.name = origName + " - clean"; } catch (e) {}
        app.project.openSequence(copy.sequenceID);
        seq = app.project.activeSequence;
        if (!seq || String(seq.sequenceID) !== String(copy.sequenceID)) {
            return amhErr("Premiere could not open the copy of the sequence. Nothing was cut.");
        }
        return amhOk({ sequence: String(seq.name), sequenceID: String(seq.sequenceID), original: origName, fps: fps, list: cuts });
    });
}

// Step 2 (called again and again, so the panel can show progress and stop):
// some of the cuts, on the copy only. args = { sequenceID, fps, cuts }.
function amh_cleanupSome(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        var seq = app.project.activeSequence;
        if (!seq || String(seq.sequenceID) !== String(args.sequenceID)) {
            return amhErr("The clean copy is no longer the open sequence. Open it, then press Cut again.");
        }
        var fps = Number(args.fps) > 0 ? Number(args.fps) : amhCleanupFps();
        var cuts = args.cuts || [];
        var removed = 0, moved = 0, total = 0;
        for (var n = cuts.length - 1; n >= 0; n--) {          // last first: earlier times stay valid
            var r = amhCleanupOne(seq, Number(cuts[n][0]), Number(cuts[n][1]), fps);
            removed += r.removed; moved += r.moved; total += r.len;
        }
        return amhOk({ cuts: cuts.length, removed: removed, moved: moved, removedSeconds: Math.round(total * 1000) / 1000 });
    });
}

// Everything in one call (older panels).
function amh_cleanupCut(argsJSON) {
    return amhGuard(function () {
        var p = JSON.parse(amh_cleanupPrepare(argsJSON));
        if (!p.ok) { return JSON.stringify(p); }
        var s = JSON.parse(amh_cleanupSome(JSON.stringify({ sequenceID: p.sequenceID, fps: p.fps, cuts: p.list })));
        if (!s.ok) { return JSON.stringify(s); }
        return amhOk({ sequence: p.sequence, original: p.original, cuts: p.list.length,
                       removedSeconds: s.removedSeconds, removed: s.removed, moved: s.moved, list: p.list });
    });
}

/* ------------------------------------------------------------- auto zoom */

// Auto zoom (1.16.23): a zoom on the video at the moments that matter (a
// starred word, numbers, money). Scale keyframes on the clip's Motion effect,
// relative to the clip's own scale (a 9:16 reframe at 56% zooms from 56%).
// On a copy of the sequence ("<name> - zoom") - except on our own "- clean" /
// "- zoom" copy, which is zoomed as it is. A clip that already has its own
// Scale animation is never touched.
// args = { moments: [{ start, word, end }], style: "smooth"|"punch",
//          strength: 110|115|125, media: [paths] }

// Copy the sequence, name the copy, open it. Returns the open copy or an
// error text (nothing changed then).
function amhCopyAndOpen(seq, suffix) {
    var before = {};
    for (var q = 0; q < app.project.sequences.numSequences; q++) { before[String(app.project.sequences[q].sequenceID)] = true; }
    var origName = String(seq.name);
    seq.clone();
    var copy = null;
    for (var r = 0; r < app.project.sequences.numSequences; r++) {
        var sq = app.project.sequences[r];
        if (!before[String(sq.sequenceID)]) { copy = sq; }
    }
    if (!copy) { return { error: "Premiere could not copy the sequence. Nothing was changed." }; }
    try { copy.name = origName + suffix; } catch (e) {}
    app.project.openSequence(copy.sequenceID);
    var open = app.project.activeSequence;
    if (!open || String(open.sequenceID) !== String(copy.sequenceID)) {
        return { error: "Premiere could not open the copy of the sequence. Nothing was changed." };
    }
    return { seq: open };
}

// The Scale property of a clip's Motion effect (by internal name first: the
// display names are translated in a non-English Premiere).
function amhZoomScaleProp(clip) {
    var comps = null;
    try { comps = clip.components; } catch (e) { return null; }
    if (!comps) { return null; }
    for (var i = 0; i < comps.numItems; i++) {
        var c = comps[i];
        var mn = "", dn = "";
        try { mn = String(c.matchName || ""); dn = String(c.displayName || ""); } catch (e) {}
        if (mn === "AE.ADBE Motion" || dn === "Motion") {
            var props = c.properties;
            for (var j = 0; j < props.numItems; j++) {
                var pn = "";
                try { pn = String(props[j].displayName || ""); } catch (e) {}
                if (pn === "Scale") { return props[j]; }
            }
            return props.numItems > 1 ? props[1] : null;      // Position, Scale, ...
        }
    }
    return null;
}

// The picture at timeline second t: the clip on the LOWEST video track there
// (the footage; titles, B-roll and our styled captions sit above it).
function amhZoomClipAt(seq, t, eps) {
    var vt = seq.videoTracks;
    for (var v = 0; v < vt.numTracks; v++) {
        var cl = vt[v].clips;
        var k = amhCleanupFirstAfter(cl, t + eps);
        if (k >= cl.numItems) { continue; }
        var it = cl[k];
        if (Number(it.start.seconds) > t + eps) { continue; }
        var nm = amhClipName(it);
        if (nm.indexOf("amhstyle_") === 0) { continue; }
        var item = null;
        try { item = it.projectItem; } catch (e) {}
        var nested = false;
        try { nested = !!(item && typeof item.isSequence === "function" && item.isSequence()); } catch (e) {}
        if (amhMediaPath(item) || nested) { return it; }
    }
    return null;
}

function amh_autoZoom(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        if (!app || !app.project) { return amhErr("No project is open."); }
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var moments = args.moments || [];
        if (!moments.length) { return amhErr("Nothing to zoom."); }
        var want = args.media || [];
        if (want.length) {
            var wantSet = {};
            for (var m = 0; m < want.length; m++) { wantSet[amhCleanupKey(want[m])] = true; }
            if (!amhCleanupHasMedia(seq, wantSet, 0)) {
                return amhErr("The open sequence is not the one these captions were made from. Open that sequence, then try again.");
            }
        }
        var origName = String(seq.name);
        var copied = false;
        if (!/ - (clean|zoom)$/.test(origName)) {
            var c = amhCopyAndOpen(seq, " - zoom");
            if (c.error) { return amhErr(c.error); }
            seq = c.seq;
            copied = true;
        }
        var fps = amhCleanupFps(), f = 1 / fps, eps = 0.5 / fps;
        var z = Number(args.strength) > 100 && Number(args.strength) <= 150 ? Number(args.strength) / 100 : 1.15;
        var punch = args.style === "punch";
        var done = 0, animated = 0, noClip = 0;
        var ours = {}, base = {};
        for (var n = 0; n < moments.length; n++) {
            var mo = moments[n];
            var clip = amhZoomClipAt(seq, Number(mo.word), eps);
            if (!clip) { noClip++; continue; }
            var prop = amhZoomScaleProp(clip);
            if (!prop) { noClip++; continue; }
            var cs = Number(clip.start.seconds), ce = Number(clip.end.seconds), cin = Number(clip.inPoint.seconds);
            var key = amhClipName(clip) + "@" + cs;
            if (!ours[key]) {
                var tv = false;
                try { tv = !!prop.isTimeVarying(); } catch (e) {}
                if (tv) { animated++; continue; }             // the editor's own animation stays
                base[key] = Number(prop.getValue());
                if (!(base[key] > 0)) { base[key] = 100; }
                prop.setTimeVarying(true);
                ours[key] = true;
            }
            var b = base[key], zz = Math.round(b * z * 100) / 100;
            var src = function (t) { return cin + (t - cs); };      // keyframe times are the clip's own (source) time
            var a = Math.max(Number(mo.start), cs);
            var w = Math.min(Math.max(Number(mo.word), cs + f), ce - 2 * f);
            var e = Math.min(Number(mo.end), ce - f);
            if (e <= w) { e = Math.min(w + 1, ce - f); }
            var keys = punch
                ? [[w - f, b], [w, zz], [e, zz], [e + f, b]]
                : [[a, b], [e, zz], [e + f, b]];
            for (var k = 0; k < keys.length; k++) {
                var kt = keys[k][0];
                if (kt < cs - eps || kt > ce + eps) { continue; }
                var st = src(kt);
                prop.addKey(st);
                prop.setValueAtKey(st, keys[k][1], true);
            }
            done++;
        }
        return amhOk({ sequence: String(seq.name), copied: copied, original: origName,
                       zoomed: done, animated: animated, noClip: noClip });
    });
}

// -- Footage search (1.75) ------------------------------------------------------
// Every video / audio file of the project (for the panel to listen to once,
// in the background), at most 2000.
function amh_projectMedia() {
    return amhGuard(function () {
        if (!app || !app.project) { return amhErr("No project is open."); }
        var out = [], seen = {};
        var walk = function (item, depth) {
            if (!item || depth > 20 || out.length >= 2000) { return; }
            var kids = null;
            try { kids = item.children; } catch (e) {}
            if (kids && kids.numItems > 0) {
                for (var i = 0; i < kids.numItems && out.length < 2000; i++) { walk(kids[i], depth + 1); }
                return;
            }
            if (amhNestedSequence(item)) { return; }
            var p = amhListenPath(item);
            if (!p) { return; }
            var key = amhCleanupKey(p);
            if (seen[key]) { return; }
            seen[key] = true;
            var nm = "";
            try { nm = String(item.name || ""); } catch (e) {}
            out.push({ path: p, name: nm });
        };
        walk(app.project.rootItem, 0);
        return amhOk({ media: out });
    });
}

// The project item of a file (imported first when the project does not have it).
function amhFindItemByPath(item, key, depth) {
    if (!item || depth > 20) { return null; }
    var kids = null;
    try { kids = item.children; } catch (e) {}
    if (kids && kids.numItems > 0) {
        for (var i = 0; i < kids.numItems; i++) {
            var got = amhFindItemByPath(kids[i], key, depth + 1);
            if (got) { return got; }
        }
        return null;
    }
    var p = amhMediaPath(item);
    return p && amhCleanupKey(p) === key ? item : null;
}

// A found moment onto the open sequence at the playhead: seconds [start, end]
// of the file, on the first video track (from V2 up) whose part there is
// free - and its audio track too - so nothing already edited is covered.
function amh_insertFound(argsJSON) {
    return amhGuard(function () {
        var a = JSON.parse(argsJSON);
        if (!app || !app.project) { return amhErr("No project is open."); }
        var seq = app.project.activeSequence;
        if (!seq) { return amhErr("No active sequence. Open one first."); }
        var key = amhCleanupKey(a.path);
        var item = amhFindItemByPath(app.project.rootItem, key, 0);
        if (!item) {
            try { app.project.importFiles([String(a.path)], true, app.project.rootItem, false); } catch (e) {}
            item = amhFindItemByPath(app.project.rootItem, key, 0);
        }
        if (!item) { return amhErr("Premiere could not import " + a.path); }
        var start = Number(a.start) || 0, end = Number(a.end) || 0;
        if (!(end > start)) { return amhErr("Nothing to put."); }
        var at = 0;
        try { at = Number(seq.getPlayerPosition().seconds) || 0; } catch (e) {}
        var len = end - start;
        var free = function (track) {
            if (!track) { return true; }
            var cl = track.clips;
            for (var k = 0; k < cl.numItems; k++) {
                var s = Number(cl[k].start.seconds), e = Number(cl[k].end.seconds);
                if (s < at + len - 0.001 && e > at + 0.001) { return false; }
            }
            return true;
        };
        var vN = seq.videoTracks.numTracks, aN = seq.audioTracks.numTracks;
        var video = !!a.video;
        var pick = -1;
        for (var t = video ? 1 : 0; t < (video ? vN : aN); t++) {
            var vt = video ? seq.videoTracks[t] : null, at2 = t < aN ? seq.audioTracks[t] : null;
            if ((video ? free(vt) : true) && free(at2)) { pick = t; break; }
        }
        if (pick < 0) { return amhErr("No free track at the playhead. Add a track (or move the playhead), then try again."); }
        try { item.setInPoint(start, 4); item.setOutPoint(end, 4); } catch (e) {}
        var placed = false;
        try {
            var track = video ? seq.videoTracks[pick] : seq.audioTracks[pick];
            track.overwriteClip(item, at);
            placed = true;
        } catch (e2) {}
        try { item.clearInPoint(); item.clearOutPoint(); } catch (e3) {}
        if (!placed) { return amhErr("Premiere did not place the clip."); }
        return amhOk({ track: (video ? "V" : "A") + (pick + 1), at: at, len: len });
    });
}
