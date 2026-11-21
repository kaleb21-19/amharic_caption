"""Check the MOGRT files we actually ship in panel/mogrt.

No After Effects here: just open each .mogrt (a ZIP), read its definition.json
and make sure the pack stays small, single-line and free of embedded footage or
fonts. The 20 files built by tools/mogrt/build_gold_caption.jsx are checked the
same way once the owner copies them in.
"""
import json
import os
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PACK = os.path.join(ROOT, 'panel', 'mogrt')
SLOTS = {'text', 'text 01', 'text 02', 'text 03', 'caption',
         'main text', 'type text', 'your text', 'text here',
         'headline', 'title'}

failures = []


def check(cond, what):
    if not cond:
        failures.append(what)
        print('FAIL ' + what)


def text_slots(controls):
    found = []
    for it in controls or []:
        if not isinstance(it, dict):
            continue
        try:
            name = it['uiName']['strDB'][0]['str'].strip().lower()
        except (KeyError, IndexError, TypeError):
            name = ''
        if name in SLOTS:
            found.append(name)
        value = it.get('value')
        if isinstance(value, list):
            found.extend(text_slots([x for x in value if isinstance(x, dict)]))
    return found


files = sorted(f for f in os.listdir(PACK) if f.lower().endswith('.mogrt')) if os.path.isdir(PACK) else []
check(len(files) >= 9, 'at least the nine small single-line templates are in panel/mogrt')
total = 0
for name in files:
    path = os.path.join(PACK, name)
    total += os.path.getsize(path)
    check(':' not in name, name + ': no ":" in the file name (Windows)')
    check(zipfile.is_zipfile(path), name + ': is a real MOGRT ZIP')
    if not zipfile.is_zipfile(path):
        continue
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        check('definition.json' in names, name + ': has definition.json')
        check(any(n.lower().endswith('.aegraphic') for n in names), name + ': has an AE project')
        bad = [n for n in names if n.lower().endswith(
            ('.mp4', '.mov', '.avi', '.mkv', '.wav', '.mp3', '.ttf', '.otf', '.ttc'))]
        check(not bad, name + ': no embedded video, audio or font files (' + ', '.join(bad[:3]) + ')')
        aeps = [i for i in z.infolist() if i.filename.lower().endswith('.aegraphic')]
        if aeps:
            check(aeps[0].file_size < 200000, name + ': pure text/shapes, no embedded footage in the AE project')
        if 'definition.json' in names:
            definition = json.loads(z.read('definition.json').decode('utf-8', 'replace'))
            slots = text_slots(definition.get('clientControls'))
            check(len(set(slots)) <= 1, name + ': one text line only (' + str(slots) + ')')

check(total < 15 * 1024 * 1024, 'the whole pack stays under 15 MB (got %.1f MB)' % (total / 1048576.0))
print('checked %d MOGRTs, %.2f MB' % (len(files), total / 1048576.0))
print('FAILURES: %d' % len(failures) if failures else 'ALL PASS')
sys.exit(1 if failures else 0)
