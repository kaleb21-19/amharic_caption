/*
 * i18n.js — Amharic / English panel language.
 *
 * Amharic is the default for new installs (the panel is built for Ethiopian
 * editors); the header toggle switches languages and the choice is kept in
 * localStorage 'amh.lang'. English strings are the source of truth:
 *   - static HTML marks translatable nodes with data-i18n / data-i18n-html /
 *     data-i18n-title / data-i18n-placeholder = <key in AM_STATIC>; the
 *     original English markup is remembered on first apply, so switching back
 *     restores it exactly.
 *   - dynamic text built in main.js goes through T(english), which returns the
 *     Amharic for an exact match or a pattern in AM_PATTERNS, else the English.
 * The engine Log stays English on purpose: it is technical output that support
 * reads, and translating it would make screenshots harder to diagnose.
 */
'use strict';

const I18N_KEY = 'amh.lang';

function i18nGetLang() {
  try {
    const v = localStorage.getItem(I18N_KEY);
    if (v === 'en' || v === 'am') return v;
  } catch (e) {}
  return 'am';
}
let AMH_LANG = i18nGetLang();

// ── static HTML (keys referenced from index.html) ───────────────────────────
const AM_STATIC = {
  'app.title':        'አማርኛ ካፕሽን',
  'app.sub':          'በኮምፒውተርዎ ላይ · 100% ያለ ኢንተርኔት',
  'font.checking':    'ፊደል በመፈተሽ ላይ…',
  'status.idle':      'በመጠባበቅ ላይ',

  'ob.pick':          '<b>ክሊፕ ይምረጡ</b><span>በታይምላይኑ ላይ ማንኛውንም ክሊፕ ይምረጡ፣ ወይም Work Area / ሙሉ ኤዲት ይጠቀሙ።</span>',
  'ob.style':         '<b>የካፕሽን አይነት ይምረጡ</b><span>ካራኦኬ (አንድ ቃል በአንድ ጊዜ) ወይም በቡድን (በአንድ ካፕሽን 3 ቃላት)።</span>',
  'ob.generate':      '<b>ካፕሽን ይፍጠሩ</b><span>ካፕሽኖቹ በታይምላይኑ ላይ (Premiere) ወይም እንደ ቴክስት ሌየር (After Effects) ይቀመጣሉ — ሙሉ በሙሉ ያለ ኢንተርኔት፣ በኮምፒውተርዎ ላይ።</span>',
  'ob.health':        'የሲስተም ፍተሻ',
  'ob.start':         'ካፕሽን መስራት ይጀምሩ',

  'update.download':  'አውርድ',
  'update.later':     'በኋላ አስታውሰኝ',

  'model.title':      'የአማርኛ ሞዴል',
  'model.hint':       'አንድ ጊዜ ብቻ የሚወርድ',
  'model.body':       'የአማርኛ ድምፅ ሞዴሉ <b>አንድ ጊዜ ብቻ</b> ወርዶ በዚህ ኮምፒውተር ይቀመጣል፣ ስለዚህ ቀጣይ ማሻሻያዎች ትንሽ ይሆናሉ። ኢንተርኔት ቢቋረጥ ካቆመበት ይቀጥላል።',

  'src.title':        'ምንጭ',
  'src.hint':         'ምን ላይ ካፕሽን ይሰራ',
  'src.clip':         'የተመረጠ ክሊፕ',
  'src.work':         'Work Area',
  'src.whole':        'ሙሉ ኤዲት',
  'src.clip.ae':      'የተመረጠ ሌየር',
  'src.whole.ae':     'ሙሉ ኮምፕ',

  'opt.title':        'አማራጮች',
  'opt.hint':         'የካፕሽን አይነት',
  'opt.style':        'የካፕሽን አይነት',
  'opt.karaoke':      'ካራኦኬ',
  'opt.grouped':      'በቡድን',
  'opt.words':        'ቃላት በአንድ ካፕሽን',
  'opt.speakers':     'ተናጋሪዎችን ለይ (2) — ለቃለ መጠይቅ',
  'opt.stylehint':    '<b>ካራኦኬ</b> አንድ ቃል በአንድ ጊዜ ያሳያል። <b>በቡድን</b> በአንድ ካፕሽን ብዙ ቃላት ያሳያል።',
  'opt.advanced':     'ተጨማሪ ቅንብሮች',
  'opt.maxchars':     'በአንድ ካፕሽን ከፍተኛ የፊደል ብዛት',
  'opt.maxcharshint': 'አንድ ካፕሽን ምን ያህል ሊረዝም እንደሚችል ይወስናል። 42 የተለመደው የሰብታይትል መስመር ርዝመት ነው — ምክንያት ከሌለዎት አይቀይሩት።',

  'run.title':        'ፍጠር',
  'run.hint':         'ወደ ጽሑፍ ቀይር እና ገምግም',
  'run.button':       '▶ ካፕሽን ፍጠር',
  'run.cancel':       'አቁም',
  'run.cancelTitle':  'ይህን ስራ አቁም',

  'lic.copyLabel':    '👇 ይቅዱ · ከክፍያው ጋር ይላኩ',
  'lic.copy':         '📋 ቅዳ',
  'lic.copyTitle':    'የማሽን መለያውን ቅዳ',
  'lic.midTitle':     'ሁሉንም ለመምረጥ ይጫኑ',
  'lic.buy':          'ፈቃድ ይግዙ — 2,500 ብር',
  'lic.buyHint':      'የማሽን መለያዎ (Machine ID) ተሞልቶ የቴሌግራም ቦቱ ይከፈታል። <b>2,500 ብር</b> ለ<b>KALEB TEGEGEN</b> በባንክ ያስተላልፉ፣ ስክሪንሾቱን ለቦቱ ይላኩ፣ ቁልፍዎም በዚያው ቻት ይደርሳል።',
  'lic.bankLink':     'የባንክ አካውንቶች',
  'lic.bankName':     'የአካውንት ስም፦ <b>KALEB TEGEGEN</b> — ለሌላ ሰው አይክፈሉ።',
  'lic.mismatch':     '⚠️ <b>ይህ የማሽን መዝገብ የተፈጠረው በሌላ ኮምፒውተር ላይ ነው።</b> ቁልፍ ገዝተው እንደገና ከጫኑ፣ ፈቃዱን ወደዚህ ለማዛወር ድጋፍ ያግኙ — ሁለተኛ አይግዙ።',
  'lic.licensed':     '🔒 <b>ፈቃድ ያለው።</b> ይህ ቅጂ ለዚህ ጭነት ገቢር ሆኗል። ፈቃድዎ ከዚህ ጭነት ጋር ስለተሳሰረ የማሽን መለያው ተደብቋል።',
  'lic.keyLabel':     'የፈቃድ ቁልፍ',
  'lic.activate':     'አግብር',
  'lic.checking':     'ፈቃድ በመፈተሽ ላይ…',
  'lic.trialBanner':  '<b>ነጻ ሙከራዎቹ አልቀዋል።</b> ከላይ ያለውን የማሽን መለያ ይቅዱ፣ በመመሪያው መሰረት <b>2,500 ብር</b> በባንክ ያስተላልፉ፣ ከዚያ በቁልፍዎ ያግብሩ።',

  'log.title':        'መዝገብ',
  'log.hint':         'ሞተሩ እየሰራ ያለው (በእንግሊዝኛ)',
  'log.toggle':       'መዝገብ',
  'log.initial':      'ምንጭ ይምረጡ፣ አማራጮችን ያስተካክሉ፣ ከዚያ «ካፕሽን ፍጠር» ይጫኑ።',

  'foot.license':     'ፈቃድ 2,500 ብር · አንድ ጊዜ ብቻ',
  'foot.help':        '💬 እገዛ',
  'foot.helpTitle':   'በቴሌግራም እገዛ ያግኙ',
  'foot.diag':        'ምርመራ',
  'foot.credits':     'ምስጋና',
  'foot.creditsTitle':'የሞዴሉ ምስጋና',
  'foot.terms':       'ውሎች',
  'foot.termsTitle':  'የፈቃድ፣ የግላዊነት እና የተመላሽ ውሎች',

  'rev.title':        'ካፕሽኖችን ይገምግሙ',
  'rev.sub':          'ጽሑፍና ሰዓቱን ያስተካክሉ፣ ከዚያ በታይምላይኑ ላይ ያስቀምጡ',
  'rev.search':       'ካፕሽን ፈልግ…',
  'rev.searchTitle':  'ዝርዝሩን ለማጣራት ይጻፉ',
  'rev.add':          '+ ካፕሽን ጨምር',
  'rev.export':       'SRT/VTT/TXT አስቀምጥ',
  'rev.exportTitle':  'SRT፣ VTT እና TXT በመረጡት ፎልደር ያስቀምጡ',
  'rev.discard':      'ሰርዝ',
  'rev.place':        '✓ በታይምላይን ላይ አስቀምጥ',
};

// ── dynamic text from main.js / core.js (keyed by the English string) ───────
const AM_TEXT = {
  // status pill
  'idle': 'በመጠባበቅ ላይ',
  'ready': 'ዝግጁ',
  'working…': 'በመስራት ላይ…',
  '✓ Done': '✓ ተጠናቋል',
  '✓ Captions on timeline': '✓ ካፕሽኖቹ ታይምላይን ላይ ናቸው',
  'placement failed': 'ማስቀመጥ አልተሳካም',
  'trial credit required': 'የሙከራ ክሬዲት ያስፈልጋል',
  'failed': 'አልተሳካም',
  'runtime missing': 'ሞተሩ አልተገኘም',
  'runtime incomplete': 'ሞተሩ ያልተሟላ ነው',
  'model needed': 'ሞዴሉ መውረድ አለበት',

  // one-time model download card
  'Pause': 'ለአፍታ አቁም',
  'Resume download': 'ማውረዱን ቀጥል',
  '✓ Model ready': '✓ ሞዴሉ ዝግጁ ነው',
  'Download stopped. Check your internet and press Resume; it continues where it stopped.':
    'ማውረዱ ቆሟል። ኢንተርኔትዎን ፈትሸው «ማውረዱን ቀጥል» ይጫኑ፤ ካቆመበት ይቀጥላል።',

  // font pill + health rows
  'font: unknown': 'ፊደል፦ አልታወቀም',
  'font: install': 'ፊደል፦ ይጫኑ',
  'Could not detect installed fonts on this system.': 'በዚህ ኮምፒውተር ላይ የተጫኑ ፊደሎችን ማወቅ አልተቻለም።',
  'Transcription engine': 'የድምፅ ወደ ጽሑፍ ሞተር',
  'Amharic model': 'የአማርኛ ሞዴል',
  'Audio extractor': 'ድምፅ አውጪ',
  'Python runtime': 'Python ሩንታይም',
  'Amharic font': 'የአማርኛ ፊደል',
  'OK': 'ዝግጁ',
  'Missing': 'የለም',

  // license
  'Licensed': 'ፈቃድ አለው',
  'Trial used. Enter your license key above to continue.': 'ነጻ ሙከራዎቹ አልቀዋል። ለመቀጠል የፈቃድ ቁልፍዎን ከላይ ያስገቡ።',
  'Paste a license key first': 'መጀመሪያ የፈቃድ ቁልፍ ያስገቡ',
  'Validating…': 'በማረጋገጥ ላይ…',
  'Invalid key': 'ልክ ያልሆነ ቁልፍ',
  'Invalid key format': 'የቁልፉ ቅርጸት ልክ አይደለም',
  'Key is for a different machine': 'ቁልፉ የሌላ ኮምፒውተር ነው',
  'License expired': 'ፈቃዱ አብቅቷል',
  'License revoked — contact @sumpak6 on Telegram': 'ፈቃዱ ተሰርዟል — በቴሌግራም @sumpak6 ያግኙ',
  'Key not recognized — contact @sumpak6 on Telegram': 'ቁልፉ አልታወቀም — በቴሌግራም @sumpak6 ያግኙ',
  'Could not save the signed lease to this installation. Check folder permissions and try again.':
    'ፈቃዱን በዚህ ኮምፒውተር ላይ ማስቀመጥ አልተቻለም። የፎልደር ፈቃዶችን ፈትሸው እንደገና ይሞክሩ።',
  'Could not save the cached lease to this installation. Check folder permissions and try again.':
    'ፈቃዱን በዚህ ኮምፒውተር ላይ ማስቀመጥ አልተቻለም። የፎልደር ፈቃዶችን ፈትሸው እንደገና ይሞክሩ።',
  'Server returned no valid lease token. Contact support.': 'ሰርቨሩ ትክክለኛ ፈቃድ አልመለሰም። ድጋፍ ያግኙ።',
  'License server is not signing leases. Contact support.': 'የፈቃድ ሰርቨሩ አሁን እየሰራ አይደለም። ድጋፍ ያግኙ።',
  'Cached lease could not be verified.': 'የተቀመጠው ፈቃድ ሊረጋገጥ አልቻለም።',
  'Cannot verify license — no connection to the license server. Try again online.':
    'ፈቃዱን ማረጋገጥ አልተቻለም — ከሰርቨሩ ጋር ግንኙነት የለም። ኢንተርኔት ሲኖር እንደገና ይሞክሩ።',
  'Validation error': 'የማረጋገጫ ስህተት',
  'Malformed license token': 'ፈቃዱ ሊረጋገጥ አልቻለም',
  'License token is for a different machine': 'ፈቃዱ የሌላ ኮምፒውተር ነው',
  'No WebCrypto available': 'ፈቃዱ ሊረጋገጥ አልቻለም',
  'License token signature invalid': 'ፈቃዱ ሊረጋገጥ አልቻለም',
  'License token verification failed': 'ፈቃዱ ሊረጋገጥ አልቻለም',
  '✓ Copied': '✓ ተቀድቷል',

  // review overlay
  'Shift this caption −0.1s': 'ካፕሽኑን 0.1 ሰከንድ ወደ ኋላ',
  'Shift this caption +0.1s': 'ካፕሽኑን 0.1 ሰከንድ ወደ ፊት',
  'Split this caption into two': 'ካፕሽኑን ለሁለት ክፈል',
  'Merge this caption into the next': 'ከሚቀጥለው ካፕሽን ጋር አዋህድ',
  'Delete this caption': 'ይህን ካፕሽን ሰርዝ',
  'Start (m:ss.cc)': 'መጀመሪያ (m:ss.cc)',
  'End (m:ss.cc)': 'መጨረሻ (m:ss.cc)',
  'caption text': 'የካፕሽን ጽሑፍ',
  'No captions yet — click "+ Add cue".': 'እስካሁን ካፕሽን የለም — «+ ካፕሽን ጨምር» ይጫኑ።',
};

// Parameterised English → Amharic ($1.. are the regex groups).
const AM_PATTERNS = [
  [/^Trial: (\d+) free transcriptions? left$/, 'ሙከራ፦ $1 ነጻ ሙከራ ቀርቷል'],
  [/^Licensed \(expires (\d+)\)$/, 'ፈቃድ አለው (እስከ $1)'],
  [/^License expired on (.+)$/, 'ፈቃዱ $1 ላይ አብቅቷል'],
  [/^(\d+) captions?$/, '$1 ካፕሽን'],
  [/^Version (\d+\.\d+\.\d+) is available\.$/, 'አዲስ ስሪት $1 ወጥቷል።'],
  [/^⬇ Download the Amharic model \((\d+) MB\)$/, '⬇ የአማርኛ ሞዴሉን አውርድ ($1 MB)'],
  [/^Downloading… (\d+) \/ (\d+) MB$/, 'በማውረድ ላይ… $1 / $2 MB'],
  [/^Paused at (\d+) \/ (\d+) MB$/, 'ቆሟል፦ $1 / $2 MB'],
  [/^No captions match "(.*)"\.$/, '«$1» የሚል ካፕሽን የለም።'],
  [/^Captions will render in (.+)\. For the clearest Amharic, install "Abyssinica SIL" for free\.$/,
    'ካፕሽኖቹ በ$1 ፊደል ይታያሉ። ለጥሩ የአማርኛ ፊደል «Abyssinica SIL»ን በነጻ ይጫኑ።'],
  [/^No Ethiopic-capable font detected\. Install "Abyssinica SIL" \(free\) so captions render correctly in Premiere\.$/,
    'የአማርኛ ፊደል አልተገኘም። ካፕሽኖቹ በPremiere በትክክል እንዲታዩ «Abyssinica SIL» (ነጻ) ይጫኑ።'],
];

function T(en) {
  if (AMH_LANG !== 'am' || en == null) return en;
  const s = String(en);
  if (Object.prototype.hasOwnProperty.call(AM_TEXT, s)) return AM_TEXT[s];
  for (const [re, am] of AM_PATTERNS) {
    if (re.test(s)) return s.replace(re, am);
  }
  return s;
}

// ── static application ──────────────────────────────────────────────────────
function i18nApplyStatic(root) {
  root = root || document;
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const am = AMH_LANG === 'am';
  const each = (attr, fn) => {
    let nodes = [];
    try { nodes = root.querySelectorAll('[' + attr + ']'); } catch (e) { return; }
    for (let i = 0; i < nodes.length; i++) fn(nodes[i], nodes[i].getAttribute(attr));
  };
  // Text nodes: only rewrite content that is still one of our two variants, so
  // text a script has since replaced (e.g. the log) is never clobbered.
  each('data-i18n', (el, key) => {
    if (el.__i18nEn === undefined) el.__i18nEn = el.textContent;
    const target = am && AM_STATIC[key] ? AM_STATIC[key] : el.__i18nEn;
    const known = [el.__i18nEn, AM_STATIC[key]];
    if (known.indexOf(el.textContent) >= 0) el.textContent = target;
  });
  each('data-i18n-html', (el, key) => {
    if (el.__i18nEn === undefined) el.__i18nEn = el.innerHTML;
    el.innerHTML = am && AM_STATIC[key] ? AM_STATIC[key] : el.__i18nEn;
  });
  ['title', 'placeholder'].forEach((a) => {
    each('data-i18n-' + a, (el, key) => {
      const store = '__i18nEn_' + a;
      if (el[store] === undefined) el[store] = el.getAttribute(a) || '';
      el.setAttribute(a, am && AM_STATIC[key] ? AM_STATIC[key] : el[store]);
    });
  });
  try { document.documentElement.setAttribute('lang', am ? 'am' : 'en'); } catch (e) {}
  // Each toggle names the language you would switch TO.
  each('data-lang-toggle', (el) => {
    el.textContent = am ? 'EN' : 'አማ';
    el.setAttribute('title', am ? 'Switch to English' : 'ወደ አማርኛ ቀይር');
  });
}

const I18N_LISTENERS = [];
function i18nOnChange(fn) { I18N_LISTENERS.push(fn); }
function i18nSetLang(lang) {
  AMH_LANG = lang === 'en' ? 'en' : 'am';
  try { localStorage.setItem(I18N_KEY, AMH_LANG); } catch (e) {}
  i18nApplyStatic();
  I18N_LISTENERS.forEach((fn) => { try { fn(AMH_LANG); } catch (e) {} });
}

(function initI18n() {
  i18nApplyStatic();
  let toggles = [];
  try { toggles = document.querySelectorAll('[data-lang-toggle]'); } catch (e) {}
  for (let i = 0; i < toggles.length; i++) {
    toggles[i].addEventListener('click', () => i18nSetLang(AMH_LANG === 'am' ? 'en' : 'am'));
  }
})();
