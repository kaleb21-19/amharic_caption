/*
 * test_mogrt.js — the editable Premiere caption template.
 *
 * There is no After Effects on CI, so run the generator script in a tiny fake
 * AE object model and check what it would build: two frame shapes, seven real
 * Essential Graphics controls, an Amharic text layer using our OFL font, and
 * two exported .mogrt files. Also keeps the .jsx plain ASCII / ES3 so
 * ExtendScript can read it on an editor's Windows or Mac machine.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'tools', 'mogrt', 'build_gold_caption.jsx');
const SAMPLE = '\u1230\u120b\u1325\u1363 \u12a0\u121b\u122d\u131b \u12ab\u1365\u133d\u1295';

let failures = 0;
function ok(cond, what) {
  if (!cond) { failures++; console.log('FAIL ' + what); }
}
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ')'); }

class FakeProp {
  constructor(name) {
    this.name = name || '';
    this.value = null;
    this.expression = '';
    this.exposed = null;
    this._kids = {};
    this._list = [];
  }
  get color() { return this.property('Color'); }
  property(n) {
    if (!this._kids[n]) { this._kids[n] = new FakeProp(n); }
    return this._kids[n];
  }
  addProperty(n) {
    const p = new FakeProp(n);
    this._kids[n] = p;
    this._list.push(p);
    return p;
  }
  setValue(v) { this.value = v; return this; }
  setValueAtTime(v) { this.value = v; return this; }
  remove() { this.removed = true; }
  canAddToMotionGraphicsTemplate() { return true; }
  addToMotionGraphicsTemplateAs(comp, label) {
    this.exposed = label;
    comp.exposed.push(label);
    return true;
  }
}

class FakeTextDoc {
  constructor(text) {
    this.text = text;
    this.font = '';
    this.fontSize = 0;
    this.fillColor = null;
    this.strokeColor = null;
    this.strokeWidth = 0;
    this.justify = null;
  }
}

class FakeLayer {
  constructor(kind, name, text) {
    this.kind = kind;
    this.name = name || '';
    this.position = new FakeProp('Position');
    this.scale = new FakeProp('Scale');
    this.opacity = new FakeProp('Opacity');
    this._kids = {};
    if (kind === 'text') {
      this._kids['Source Text'] = new FakeProp('Source Text');
      this._kids['Source Text'].value = new FakeTextDoc(text);
    }
  }
  property(n) {
    if (!this._kids[n]) { this._kids[n] = new FakeProp(n); }
    return this._kids[n];
  }
}

class FakeComp {
  constructor(name, w, h) {
    this.name = name;
    this.width = w;
    this.height = h;
    this.layers = [];
    this.exposed = [];
    this.exports = [];
    this.motionGraphicsTemplateName = '';
    const list = [];
    this._layerList = list;
    this.layers = {
      addNull: (name) => { const l = new FakeLayer('null', name); list.push(l); return l; },
      addSolid: (color, name, w, h) => { const l = new FakeLayer('solid', name); l.color = color; l.solidWidth = w; l.solidHeight = h; list.push(l); return l; },
      addShape: () => { const l = new FakeLayer('shape', 'Shape Layer'); list.push(l); return l; },
      addText: (t) => { const l = new FakeLayer('text', 'Caption text', t); list.push(l); return l; }
    };
    this.exportAsMotionGraphicsTemplate = function (overwrite, folder) {
      this.exports.push({ name: this.motionGraphicsTemplateName, overwrite: overwrite, folder: folder });
      return true;
    };
  }
  list() { return this._layerList; }
}

function freshProject() {
  return {
    dirty: false,
    comps: [],
    savedAs: null,
    items: {
      addComp: function (name, w, h, par, dur, fps) {
        const c = new FakeComp(name, w, h);
        this.comps = this.comps || [];
        return c;
      }
    },
    saveAs: function (f) { this.savedAs = f.fsName; }
  };
}

function run() {
  const bytes = fs.readFileSync(SCRIPT);
  ok(bytes[0] !== 0xef, 'the .jsx has no UTF-8 BOM (ExtendScript needs plain ASCII)');
  const src = bytes.toString('utf8');
  for (const ch of src) {
    if (ch.charCodeAt(0) > 127) { ok(false, 'the .jsx is ASCII only (use \\uXXXX for Amharic)'); break; }
  }
  ok(!/\blet\s+[A-Za-z_$]/.test(src), 'no let (ES3)');
  ok(!/\bconst\s+[A-Za-z_$]/.test(src), 'no const (ES3)');
  ok(!/=>/.test(src), 'no arrow function (ES3)');
  ok(!/\bJSON\s*\./.test(src), 'no JSON object (ES3)');

  const alerts = [];
  let newProjects = 0;
  const app = {
    project: freshProject(),
    newProject: function () { newProjects++; this.project = freshProject(); }
  };
  // addComp is called on project.items: wire it to record in the project.
  function wire(project) {
    project.items.addComp = function (name, w, h) {
      const c = new FakeComp(name, w, h);
      project.comps.push(c);
      return c;
    };
  }
  wire(app.project);
  const oldNew = app.newProject;
  app.newProject = function () { oldNew.call(app); wire(app.project); };

  function FakeFile(p) {
    this.fsName = p;
    this.path = p;
    const i = p.lastIndexOf('/');
    this.parent = { fsName: p.slice(0, i) };
  }
  const context = {
    __amhTest: true,
    app: app,
    $: { fileName: 'C:/amh/tools/mogrt/build_gold_caption.jsx' },
    File: FakeFile,
    Folder: function (p) { this.fsName = p; },
    ParagraphJustification: { CENTER_JUSTIFY: 2 },
    alert: function (m) { alerts.push(m); }
  };
  vm.runInNewContext(src, context, { filename: 'build_gold_caption.jsx' });
  const made = context.amhBuildTemplates();

  eq(alerts.length, 0, 'no error alert while building');
  eq(newProjects, 1, 'a fresh AE project is used (the editor\'s own project is untouched)');
  ok(app.project.savedAs && app.project.savedAs.indexOf('AmhCap_Source.aep') > 0, 'the source project is saved next to the script');
  eq(app.project.comps.length, 2, 'two comps: 16:9 and 9:16');
  eq(app.project.comps[0].width, 1920, 'landscape comp is 1920 wide');
  eq(app.project.comps[0].height, 1080, 'landscape comp is 1080 high');
  eq(app.project.comps[1].width, 1080, 'portrait comp is 1080 wide');
  eq(app.project.comps[1].height, 1920, 'portrait comp is 1920 high');

  const labels = ['Caption text', 'Text size', 'Box opacity', 'Side margin', 'Bottom margin', 'Accent colour', 'Show box'];
  for (const c of app.project.comps) {
    eq(c.exposed.slice().sort().join('|'), labels.slice().sort().join('|'), c.name + ': all seven Essential Graphics controls');
    eq(c.list().length, 4, c.name + ': Controls, box, accent rule and text');
    const text = c.list().filter(l => l.kind === 'text')[0];
    ok(!!text, c.name + ': has a text layer');
    const doc = text.property('Source Text').value;
    eq(doc.text, SAMPLE, c.name + ': the sample is Amharic, written as \\u escapes');
    eq(doc.font, 'Noto Sans Ethiopic', c.name + ': uses the free OFL Amharic font');
    ok(doc.fontSize >= 40, c.name + ': readable base font size');
    ok(doc.justify === 2, c.name + ': centred text');
    ok(text.scale.expression.indexOf('Text size') >= 0, c.name + ': Text size control drives the text');
    ok(text.position.expression.indexOf('Bottom margin') >= 0, c.name + ': Bottom margin drives the text');
    const box = c.list().filter(l => l.kind === 'solid')[0];
    ok(box.opacity.expression.indexOf('Show box') >= 0 && box.opacity.expression.indexOf('Box opacity') >= 0,
       c.name + ': Show box and Box opacity drive the backdrop');
    ok(box.scale.expression.indexOf('Side margin') >= 0, c.name + ': Side margin drives the backdrop width');
    eq(c.exports.length, 1, c.name + ': exported once');
    eq(c.exports[0].overwrite, true, c.name + ': overwrites an older build');
    eq(c.exports[0].folder, 'C:/amh/tools/mogrt', c.name + ': exported next to the script');
    eq(c.exports[0].name, 'Amharic Gold Caption ' + (c.width > c.height ? '16:9' : '9:16'), c.name + ': template name');
  }
  eq(made.length, 2, 'two .mogrt names reported to the owner');
}

try { run(); }
catch (e) { failures++; console.log('FAIL exception: ' + (e && e.stack ? e.stack : e)); }
console.log(failures ? 'FAILURES: ' + failures : 'ALL PASS');
process.exit(failures ? 1 : 0);
