/*
 * Amharic Captions — ExtendScript host layer for After Effects.
 *
 * Loaded by main.js (via $.evalFile) only when the panel runs inside After
 * Effects, AFTER host.jsx. It redefines the same six entry points the panel
 * calls, returning the same JSON shapes as the Premiere versions, so the
 * panel's transcription / review / license code is shared unchanged:
 *
 *   amharic_ping, amharic_diag, amharic_findFootage,
 *   amharic_getSelectedClip, amharic_getSequenceInfo,
 *   amharic_seekPlayhead, amh_importCaptions
 *
 * Mapping: a Premiere sequence is the active composition; a timeline clip is
 * a footage layer (layer.inPoint/outPoint are comp times, layer.startTime is
 * where source time 0 sits in the comp); the Work Area is the comp work area.
 *
 * Captions are placed as ONE text layer whose Source Text changes at each cue
 * (Source Text keyframes always hold). One layer stays fast even for karaoke
 * (a word per cue) and is easy to restyle or animate. The whole placement is a
 * single undo step, and an earlier caption layer for the same clip is removed
 * only after the new one exists.
 *
 * Relies on JSON from json2.jsx and amhOk/amhErr/amhGuard from host.jsx.
 */

var AMH_AE_TAG = "amh-captions:";
// Placement counter for this session: part of each caption layer's unique tag.
var AMH_AE_SEQ = 0;

function amhAeComp() {
    var item = app.project ? app.project.activeItem : null;
    return (item && item instanceof CompItem) ? item : null;
}

function amhAeNoComp() {
    return amhErr("No active composition. Open your comp and click its timeline, then try again.");
}

function amhAeFootagePath(layer) {
    try {
        var src = layer.source;
        if (src && src instanceof FootageItem && src.file) { return src.file.fsName; }
    } catch (e) {}
    return null;
}

function amhAeHasAudio(layer) {
    try { return !!(layer.hasAudio && layer.audioEnabled !== false); } catch (e) { return false; }
}

function amhAeRetimed(layer) {
    try {
        if (layer.timeRemapEnabled) { return "time remapping"; }
        if (Math.abs(layer.stretch - 100) > 0.01) { return layer.stretch < 0 ? "reverse playback" : "speed/stretch"; }
    } catch (e) {}
    return null;
}

/* ------------------------------------------------------------------ ping */

function amharic_ping() {
    return amhGuard(function () {
        if (!app.project) { return amhErr("No project is open."); }
        var name = "";
        try { name = app.project.file ? app.project.file.name : "Untitled Project"; } catch (e) {}
        return amhOk({ version: app.version, project: name, host: "AEFT" });
    });
}

function amharic_diag() {
    return amhGuard(function () {
        if (!app.project) { return amhErr("No project is open."); }
        var lines = ["After Effects " + app.version];
        var comp = amhAeComp();
        lines.push("Active comp: " + (comp ? comp.name + " (" + comp.numLayers + " layers)" : "(none)"));
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            var p = "";
            try { p = (it instanceof FootageItem && it.file) ? "| path=" + it.file.fsName : "| path=(none)"; } catch (e) {}
            lines.push("  " + it.name + " [" + it.typeName + "]" + p);
        }
        return amhOk({ lines: lines });
    });
}

/* ------------------------------------------------------- footage lookup */

function amharic_findFootage() {
    return amhGuard(function () {
        if (!app.project) { return amhErr("No project is open."); }
        var comp = amhAeComp();
        if (comp) {
            var sel = comp.selectedLayers;
            for (var s = 0; s < sel.length; s++) {
                var sp = amhAeFootagePath(sel[s]);
                if (sp) { return amhOk({ path: sp, name: sel[s].source.name }); }
            }
            for (var i = 1; i <= comp.numLayers; i++) {
                var lp = amhAeFootagePath(comp.layer(i));
                if (lp) { return amhOk({ path: lp, name: comp.layer(i).source.name }); }
            }
        }
        for (var j = 1; j <= app.project.numItems; j++) {
            var it = app.project.item(j);
            try {
                if (it instanceof FootageItem && it.file && it.hasAudio) {
                    return amhOk({ path: it.file.fsName, name: it.name });
                }
            } catch (e) {}
        }
        return amhErr("No footage with an on-disk file was found in this project.");
    });
}

/* -------------------------------------------------- selected-layer range */

function amharic_getSelectedClip() {
    return amhGuard(function () {
        if (!app.project) { return amhErr("No project is open."); }
        var comp = amhAeComp();
        if (!comp) { return amhAeNoComp(); }

        // Pass 1: an explicitly selected footage layer. Pass 2: the topmost
        // audio footage layer under the current-time indicator.
        var picked = null, via = "";
        var sel = comp.selectedLayers;
        for (var s = 0; s < sel.length && !picked; s++) {
            if (amhAeFootagePath(sel[s])) { picked = sel[s]; via = "selected"; }
        }
        if (!picked) {
            var t = comp.time;
            for (var i = 1; i <= comp.numLayers && !picked; i++) {
                var L = comp.layer(i);
                if (amhAeFootagePath(L) && amhAeHasAudio(L) && t >= L.inPoint && t <= L.outPoint) {
                    picked = L;
                    via = "time indicator (no layer selected)";
                }
            }
        }
        if (!picked) {
            return amhErr("No layer found. Select a video or audio layer in the comp, or " +
                          "move the time indicator onto it, then try again.");
        }
        if (!amhAeHasAudio(picked)) {
            return amhErr("The selected layer has no audio (or its audio switch is off).");
        }
        var retimed = amhAeRetimed(picked);
        if (retimed) {
            return amhErr("This layer has " + retimed + ", which is not supported yet.");
        }
        var tlStart = Math.max(0, picked.inPoint);
        var tlEnd = Math.min(comp.duration, picked.outPoint);
        if (!(tlEnd > tlStart)) { return amhErr("The selected layer has no usable time range."); }
        var sourceIn = tlStart - picked.startTime;
        return amhOk({
            sourcePath: amhAeFootagePath(picked),
            sourceIn: sourceIn,
            sourceOut: sourceIn + (tlEnd - tlStart),
            duration: tlEnd - tlStart,
            timelineStart: tlStart,
            timelineEnd: tlEnd,
            name: picked.source.name,
            mode: "clip",
            via: via
        });
    });
}

/* ------------------------------------------------------ whole-comp info */

function amharic_getSequenceInfo(all) {
    return amhGuard(function () {
        if (!app.project) { return amhErr("No project is open."); }
        var comp = amhAeComp();
        if (!comp) { return amhAeNoComp(); }

        var inP = comp.workAreaStart;
        var outP = comp.workAreaStart + comp.workAreaDuration;
        var filterByWorkArea = !(all === true);

        var clips = [], unsupported = [], seen = {};
        for (var i = 1; i <= comp.numLayers; i++) {
            var L = comp.layer(i);
            var src = amhAeFootagePath(L);
            if (!src || !amhAeHasAudio(L)) { continue; }
            var retimed = amhAeRetimed(L);
            if (retimed) {
                unsupported.push({ name: L.source.name, reason: retimed });
                continue;
            }
            var tlStart = Math.max(0, L.inPoint);
            var tlEnd = Math.min(comp.duration, L.outPoint);
            var segStart = tlStart, segEnd = tlEnd;
            if (filterByWorkArea) {
                segStart = Math.max(tlStart, inP);
                segEnd = Math.min(tlEnd, outP);
            }
            if (!(segEnd > segStart)) { continue; }
            var srcIn = segStart - L.startTime;
            var dur = segEnd - segStart;
            var key = src + "|" + segStart.toFixed(3) + "|" + srcIn.toFixed(3) + "|" + dur.toFixed(3);
            if (seen[key]) { continue; }
            seen[key] = true;
            clips.push({
                name: L.source.name,
                sourcePath: src,
                sourceIn: srcIn,
                duration: dur,
                timelineStart: segStart,
                timelineEnd: segEnd
            });
        }
        clips.sort(function (a, b) { return a.timelineStart - b.timelineStart; });
        return amhOk({ inPoint: inP, outPoint: outP, clips: clips, unsupported: unsupported });
    });
}

/* ---------------------------------------------------------------- seek */

function amharic_seekPlayhead(secondsJSON) {
    return amhGuard(function () {
        var comp = amhAeComp();
        if (!comp) { return amhAeNoComp(); }
        var sec = Number(JSON.parse(secondsJSON));
        if (isNaN(sec) || !isFinite(sec) || sec < 0) { return amhErr("Bad time: " + secondsJSON); }
        comp.time = Math.min(sec, comp.duration);
        return amhOk({ seconds: sec });
    });
}

/* ------------------------------------------------------------ captions */

function amhAeReadSrt(path) {
    var f = new File(path);
    if (!f.exists) { return null; }
    f.encoding = "UTF-8";
    if (!f.open("r")) { return null; }
    var raw = f.read();
    f.close();
    raw = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
    var blocks = raw.split(/\n{2,}/);
    var re = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/;
    var toS = function (h, m, s, ms) {
        return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number((ms + "00").substr(0, 3)) / 1000;
    };
    var cues = [];
    for (var b = 0; b < blocks.length; b++) {
        var lines = blocks[b].split("\n");
        for (var i = 0; i < lines.length; i++) {
            var m = re.exec(lines[i]);
            if (m) {
                var text = lines.slice(i + 1).join("\r").replace(/^\s+|\s+$/g, "");
                if (text) {
                    cues.push({ start: toS(m[1], m[2], m[3], m[4]), end: toS(m[5], m[6], m[7], m[8]), text: text });
                }
                break;
            }
        }
    }
    cues.sort(function (a, b) { return a.start - b.start; });
    return cues;
}

// PostScript names to try, best Ethiopic glyphs first. `preferred` is the
// family the panel detected on this machine (e.g. "Abyssinica SIL").
function amhAeFontCandidates(preferred) {
    var list = [];
    try {
        if (preferred && app.fonts && app.fonts.getFontsByFamilyNameAndStyleName) {
            var hits = app.fonts.getFontsByFamilyNameAndStyleName(preferred, "Regular");
            for (var i = 0; hits && i < hits.length; i++) { list.push(hits[i].postScriptName); }
        }
    } catch (e) {}
    var fixed = ["AbyssinicaSIL-Regular", "AbyssinicaSIL", "NotoSansEthiopic-Regular",
                 "Nyala-Regular", "Ebrima", "Kefa-Regular", "Kefa"];
    for (var j = 0; j < fixed.length; j++) { list.push(fixed[j]); }
    return list;
}

function amhAeStyle(td, comp, fontList) {
    var size = Math.max(18, Math.round(comp.height * 0.055));
    td.fontSize = size;
    td.applyFill = true;
    td.fillColor = [1, 1, 1];
    td.applyStroke = true;
    td.strokeColor = [0, 0, 0];
    td.strokeWidth = Math.max(2, Math.round(size * 0.09));
    td.strokeOverFill = false;
    td.justification = ParagraphJustification.CENTER_JUSTIFY;
    var used = "";
    for (var i = 0; i < fontList.length && !used; i++) {
        try {
            td.font = fontList[i];
            if (String(td.font) === fontList[i]) { used = fontList[i]; }
        } catch (e) {}
    }
    return used;
}

function amh_importCaptions(argsJSON) {
    return amhGuard(function () {
        var args = JSON.parse(argsJSON);
        var comp = amhAeComp();
        if (!comp) { return amhAeNoComp(); }
        var cues = amhAeReadSrt(args.srtPath);
        if (cues === null) { return amhErr("Caption file not found: " + args.srtPath); }
        var offset = Number(args.startSeconds || 0);
        var baseName = String(args.baseName || "captions").replace(/\.srt$/i, "");

        // Only cues that land inside the comp can be shown.
        var usable = [];
        for (var c = 0; c < cues.length; c++) {
            var s = cues[c].start + offset, e = Math.min(cues[c].end + offset, comp.duration);
            if (s < comp.duration && e > s) { usable.push({ start: Math.max(0, s), end: e, text: cues[c].text }); }
        }
        if (!usable.length) {
            return amhOk({ placed: false, note: "No captions fall inside this composition's duration.",
                           requestedStart: offset, landedStart: null, landedEnd: null, captionItemName: "" });
        }

        // Unique per placement even within one millisecond (a millisecond
        // stamp alone let a fast re-run tag the new layer like the old one, so
        // the old caption layer was never replaced).
        AMH_AE_SEQ += 1;
        var stamp = String(new Date().getTime()) + "-" + AMH_AE_SEQ + "-" +
                    String(Math.floor(Math.random() * 1e9));
        var tagPrefix = AMH_AE_TAG + baseName + "|";
        var layer = null, fontUsed = "";
        app.beginUndoGroup("Amharic Captions");
        try {
            layer = comp.layers.addText(usable[0].text);
            layer.name = "Amharic Captions - " + baseName;
            layer.comment = tagPrefix + stamp;
            try { layer.label = 9; } catch (e) {}

            var prop = layer.property("ADBE Text Properties").property("ADBE Text Document");
            var td = prop.value;
            fontUsed = amhAeStyle(td, comp, amhAeFontCandidates(args.font));
            prop.setValue(td);
            layer.property("ADBE Transform Group").property("ADBE Position")
                 .setValue([comp.width / 2, comp.height * 0.88]);

            // Source Text keyframes hold until the next one: set each cue's
            // text at its start, and blank the layer in gaps between cues.
            var blank = " ";
            for (var k = 0; k < usable.length; k++) {
                var cue = usable[k];
                td = prop.value;
                td.text = cue.text;
                prop.setValueAtTime(cue.start, td);
                var next = usable[k + 1];
                if (!next || next.start > cue.end + 0.001) {
                    td = prop.value;
                    td.text = blank;
                    prop.setValueAtTime(cue.end, td);
                }
            }
            layer.inPoint = usable[0].start;
            layer.outPoint = Math.min(comp.duration, usable[usable.length - 1].end);
            layer.moveToBeginning();
        } catch (err) {
            try { if (layer) { layer.remove(); } } catch (e2) {}
            app.endUndoGroup();
            return amhOk({ placed: false, note: "After Effects could not create the caption layer: " + err.message,
                           requestedStart: offset, landedStart: null, landedEnd: null, captionItemName: "" });
        }

        // New layer is in place: now remove older caption layers for this clip.
        // Compare by the unique comment tag, never by object identity:
        // comp.layer(i) returns a fresh wrapper on every call.
        var removed = 0, mine = tagPrefix + stamp;
        for (var i = comp.numLayers; i >= 1; i--) {
            var L = comp.layer(i);
            try {
                var cm = String(L.comment);
                if (cm !== mine && cm.indexOf(tagPrefix) === 0) { L.remove(); removed++; }
            } catch (e3) {}
        }
        app.endUndoGroup();

        return amhOk({
            placed: true,
            placement: "ae-text-layer",
            captionItemName: layer.name,
            requestedStart: offset,
            landedStart: usable[0].start,
            landedEnd: usable[usable.length - 1].end,
            note: usable.length + " captions as one text layer" +
                  (fontUsed ? " (font " + fontUsed + ")" : " (no Ethiopic font found - install Abyssinica SIL)") +
                  (removed ? "; replaced " + removed + " older caption layer(s)" : ""),
            host: "AEFT"
        });
    });
}
