/*
 * capcut_core.js — Amharic Captions Studio (1.35.0): styled captions as real,
 * editable text layers in a CapCut (desktop) project. Pure: no DOM, no files —
 * studio_capcut.js reads and writes the project. Requireable from Node for
 * tools/test/test_capcut.js; window.AmhCapCut in the app.
 *
 * A CapCut project (com.lveditor.draft/<name>/draft_content.json, plain JSON
 * in CapCut 9.x) gets ONE new text track: one "subtitle" text per caption,
 * timed where the video sits on CapCut's own timeline (it may be trimmed or
 * moved there). Font, size, colours, outline, box and height come from the
 * chosen style; ★ words and numbers keep their highlight colour. Nothing
 * else in the project changes. TEMPLATE = CapCut's own fields and defaults
 * for one caption (from a CapCut 9.x project, text and paths removed).
 */
'use strict';
(function (root) {
  const TEMPLATE = {"capcut_version": "183.0.0", "text": {"recognize_task_id": "", "id": "", "name": "", "recognize_text": "", "recognize_model": "", "punc_model": "", "type": "subtitle", "content": "", "base_content": "", "words": {"start_time": [], "end_time": [], "text": []}, "current_words": {"start_time": [], "end_time": [], "text": []}, "global_alpha": 1.0, "combo_info": {"text_templates": []}, "caption_template_info": {"resource_id": "", "third_resource_id": "", "resource_name": "", "category_id": "", "category_name": "", "effect_id": "", "request_id": "", "path": "", "is_new": false, "source_platform": 0}, "layer_weight": 1, "letter_spacing": 0.0, "text_curve": null, "text_loop_on_path": false, "offset_on_path": 0.0, "enable_path_typesetting": false, "text_exceeds_path_process_type": 0, "text_typesetting_paths": null, "text_typesetting_paths_file": "", "text_typesetting_path_index": 0, "line_spacing": 0.02, "has_shadow": false, "shadow_color": "", "shadow_alpha": 0.9, "shadow_smoothing": 0.45, "shadow_distance": 5.0, "shadow_point": {"x": 0.6363961030678928, "y": -0.6363961030678928}, "shadow_angle": -45.0, "shadow_thickness_projection_enable": false, "shadow_thickness_projection_angle": 0.0, "shadow_thickness_projection_distance": 0.0, "border_alpha": 1.0, "border_color": "", "border_width": 0.08, "border_mode": 0, "style_name": "", "text_color": "#FFFFFF", "text_alpha": 1.0, "font_name": "", "font_title": "none", "font_size": 10.0, "font_path": "", "font_id": "", "font_resource_id": "", "initial_scale": 1.0, "font_url": "", "typesetting": 0, "alignment": 1, "line_feed": 1, "use_effect_default_color": true, "is_rich_text": false, "shape_clip_x": false, "shape_clip_y": false, "ktv_color": "", "text_to_audio_ids": [], "bold_width": 0.0, "italic_degree": 0, "underline": false, "underline_width": 0.05, "underline_offset": 0.22, "sub_type": 0, "check_flag": 7, "text_size": 30, "font_category_name": "", "font_source_platform": 0, "font_third_resource_id": "", "font_category_id": "", "add_type": 1, "operation_type": 0, "recognize_type": 0, "fonts": [], "background_color": "", "background_alpha": 1.0, "background_style": 0, "background_round_radius": 0.0, "background_width": 0.14, "background_height": 0.14, "background_vertical_offset": 0.0, "background_horizontal_offset": 0.0, "background_fill": "", "single_char_bg_enable": false, "single_char_bg_color": "", "single_char_bg_alpha": 1.0, "single_char_bg_round_radius": 0.3, "single_char_bg_width": 0.0, "single_char_bg_height": 0.0, "single_char_bg_vertical_offset": 0.0, "single_char_bg_horizontal_offset": 0.0, "font_team_id": "", "tts_auto_update": false, "text_preset_resource_id": "", "group_id": "", "preset_id": "", "preset_name": "", "preset_category": "", "preset_category_id": "", "preset_index": 0, "preset_has_set_alignment": false, "force_apply_line_max_width": false, "language": "en-US", "relevance_segment": [], "original_size": [], "fixed_width": -1.0, "fixed_height": -1.0, "autoAdaptCanvasEnabled": false, "line_max_width": 0.82, "oneline_cutoff": false, "cutoff_postfix": "", "subtitle_template_original_fontsize": 0.0, "subtitle_keywords": {"range": []}, "inner_padding": -1.0, "multi_language_current": "none", "source_from": "", "is_lyric_effect": false, "lyric_group_id": "", "lyrics_template": {"resource_id": "", "resource_name": "", "panel": "", "effect_id": "", "path": "", "category_id": "", "category_name": "", "request_id": ""}, "is_batch_replace": false, "is_words_linear": false, "ssml_content": "", "subtitle_keywords_config": null, "sub_template_id": -1, "translate_original_text": ""}, "segment": {"id": "", "source_timerange": null, "target_timerange": {"start": 0, "duration": 0}, "render_timerange": {"start": 0, "duration": 0}, "desc": "", "state": 0, "speed": 1.0, "is_loop": false, "is_tone_modify": false, "reverse": false, "intensifies_audio": false, "cartoon": false, "volume": 1.0, "last_nonzero_volume": 1.0, "clip": {"scale": {"x": 1.0, "y": 1.0}, "rotation": 0.0, "transform": {"x": 0.0, "y": -0.56}, "flip": {"vertical": false, "horizontal": false}, "alpha": 1.0}, "uniform_scale": {"on": true, "value": 1.0}, "material_id": "", "extra_material_refs": [], "render_index": 14000, "keyframe_refs": [], "enable_lut": false, "enable_adjust": false, "enable_hsl": false, "visible": true, "group_id": "", "enable_color_curves": true, "enable_hsl_curves": true, "track_render_index": 2, "hdr_settings": null, "enable_color_wheels": true, "track_attribute": 0, "is_placeholder": false, "template_id": "", "enable_smart_color_adjust": false, "template_scene": "default", "common_keyframes": [], "caption_info": null, "responsive_layout": {"enable": false, "target_follow": "", "size_layout": 0, "horizontal_pos_layout": 0, "vertical_pos_layout": 0}, "enable_color_match_adjust": false, "enable_color_correct_adjust": false, "enable_adjust_mask": false, "raw_segment_id": "", "lyric_keyframes": null, "enable_video_mask": true, "digital_human_template_group_id": "", "color_correct_alg_result": "", "source": "segmentsourcenormal", "enable_mask_stroke": false, "enable_mask_shadow": false, "enable_color_adjust_pro": false, "segment_color_tag": ""}, "animation": {"id": "", "type": "sticker_animation", "animations": [], "multi_language_current": "none"}, "track": {"id": "", "type": "text", "flag": 1, "attribute": 0, "name": "", "is_default_name": true}};
  const US = 1e6;                                   // CapCut times are microseconds
  const NAME = 'Amharic Captions';                  // our track's name (found again to replace it)
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  function uuid(rand) {
    const r = rand || Math.random;
    const h = (n) => Array.from({ length: n }, () => '0123456789ABCDEF'[Math.floor(r() * 16)]).join('');
    return h(8) + '-' + h(4) + '-4' + h(3).toLowerCase() + '-' + h(4) + '-' + h(12);
  }
  // '#RRGGBB' -> [r, g, b] 0-1
  function rgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return [1, 1, 1];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x) => Math.round(x / 255 * 1000) / 1000);
  }

  // Where a video file is on the project's timeline: every piece of it.
  // [{ src: [a, b] seconds of the file, at: timeline second of a, speed }]
  function placements(draft, videoPath) {
    const want = normPath(videoPath);
    const mats = {};
    ((draft && draft.materials && draft.materials.videos) || []).forEach((v) => { if (normPath(v.path) === want) mats[v.id] = 1; });
    const out = [];
    ((draft && draft.tracks) || []).forEach((t) => {
      if (t.type !== 'video') return;
      (t.segments || []).forEach((s) => {
        if (!mats[s.material_id] || !s.source_timerange || !s.target_timerange) return;
        const a = s.source_timerange.start / US;
        const speed = Number(s.speed) > 0 ? Number(s.speed) : 1;
        out.push({ src: [a, a + s.source_timerange.duration / US], at: s.target_timerange.start / US, speed });
      });
    });
    return out.sort((x, y) => x.at - y.at);
  }
  // a caption (file seconds) -> where it shows on the timeline, or null when
  // that part of the video is not in the project
  function placeCue(pl, start, end) {
    const mid = (start + end) / 2;
    for (const p of pl) {
      if (mid < p.src[0] || mid >= p.src[1]) continue;
      const a = Math.max(start, p.src[0]), b = Math.min(end, p.src[1]);
      const shift = (t) => p.at + (Math.max(p.src[0], Math.min(p.src[1], t)) - p.src[0]) / p.speed;
      return { start: shift(a), end: shift(b), shift };
    }
    return null;
  }

  // the text and its coloured ranges: *word* = the highlight colour (★ and,
  // when the style pops numbers, digits and money)
  const NUM = /^[0-9][0-9.,:%]*$|ብር$|^\$/;
  function styledText(raw, look) {
    const parts = String(raw || '').replace(/~[^~]*~/g, '').replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
    let text = '';
    const ranges = [];
    parts.forEach((w, i) => {
      const clean = w.replace(/\*/g, '');
      if (!clean) return;
      const star = /^\*.*\*$/.test(w) || (!!look.popNumbers && NUM.test(clean));
      if (text) text += ' ';
      const a = text.length;
      text += clean;
      if (star) ranges.push([a, text.length]);
    });
    return { text, ranges, words: parts.map((w) => w.replace(/\*/g, '')).filter(Boolean) };
  }
  function styleEntry(look, color, a, b) {
    const st = { fill: { alpha: 1.0, content: { render_type: 'solid', solid: { alpha: 1.0, color: rgb(color) } } },
      font: { id: '', path: look.fontPath || '' }, range: [a, b], size: look.fontSize };
    if (look.stroke) st.strokes = [{ alpha: 1.0, content: { render_type: 'solid', solid: { alpha: 1.0, color: rgb(look.stroke) } }, width: look.strokeWidth }];
    if (look.bold) st.bold = true;
    return st;
  }
  function contentOf(t, look) {
    const styles = [];
    let at = 0;
    t.ranges.forEach(([a, b]) => {
      if (a > at) styles.push(styleEntry(look, look.color, at, a));
      styles.push(styleEntry(look, look.highlight || look.color, a, b));
      at = b;
    });
    if (at < t.text.length || !styles.length) styles.push(styleEntry(look, look.color, at, t.text.length));
    return JSON.stringify({ styles, text: t.text });
  }
  // CapCut's per-word timing (ms from the caption's start; spaces are words too)
  function wordTimes(t, cue, place) {
    const o = { start_time: [], end_time: [], text: [] };
    const wt = Array.isArray(cue.wt) && cue.wt.length === t.words.length ? cue.wt : null;
    if (!wt) return o;
    const ms = (x) => Math.max(0, Math.round((place.shift(x) - place.start) * 1000));
    t.words.forEach((w, i) => {
      if (i) { o.start_time.push(ms(wt[i - 1][1])); o.end_time.push(ms(wt[i][0])); o.text.push(' '); }
      o.start_time.push(ms(wt[i][0])); o.end_time.push(ms(wt[i][1])); o.text.push(w);
    });
    return o;
  }

  // The look in CapCut terms. o = the Studio's styleOpts; style = its id;
  // bottom = where the style puts the caption's bottom edge (0 top - 1 bottom)
  // unless the editor dragged it (o.y). CapCut's transform.y is the text's
  // centre: +1 top, 0 middle, -1 bottom.
  const STYLE_HL = { karaoke: '#FFE500', fill: '#FFE500', highlight: '#FFE500', bold: '#39FF14', glide: '#8A5CFF',
    spotlight: '#FFE500', bounce: '#FFE500', word: '#FFE500', neon: '#00E5FF', retro: '#FFB000', habesha: '#FFD60A' };
  function lookFor(style, o, fontPath, portrait, bottom) {
    o = o || {};
    const k = typeof o.size === 'number' ? o.size : ({ s: 0.8, m: 1, l: 1.2, xl: 1.45 }[o.size] || 1);
    const lineH = (portrait ? 0.045 : 0.07) * k;     // about one line, of the frame height
    const yb = typeof o.y === 'number' ? o.y : (typeof bottom === 'number' ? bottom : (portrait ? 0.76 : 0.9));
    const centre = Math.max(0.03, Math.min(0.97, yb - lineH / 2));
    return {
      fontPath: fontPath || '', fontSize: Math.round((portrait ? 9 : 7) * k * 10) / 10,
      color: o.text || '#FFFFFF', highlight: o.color || STYLE_HL[style] || '#FFE500',
      stroke: o.box ? '' : '#000000', strokeWidth: 0.08, box: !!o.box, bold: true,
      popNumbers: o.emph !== 'off', y: Math.round((1 - 2 * centre) * 1000) / 1000,
    };
  }

  // Build the new track (+ its texts and animations) for these captions.
  // cues: [{ start, end, text, wt }] in the video FILE's seconds.
  function buildTrack(draft, videoPath, cues, look, opts) {
    const rand = opts && opts.rand;
    const pl = placements(draft, videoPath);
    const texts = [], animations = [], segs = [];
    let skipped = 0;
    let order = 14000 + 100 * (((draft && draft.tracks) || []).filter((t) => t.type === 'text').length);
    (cues || []).forEach((c) => {
      const t = styledText(c.text, look);
      if (!t.text) return;
      const place = placeCue(pl, Number(c.start), Number(c.end));
      if (!place || place.end - place.start < 0.05) { skipped++; return; }
      const mat = clone(TEMPLATE.text), seg = clone(TEMPLATE.segment), an = clone(TEMPLATE.animation);
      mat.id = uuid(rand); an.id = uuid(rand); seg.id = uuid(rand);
      mat.content = contentOf(t, look);
      mat.base_content = mat.content;
      mat.font_path = look.fontPath || '';
      mat.font_size = look.fontSize;
      mat.text_color = look.color;
      mat.words = wordTimes(t, c, place);
      mat.border_color = look.stroke || '';
      mat.border_width = look.stroke ? look.strokeWidth : 0;
      if (look.box) { mat.background_style = 1; mat.background_color = '#000000'; mat.background_alpha = 0.6; mat.background_round_radius = 0.2; }
      seg.material_id = mat.id;
      seg.extra_material_refs = [an.id];
      seg.target_timerange = { start: Math.round(place.start * US), duration: Math.round((place.end - place.start) * US) };
      seg.clip.transform = { x: 0, y: look.y };
      seg.render_index = ++order;
      texts.push(mat); animations.push(an); segs.push(seg);
    });
    const track = Object.assign(clone(TEMPLATE.track), { id: uuid(rand), name: NAME, is_default_name: false, segments: segs });
    return { track, texts, animations, placed: segs.length, skipped, found: pl.length };
  }
  // A project with several videos (1.36): every video's captions, one track.
  // items: [{ video, cues }] (cues in that file's own seconds). Captions of
  // different videos never overlap on the timeline: the later one wins.
  function buildTrackAll(draft, items, look, opts) {
    const parts = (items || []).map((it) => buildTrack(draft, it.video, it.cues, look, opts));
    if (!parts.length) return buildTrack(draft, '', [], look, opts);
    const all = [];
    parts.forEach((b) => b.track.segments.forEach((sg, i) => all.push({ sg, text: b.texts[i], an: b.animations[i] })));
    all.sort((x, y) => x.sg.target_timerange.start - y.sg.target_timerange.start);
    const kept = [];
    all.forEach((x) => {
      const prev = kept[kept.length - 1];
      if (prev) {
        const pEnd = prev.sg.target_timerange.start + prev.sg.target_timerange.duration;
        if (x.sg.target_timerange.start < pEnd) prev.sg.target_timerange.duration = Math.max(0, x.sg.target_timerange.start - prev.sg.target_timerange.start);
        if (prev.sg.target_timerange.duration < 50000) kept.pop();
      }
      kept.push(x);
    });
    let order = 14000 + 100 * (((draft && draft.tracks) || []).filter((t) => t.type === 'text' && t.name !== NAME).length);
    kept.forEach((x) => { x.sg.render_index = ++order; });
    const track = parts[0].track;
    track.segments = kept.map((x) => x.sg);
    return { track, texts: kept.map((x) => x.text), animations: kept.map((x) => x.an), placed: kept.length,
      skipped: parts.reduce((n, b) => n + b.skipped, 0), found: parts.reduce((n, b) => n + b.found, 0) };
  }
  // the video files a project uses, each once, in timeline order
  function videosOf(draft) {
    const byId = {};
    ((draft && draft.materials && draft.materials.videos) || []).forEach((v) => { if (v.path && v.type !== 'photo') byId[v.id] = v.path; });
    const seen = {}, out = [];
    ((draft && draft.tracks) || []).filter((t) => t.type === 'video').forEach((t) => (t.segments || [])
      .slice().sort((a, b) => ((a.target_timerange || {}).start || 0) - ((b.target_timerange || {}).start || 0))
      .forEach((sg) => { const p = byId[sg.material_id]; if (p && !seen[normPath(p)]) { seen[normPath(p)] = 1; out.push(p); } }));
    return out;
  }
  // our earlier track(s) in a project
  function ourTracks(draft) {
    return ((draft && draft.tracks) || []).filter((t) => t.type === 'text' && t.name === NAME);
  }
  // the project without our track(s) and their texts (a copy)
  function removeOurs(draft) {
    const d = clone(draft);
    const ours = ourTracks(d);
    if (!ours.length) return d;
    const mats = new Set(), anims = new Set();
    ours.forEach((t) => (t.segments || []).forEach((s) => { mats.add(s.material_id); (s.extra_material_refs || []).forEach((r) => anims.add(r)); }));
    d.tracks = d.tracks.filter((t) => !(t.type === 'text' && t.name === NAME));
    d.materials.texts = (d.materials.texts || []).filter((x) => !mats.has(x.id));
    d.materials.material_animations = (d.materials.material_animations || []).filter((x) => !anims.has(x.id));
    return d;
  }
  // the project with our new track (an earlier one of ours is replaced, so
  // sending again never doubles the captions). A copy; the input stays.
  function addTrack(draft, built) {
    const d = removeOurs(draft);
    d.materials = d.materials || {};
    d.materials.texts = (d.materials.texts || []).concat(built.texts);
    d.materials.material_animations = (d.materials.material_animations || []).concat(built.animations);
    d.tracks = (d.tracks || []).concat([built.track]);
    return d;
  }
  // a project's facts for the list
  function summary(draft) {
    return { canvas: (draft && draft.canvas_config) || null, duration: ((draft && draft.duration) || 0) / US,
      videos: ((draft && draft.materials && draft.materials.videos) || []).map((v) => v.path).filter(Boolean),
      ours: ourTracks(draft).length };
  }

  const api = { TEMPLATE, NAME, uuid, rgb, placements, placeCue, styledText, contentOf, lookFor, buildTrack, buildTrackAll, videosOf, addTrack, removeOurs, ourTracks, summary, normPath };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AmhCapCut = api;
})(typeof window !== 'undefined' ? window : this);
