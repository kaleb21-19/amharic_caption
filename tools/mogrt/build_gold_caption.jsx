/*
 * Amharic Captions Pro - build the editable "Gold Caption" MOGRT.
 *
 * Run ONCE in After Effects: File > Scripts > Run Script File...
 * It makes a NEW project (your open project is not changed), exports
 * "Amharic Gold Caption 16:9.mogrt" and "Amharic Gold Caption 9:16.mogrt"
 * next to this script, then leaves that folder open on your desktop.
 *
 * Needs the free OFL font "Noto Sans Ethiopic" installed (it ships in the
 * fonts folder of Amharic Captions Pro). No audio, no photos, no third-party
 * templates - only shapes and text made here.
 *
 * ExtendScript ES3: var only, no JSON object, no arrow functions.
 */
var amhTest = (typeof __amhTest !== "undefined") ? __amhTest : false;

var AMH_TPL = {
  name: "Amharic Gold Caption",
  font: "Noto Sans Ethiopic",
  // An Amharic greeting as \u escapes so this file stays plain ASCII.
  sample: "\u1230\u120b\u1325\u1363 \u12a0\u121b\u122d\u131b \u12ab\u1365\u133d\u1295",
  gold: [1.0, 0.82745098, 0.0, 1.0],
  dark: [0.04313725, 0.05882353, 0.07058824, 1.0],
  white: [1.0, 1.0, 1.0, 1.0],
  black: [0.0, 0.0, 0.0, 1.0]
};

function amhFail(msg) {
  if (amhTest) { throw new Error(msg); }
  alert("Amharic Captions Pro - template build failed\n\n" + msg);
}

function amhLines(a) { return a.join("\n"); }

function amhFxAdd(ctrl, type, name) {
  var fx = ctrl.property("ADBE Effect Parade").addProperty(type);
  if (!fx) { amhFail("Cannot add the effect " + type + ". Check your After Effects version."); }
  fx.name = name;
  return fx;
}

function amhSlider(ctrl, name, value) {
  var p = amhFxAdd(ctrl, "ADBE Slider Control", name).property("Slider");
  p.setValue(value);
  return p;
}

function amhColour(ctrl, name, value) {
  var p = amhFxAdd(ctrl, "ADBE Color Control", name).property("Color");
  p.setValue(value);
  return p;
}

function amhCheck(ctrl, name, value) {
  var p = amhFxAdd(ctrl, "ADBE Checkbox Control", name).property("Checkbox");
  p.setValue(value ? 1 : 0);
  return p;
}

function amhExpose(prop, comp, label) {
  if (!prop.canAddToMotionGraphicsTemplate(comp)) {
    amhFail("This After Effects cannot expose " + label + " in Essential Graphics.");
  }
  if (!prop.addToMotionGraphicsTemplateAs(comp, label)) {
    amhFail("Could not expose " + label + " in Essential Graphics.");
  }
}

function amhCtlExpr(name) {
  return 'thisComp.layer("Controls").effect("' + name + '")';
}

/* One design, two frame shapes. Everything the editor may change is a
   real Essential Graphics control - no text is written into the template
   by our panel (that path failed in 1.94.0 and was removed). */
function amhBuildOne(w, h, suffix) {
  var portrait = (h > w);
  var comp = app.project.items.addComp(AMH_TPL.name + " " + suffix, w, h, 1, 10, 30);
  var barH = portrait ? 186 : 214;
  var pad = portrait ? 60 : 90;
  var bottom = portrait ? 300 : 96;
  var ctl = comp.layers.addNull();
  ctl.name = "Controls";

  var pSize = amhSlider(ctl, "Text size", 100);
  var pBox = amhSlider(ctl, "Box opacity", 86);
  var pSide = amhSlider(ctl, "Side margin", pad);
  var pBottom = amhSlider(ctl, "Bottom margin", bottom);
  var pGold = amhColour(ctl, "Accent colour", AMH_TPL.gold);
  var pShow = amhCheck(ctl, "Show box", true);

  var box = comp.layers.addSolid(AMH_TPL.dark, "Caption box", w, barH, 1, 10);
  box.position.expression = amhLines([
    "var m = " + amhCtlExpr("Side margin") + '("Slider").value;',
    "var b = " + amhCtlExpr("Bottom margin") + '("Slider").value;',
    "[thisComp.width / 2, thisComp.height - b - " + (barH / 2) + "]"
  ]);
  box.scale.expression = amhLines([
    "var m = " + amhCtlExpr("Side margin") + '("Slider").value;',
    "var full = thisComp.width - 2 * m;",
    "[100 * full / " + w + ", 100]"
  ]);
  box.opacity.expression = amhLines([
    "var on = " + amhCtlExpr("Show box") + '("Checkbox").value;',
    "var v = 0;",
    "if (on > 0) { v = " + amhCtlExpr("Box opacity") + '("Slider").value; }',
    "v"
  ]);

  // Thin gold rule above the caption: a shape so its colour can follow
  // the editor's Accent colour control.
  var accent = comp.layers.addShape();
  accent.name = "Accent rule";
  var grp = accent.property("ADBE Root Vectors Group").addProperty("ADBE Vector Group");
  var rect = grp.property("ADBE Vector Shapes").addProperty("ADBE Vector Shape - Rect");
  rect.property("ADBE Vector Rect Size").setValue([w - 2 * pad, 5]);
  rect.property("ADBE Vector Rect Position").setValue([0, 0]);
  // A new vector group may already carry a default white fill and a black
  // stroke; keep one fill, no outline, so the control can drive the colour.
  var stroke = grp.property("ADBE Vector Graphic - Stroke");
  if (stroke) { stroke.remove(); }
  var fill = grp.property("ADBE Vector Graphic - Fill");
  if (!fill) { fill = grp.addProperty("ADBE Vector Graphic - Fill"); }
  fill.color.expression = amhCtlExpr("Accent colour") + '("Color")';
  accent.position.expression = amhLines([
    "var m = " + amhCtlExpr("Side margin") + '("Slider").value;',
    "var b = " + amhCtlExpr("Bottom margin") + '("Slider").value;',
    "[thisComp.width / 2, thisComp.height - b - " + barH + "]"
  ]);
  accent.opacity.expression = amhLines([
    "var on = " + amhCtlExpr("Show box") + '("Checkbox").value;',
    "var v = 0;",
    "if (on > 0) { v = " + amhCtlExpr("Box opacity") + '("Slider").value; }',
    "v"
  ]);

  var text = comp.layers.addText(AMH_TPL.sample);
  text.name = "Caption text";
  var doc = text.property("Source Text").value;
  doc.font = AMH_TPL.font;
  doc.fontSize = portrait ? 62 : 70;
  doc.fillColor = AMH_TPL.white;
  doc.strokeColor = AMH_TPL.black;
  doc.strokeWidth = 2;
  doc.justify = ParagraphJustification.CENTER_JUSTIFY;
  text.property("Source Text").setValue(doc);
  text.position.expression = amhLines([
    "var b = " + amhCtlExpr("Bottom margin") + '("Slider").value;',
    "[thisComp.width / 2, thisComp.height - b - " + (barH / 2) + "]"
  ]);
  text.scale.expression = amhLines([
    "var s = " + amhCtlExpr("Text size") + '("Slider").value;',
    "[s, s]"
  ]);

  // Exactly the controls an editor sees in Premiere's Essential Graphics.
  amhExpose(text.property("Source Text"), comp, "Caption text");
  amhExpose(pSize, comp, "Text size");
  amhExpose(pBox, comp, "Box opacity");
  amhExpose(pSide, comp, "Side margin");
  amhExpose(pBottom, comp, "Bottom margin");
  amhExpose(pGold, comp, "Accent colour");
  amhExpose(pShow, comp, "Show box");

  comp.motionGraphicsTemplateName = AMH_TPL.name + " " + suffix;
  return comp;
}

function amhBuildTemplates() {
  if (app.project && app.project.dirty) {
    amhFail("Save your current After Effects project first, then run this script again.");
  }
  app.newProject();
  var here = new File($.fileName).parent;
  app.project.saveAs(new File(here.fsName + "/AmhCap_Source.aep"));

  var comps = [
    amhBuildOne(1920, 1080, "16:9"),
    amhBuildOne(1080, 1920, "9:16")
  ];
  var made = [];
  for (var i = 0; i < comps.length; i++) {
    var out = comps[i].exportAsMotionGraphicsTemplate(true, here.fsName);
    if (!out) { amhFail("After Effects did not export " + comps[i].motionGraphicsTemplateName + "."); }
    made.push(comps[i].motionGraphicsTemplateName + ".mogrt");
  }
  if (!amhTest) {
    alert("Done. Two editable templates are next to this script:\n\n" + made.join("\n") +
          "\n\nCopy the .mogrt file into your product's com.amharic.captions/mogrt folder before building the zip.");
  }
  return made;
}

if (!amhTest) {
  try { amhBuildTemplates(); }
  catch (e) { alert("Amharic Captions Pro - template build failed\n\n" + e); }
}
