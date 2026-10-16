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
  'app.title':        'አማርኛ ካፕሽን ፕሮ',
  'app.sub':          '100% ያለ ኢንተርኔት',
  'font.checking':    'ፊደል በመፈተሽ ላይ…',
  'status.idle':      'በመጠባበቅ ላይ',

  'ob.pick':          '<b>ክሊፕ ይምረጡ</b><span>በታይምላይኑ ላይ ማንኛውንም ክሊፕ ይምረጡ፣ ወይም ዎርክ ኤሪያ / ሙሉ ኤዲት ይጠቀሙ።</span>',
  'ob.style':         '<b>የካፕሽን አይነት ይምረጡ</b><span>ካራኦኬ (አንድ ቃል በአንድ ጊዜ) ወይም በቡድን (በአንድ ካፕሽን 3 ቃላት)።</span>',
  'ob.generate':      '<b>ካፕሽን ይፍጠሩ</b><span>ካፕሽኖቹ በታይምላይኑ ላይ (Premiere) ወይም እንደ ቴክስት ሌየር (After Effects) ይቀመጣሉ — ሙሉ በሙሉ ያለ ኢንተርኔት፣ በኮምፒውተርዎ ላይ።</span>',
  'ob.health':        'መስተካከል ያለበት ነገር አለ',
  'ob.start':         'ካፕሽን መስራት ይጀምሩ',

  'update.download':  'አውርድ',
  'update.later':     'በኋላ አስታውሰኝ',
  'update.check':     '↻ ዝመና ይፈትሹ',
  'update.checkTitle':'አዲስ ስሪት እንዳለ ይፈትሹ',
  'recent.link':      '🕘 የቅርብ ጊዜ',
  'recent.linkTitle': 'ያስቀመጧቸውን ካፕሽኖች እንደገና ይክፈቱ',
  'recent.title':     '🕘 የቅርብ ጊዜ ካፕሽኖች',
  'recent.hint':      'አንዱን ነክተው ይክፈቱ፣ ያስተካክሉ፣ እንደገና ያስቀምጡ — የቀድሞውን ይተካል።',
  'wn.try':           'ይሞክሩት',
  'wn.closeTitle':    'ዝጋ',
  'cli.button':       'ደንበኛ',
  'clean.button':     '✂ ያጽዱ',
  'clean.title':      'ረጅም ዝምታዎችን፣ የተደገሙ አባባሎችንና የማመንታት ድምፆችን ይቆርጣል',

  'model.title':      'የአማርኛ ሞዴል',
  'model.hint':       'አንድ ጊዜ ብቻ የሚወርድ',
  'model.body':       'የአማርኛ ድምፅ ሞዴሉ <b>አንድ ጊዜ ብቻ</b> ወርዶ በዚህ ኮምፒውተር ይቀመጣል፣ ስለዚህ ቀጣይ ማሻሻያዎች ትንሽ ይሆናሉ። ኢንተርኔት ቢቋረጥ ካቆመበት ይቀጥላል።',

  'src.title':        'ምንጭ',
  'src.hint':         'ምን ላይ ካፕሽን ይሰራ',
  'src.clip':         'የተመረጠ ክሊፕ',
  'src.work':         'ዎርክ ኤሪያ',
  'src.whole':        'ሙሉ ኤዲት',
  'src.clip.ae':      'የተመረጠ ሌየር',
  'src.whole.ae':     'ሙሉ ኮምፕ',

  'opt.title':        'አማራጮች',
  'opt.style':        'የካፕሽን አይነት',
  'opt.karaoke':      'ካራኦኬ',
  'opt.grouped':      'በቡድን',
  'opt.words':        'ቃላት በአንድ ካፕሽን',
  'opt.format':       'የቪዲዮ ቅርጽ',
  'fa.noTitle':       'እንዳሉ ይተዉ',
  'opt.fmtH':         '🖥 አግድም · YouTube',
  'opt.fmtV':         '📱 ቁም · TikTok',

  'run.title':        'ፍጠር',
  'run.hint':         'ወደ ጽሑፍ ቀይር እና ገምግም',
  'run.button':       '▶ ካፕሽን ፍጠር',
  'run.cancel':       'አቁም',
  'run.cancelTitle':  'ይህን ስራ አቁም',

  'lic.copyLabel':    'የማሽን መለያ — ድጋፍ ከጠየቀ ብቻ',
  'lic.copy':         '📋 ቅዳ',
  'lic.copyTitle':    'የማሽን መለያውን ቅዳ',
  'lic.midTitle':     'ሁሉንም ለመምረጥ ይጫኑ',
  'lic.buy':          'ፈቃድ ይግዙ — ከ500 ብር ጀምሮ',
  'tc.titleLeft':     'ነጻ ካፕሽንዎ ተሰርቷል',
  'tc.titleLast':     'ነጻ ደቂቃዎችዎ አልቀዋል',
  'tc.titleCut':      'የዚህ ቪዲዮ ቀሪ ክፍል ፈቃድ ይፈልጋል',
  'tc.cut':           'ሙሉ ቪዲዮዎችን ለመስራት ፈቃድ ይግዙ — በወር ከ500 ብር፣ ወይም አንድ ጊዜ ለዘለቄታው።',
  'fm.hint':          'በቴሌግራም ቦታችን አንድ ጊዜ ይጫኑ፣ ከዚያ እዚህ ይመለሱ — በራሱ ይዘመናል። ደቂቃዎቹን በማንኛውም ቪዲዮ ይጠቀሙ።',
  'fm.button':        'በቴሌግራም ይቀበሉ',
  'rep.button':       '📨 የችግር ሪፖርት ይላኩ',
  'fb.link':          '💡 ሀሳብ',
  'fb.linkTitle':     'ሀሳብ፣ ችግር ወይም ጥያቄ ይላኩልን',
  'fb.title':         '💡 ሀሳብዎን ይንገሩን',
  'fb.sub':           'ሀሳብ፣ ችግር ወይም ጥያቄ — በቀጥታ አማርኛ ካፕሽንን ለሚሰሩት ሰዎች ይደርሳል።',
  'fb.placeholder':   'እዚህ ይጻፉ…',
  'fb.tg':            'የቴሌግራም @username ዎ (ካልፈለጉ ይተዉት — እንድንመልስልዎ)',
  'fb.send':          'ላክ',
  'fb.close':         'ዝጋ',
  'rep.hint':         'ችግሩን እንድናስተካክል ስህተቱንና Log ን ይልክልናል — ቪዲዮ፣ ድምፅ ወይም ካፕሽን አይላክም።',
  'tc.last':          'ካፕሽን መስራት ለመቀጠል ፈቃድ ይግዙ — በወር ከ500 ብር፣ ወይም አንድ ጊዜ ለዘለቄታው።',
  'tc.group':         '<b>ጥያቄ ወይም ችግር አለ?</b><span>በቴሌግራም ግሩፓችን ይጠይቁ — በፍጥነት እንመልሳለን፣ ኤዲተሮችም ጠቃሚ ምክሮችን ይጋራሉ።</span>',
  'tc.join':          'የቴሌግራም ግሩፑን ይቀላቀሉ',
  'tc.later':         'አሁን አይደለም',
  'lic.buyHint':      'ቴሌግራም ይከፈታል። <b>1 ወር (500 ብር)</b>፣ <b>2 ወር (900 ብር)</b> ወይም <b>ለዘለቄታው (2,500 ብር)</b> ይምረጡ፣ ለ<b>KALEB TEGEGEN</b> ይክፈሉና ስክሪንሾቱን እዚያ ይላኩ — <b>ከዚያ ይህ ፓነል በራሱ ይነቃል</b>። ምንም መቅዳት አያስፈልግም።',
  'lic.bankLink':     'የባንክ አካውንቶች',
  'lic.bankName':     'የአካውንት ስም፦ <b>KALEB TEGEGEN</b> — ለሌላ ሰው አይክፈሉ።',
  'lic.mismatch':     '⚠️ <b>ይህ የማሽን መዝገብ የተፈጠረው በሌላ ኮምፒውተር ላይ ነው።</b> ቁልፍ ገዝተው እንደገና ከጫኑ፣ ፈቃዱን ወደዚህ ለማዛወር ድጋፍ ያግኙ — ሁለተኛ አይግዙ።',
  'lic.licensed':     '✓ <b>ፈቃድ አለዎት።</b> ስለገዙ እናመሰግናለን።',
  'lic.keyLabel':     'የማግበሪያ ኮድ ወይም የፈቃድ ቁልፍ',
  'lic.keyPlaceholder': 'K7QD-3MXP  ·  AMH-…',
  'lic.activate':     'አግብር',
  'lic.checking':     'ፈቃድ በመፈተሽ ላይ…',
  'lic.trialBanner':  '<b>ነጻ ሙከራዎቹ አልቀዋል</b> — ካፕሽን መስራት ለመቀጠል ከታች ፈቃድ ይግዙ።',

  'log.toggle':       'ለድጋፍ ዝርዝር መረጃ',
  'log.initial':      'ምንጭ ይምረጡ፣ አማራጮችን ያስተካክሉ፣ ከዚያ «ካፕሽን ፍጠር» ይጫኑ።',

  'foot.license':     'ፈቃድ ከ500 ብር ጀምሮ',
  'foot.help':        '💬 እገዛ',
  'foot.helpTitle':   'በቴሌግራም እገዛ ያግኙ',
  'foot.diag':        'ምርመራ አድርግ',
  'foot.credits':     'ስለ ምርቱ',
  'foot.creditsTitle':'ስሪትና ምስጋና',
  'foot.terms':       'ውሎች',
  'foot.termsTitle':  'የፈቃድ፣ የግላዊነት እና የተመላሽ ውሎች',

  'rev.title':        'ካፕሽኖችን ይገምግሙ',
  'rev.sub':          'ጽሑፍና ሰዓቱን ያስተካክሉ፣ ከዚያ በታይምላይኑ ላይ ያስቀምጡ',
  'rev.add':          '+ ካፕሽን ጨምር',
  'rev.export':       'የሰብታይትል ፋይሎችን አስቀምጥ',
  'rev.exportTitle':  'SRT፣ VTT እና TXT በመረጡት ፎልደር ያስቀምጡ',
  'rev.discard':      'ተወው',
  'rev.place.ae':     '✓ ወደ ኮምፖዚሽኑ ጨምር',
  'rev.sub.ae':       'ጽሑፍና ሰዓቱን ያስተካክሉ፣ ከዚያ ወደ ኮምፖዚሽኑ ይጨምሩ',
  'rev.place':        '✓ በታይምላይን ላይ አስቀምጥ',
  'style.title':      '🎨 የካፕሽን ስታይል',
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

  // failure messages shown under Generate (main.js humanError)
  'That clip is too short to transcribe.': 'ክሊፑ ወደ ጽሑፍ ለመቀየር በጣም አጭር ነው።',
  'No speech found in that audio.': 'በድምፁ ውስጥ ንግግር አልተገኘም።',
  'Make the selected word pop': 'የተመረጠውን ቃል ጎልቶ እንዲታይ ያድርጉ',
  'Drag: when this caption starts': 'ይጎትቱ፦ ይህ ካፕሽን የሚጀምርበት',
  'Clean up': 'ማጽዳት',
  'Cuts long pauses, repeated takes and እ… sounds — on a copy of your sequence.': 'ረጅም ዝምታዎችን፣ የተደገሙ አባባሎችንና እ… ድምፆችን ይቆርጣል — በሴኩዌንስዎ ቅጂ ላይ።',
  'Listening for pauses…': 'ዝምታዎችን እያዳመጠ ነው…',
  'Done': 'ተጠናቀቀ',
  'removed': 'ተቆርጧል',
  'is open. Your captions moved with the cuts: press Place to put them on it.': 'ተከፍቷል። ካፕሽኖችዎ ከቁርጡ ጋር ተስተካክለዋል፤ በእሱ ላይ ለማስቀመጥ Place ይጫኑ።',
  'Pauses longer than': 'ከዚህ የሚረዝሙ ዝምታዎች',
  'Pauses: your footage could not be read here — repeats and sounds only.': 'ዝምታዎች፦ ቪዲዮዎ እዚህ ሊነበብ አልቻለም — የተደገሙና ድምፆች ብቻ።',
  'Pause': 'ዝምታ',
  'Repeated take': 'የተደገመ',
  'Sound': 'ድምፅ',
  'Filler word?': 'ሙሌት ቃል?',
  'Nothing to clean — it is already tight.': 'የሚጸዳ ነገር የለም — አስቀድሞ ጥብቅ ነው።',
  'Listen: moves the playhead here': 'ያዳምጡ፦ ማጫወቻውን ወደዚህ ያንቀሳቅሳል',
  'Removes': 'የሚቆረጠው',
  'of': 'ከ',
  'Cut on a copy of the sequence': 'በሴኩዌንሱ ቅጂ ላይ ይቁረጡ',
  'Cutting': 'እየቆረጠ ነው',
  'Stop': 'ያቁሙ',
  'Stopping…': 'እያቆመ ነው…',
  'Stopped — nothing was cut.': 'ቆሟል — ምንም አልተቆረጠም።',
  'Stopped after': 'ቆሟል፦',
  'cuts — the ones nearer the start were not cut.': 'ቁርጦች ተደርገዋል — ወደ መጀመሪያው ያሉት አልተቆረጡም።',
  'The clean copy is no longer the open sequence. Open it, then press Cut again.': 'የጸዳው ቅጂ አሁን የተከፈተው ሴኩዌንስ አይደለም። ከፍተውት እንደገና «ይቁረጡ» ይጫኑ።',
  'Your sequence stays as it is; the clean copy opens next to it. Clean up before you place the captions.': 'ሴኩዌንስዎ እንዳለ ይቆያል፤ የጸዳው ቅጂ አጠገቡ ይከፈታል። ካፕሽኖቹን ከማስቀመጥዎ በፊት ያጽዱ።',
  'Premiere did not answer.': 'Premiere መልስ አልሰጠም።',
  'Nothing to cut.': 'የሚቆረጥ ነገር የለም።',
  'The open sequence is not the one these captions were made from. Open that sequence, then press Cut again.': 'የተከፈተው ሴኩዌንስ እነዚህ ካፕሽኖች የተሠሩበት አይደለም። ያንን ሴኩዌንስ ከፍተው እንደገና «ይቁረጡ» ይጫኑ።',
  'A track is locked. Unlock all tracks (the lock icons), then press Cut again.': 'አንድ ትራክ ተቆልፏል። ሁሉንም ትራኮች ይክፈቱ (የቁልፍ ምልክቶቹ)፣ ከዚያ እንደገና «ይቁረጡ» ይጫኑ።',
  'Premiere could not copy the sequence. Nothing was cut.': 'Premiere ሴኩዌንሱን መቅዳት አልቻለም። ምንም አልተቆረጠም።',
  'Premiere could not open the copy of the sequence. Nothing was cut.': 'Premiere የሴኩዌንሱን ቅጂ መክፈት አልቻለም። ምንም አልተቆረጠም።',
  'Drag: when this caption ends': 'ይጎትቱ፦ ይህ ካፕሽን የሚያልቅበት',
  'Make the word at the cursor pop (★ again: back to normal)': 'ጠቋሚው ያለበትን ቃል ጎልቶ እንዲታይ ያድርጉ (እንደገና ★፦ ወደ መደበኛ)',
  'Pop words': 'ጎልተው የሚታዩ',
  'Numbers too': 'ቁጥሮችንም',
  'My ★ only': 'የመረጥኩትን ★ ብቻ',
  '★ = click a word in a caption, then press the ★ next to it. Numbers and money can pop by themselves.':
    '★ = በካፕሽኑ ውስጥ ቃል ይንኩ፣ ከዚያ አጠገቡ ያለውን ★ ይጫኑ። ቁጥሮችና ብር ራሳቸው ጎልተው ሊታዩ ይችላሉ።',
  'Emphasis': 'ጎልቶ ማሳያ',
  'Numbers & ★': 'ቁጥሮች እና ★',
  '★ only': '★ ብቻ',
  'No captions placed yet.': 'እስካሁን ምንም ካፕሽን አልተቀመጠም።',
  'Remove from this list': 'ከዝርዝሩ ያስወግዱ',
  'This precomp has no layer with sound in that part. Open it and select the layer, or use Whole comp.':
    'ይህ precomp በዚህ ክፍል ድምፅ ያለው ንብርብር የለውም። ይክፈቱትና ንብርብሩን ይምረጡ፣ ወይም Whole comp ይጠቀሙ።',
  'This nested sequence has no clip with sound in that part. Open it and select the clip, or use Whole edit.':
    'ይህ የተጠቃለለ ሲክዌንስ (nested sequence) በዚህ ክፍል ድምፅ ያለው ክሊፕ የለውም። ይክፈቱትና ክሊፑን ይምረጡ፣ ወይም Whole edit ይጠቀሙ።',
  'That is a caption layer made by Amharic Captions. Select your video or audio clip instead.':
    'ይህ በAmharic Captions የተሰራ የካፕሽን ንብርብር ነው። እባክዎ የቪዲዮ ወይም የድምፅ ክሊፕዎን ይምረጡ።',
  'This clip has no sound. Select the clip with the voice (usually on an audio track, A1), then try again.':
    'ይህ ክሊፕ ድምፅ የለውም። ድምፁ ያለበትን ክሊፕ ይምረጡ (ብዙ ጊዜ በኦዲዮ ትራክ ላይ፣ A1)፣ ከዚያ እንደገና ይሞክሩ።',
  'No transcribable clips in that range.': 'በዚህ ክፍል ውስጥ ወደ ጽሑፍ የሚቀየር ክሊፕ የለም።',
  'These clips have a speed change or play in reverse, so captions cannot follow them. Set the speed to 100% (right-click › Speed/Duration), or export the audio and caption that file.':
    'የእነዚህ ክሊፖች ፍጥነት ተቀይሯል ወይም ወደ ኋላ ይጫወታሉ፤ ካፕሽኑ ሊከተላቸው አይችልም። ፍጥነቱን 100% ያድርጉ (Right-click › Speed/Duration)፣ ወይም ድምፁን Export አድርገው ያንን ፋይል ካፕሽን ያድርጉ።',
  'These clips have no media file (titles, graphics, adjustment layers). Put the video or audio with the speech on the timeline, then try again.':
    'እነዚህ ክሊፖች የሚዲያ ፋይል የላቸውም (ርዕስ፣ ግራፊክስ፣ Adjustment Layer)። ንግግሩ ያለበትን ቪዲዮ ወይም ድምፅ ታይምላይኑ ላይ ያድርጉ፣ ከዚያ እንደገና ይሞክሩ።',
  'There are no clips on this timeline. Open the sequence with your video, then try again.':
    'በዚህ ታይምላይን ላይ ምንም ክሊፕ የለም። ቪዲዮዎ ያለበትን Sequence ይክፈቱ፣ ከዚያ እንደገና ይሞክሩ።',
  'There are no video or audio layers in this composition.': 'በዚህ ኮምፖዚሽን ውስጥ ምንም ቪዲዮ ወይም ድምፅ የለም።',
  'Select a clip on the timeline (or put the playhead on it), then try again.':
    'በታይምላይኑ ላይ ክሊፕ ይምረጡ (ወይም ጠቋሚውን በላዩ ላይ ያድርጉ)፣ ከዚያ እንደገና ይሞክሩ።',
  'That item has no media file — try a regular video or audio clip.':
    'ይህ የሚዲያ ፋይል የለውም — መደበኛ ቪዲዮ ወይም የድምፅ ክሊፕ ይሞክሩ።',
  'Could not read that media file.': 'የሚዲያ ፋይሉን ማንበብ አልተቻለም።',
  'Your disk is full.': 'የኮምፒውተርዎ ዲስክ ሞልቷል።',
  'The transcription engine stopped unexpectedly.': 'የትራንስክሪፕሽን ሞተሩ ሳይታሰብ ቆሟል። እንደገና ይሞክሩ።',
  'The transcription runtime is missing or incomplete.': 'የትራንስክሪፕሽን ሞተሩ የለም ወይም ያልተሟላ ነው። እንደገና ይጫኑ።',
  'Your antivirus or an incomplete install blocked part of the transcription engine. Add the extension folder to your antivirus exclusions, then reinstall and restart Premiere.':
    'አንቲ-ቫይረስዎ ወይም ያልተሟላ ጭነት የትራንስክሪፕሽን ሞተሩን አንድ ክፍል አግዶታል። የኤክስቴንሽኑን ፎልደር ወደ አንቲ-ቫይረስዎ Exclusions ያክሉ፣ ከዚያ እንደገና ይጫኑና Premiere ን ዳግም ያስጀምሩ።',
  'Cancelled.': 'ተቋርጧል።',
  'Your free captions are used up. Activate your license key to continue.': 'ነጻ ሙከራዎቹ አልቀዋል። ለመቀጠል የፈቃድ ቁልፍዎን ያስገቡ።',
  'Connect to the internet once for a free caption (your license key works offline).': 'ለነጻ ሙከራ አንድ ጊዜ ኢንተርኔት ያገናኙ (ፈቃድ ያለው ያለ ኢንተርኔት ይሰራል)።',
  'Get your free minutes in Telegram first (the button above the license).': 'መጀመሪያ ነጻ ደቂቃዎችዎን በቴሌግራም ይቀበሉ (ከፈቃዱ በላይ ያለው ቁልፍ)።',
  // footer: the user's own "Check for updates" (also used to put the label back)
  '↻ Check for updates': '↻ ዝመና ይፈትሹ',
  'Checking…': 'በመፈተሽ ላይ…',
  'Could not check — no internet.': 'መፈተሽ አልተቻለም — ኢንተርኔት የለም።',
  'Your free minutes are used up. Buy a license to keep making captions.': 'ነጻ ደቂቃዎችዎ አልቀዋል። ካፕሽን መስራት ለመቀጠል ፈቃድ ይግዙ።',
  'Connect to the internet for the free trial (a license works offline).': 'ለነጻ ሙከራ ኢንተርኔት ያገናኙ (ፈቃድ ያለው ያለ ኢንተርኔት ይሰራል)።',
  'This computer has no active license. Activate your license key (or connect to the internet for the free trial).': 'ይህ ኮምፒውተር ፈቃድ የለውም። የፈቃድ ቁልፍዎን ያስገቡ (ወይም ለነጻ ሙከራ ኢንተርኔት ያገናኙ)።',
  'Cannot reach the server — check the internet and try again.': 'ሰርቨሩን ማግኘት አልተቻለም — ኢንተርኔትዎን ፈትሸው እንደገና ይሞክሩ።',
  'Your request is being checked — we will tell you in Telegram.': 'ጥያቄዎ እየተረጋገጠ ነው — በቴሌግራም እንነግርዎታለን።',
  'Your captions start by themselves when it is ready.': 'ሲጨርስ ካፕሽኑ በራሱ ይጀምራል።',
  'Try now': 'አሁን ሞክር',
  'Styling captions…': 'ካፕሽኑን በማስዋብ ላይ…',
  'Colour': 'ቀለም',
  'Customize': 'አስተካክል',
  'Any colour…': 'ሌላ ቀለም…',
  'Saved as': 'ተቀምጧል፦',
  'Delete': 'ሰርዝ',
  'Name, e.g. My channel': 'ስም፣ ለምሳሌ የኔ ቻናል',
  'Save as My style': 'እንደ የኔ ስታይል አስቀምጥ',
  'Text': 'ጽሑፍ',
  'Size': 'መጠን',
  'Position': 'ቦታ',
  'Words': 'ቃላት',
  'Box': 'ሳጥን',
  'Font': 'ፊደል',
  'Modern': 'ዘመናዊ',
  'Rounded': 'ክብ',
  'Classic': 'ክላሲክ',
  'Traditional': 'ባህላዊ',
  'Animation': 'አገባብ',
  'NEW': 'አዲስ',
  'None': 'የለም',
  '↑ Slide': '↑ ከታች',
  '↓ Slide': '↓ ከላይ',
  'Bottom': 'ታች',
  'Middle': 'መሃል',
  'Top': 'ላይ',
  'Auto': 'ራሱ',
  'Off': 'የለም',
  'On': 'አለ',
  'Reset': 'ወደ መጀመሪያው መልስ',
  'Style colour': 'የስታይሉ ቀለም',
  'Making the preview…': 'ናሙናውን በማዘጋጀት ላይ…',
  'No preview — the captions are still placed in this style.': 'ናሙና የለም — ካፕሽኑ ግን በዚህ ስታይል ይቀመጣል።',
  'Plain: the .srt file only — style it in your editor.': 'መደበኛ፦ .srt ፋይል ብቻ — በኤዲተርዎ ያስውቡት።',
  'Saves the video with these captions drawn in, next to your video.': 'ካፕሽኑ የተጻፈበትን ቪዲዮ ከቪዲዮዎ አጠገብ ያስቀምጣል።',
  'Drawn as a video layer on an empty track above your video.': 'ከቪዲዮዎ በላይ ባለ ባዶ ትራክ ላይ እንደ ቪዲዮ ንብርብር ይቀመጣል።',
  'Saves the video with these captions drawn in, next to your video. Free version: a small "Amharic Captions Pro" tag is added — a license removes it.': 'ካፕሽኑ የተጻፈበትን ቪዲዮ ከቪዲዮዎ አጠገብ ያስቀምጣል። በነጻ ስሪቱ ትንሽ «Amharic Captions Pro» ምልክት ይጨመራል — ፈቃድ ሲገዙ ይጠፋል።',
  'Drawn as a video layer on an empty track above your video. Free version: a small "Amharic Captions Pro" tag is added — a license removes it.': 'ከቪዲዮዎ በላይ ባለ ባዶ ትራክ ላይ እንደ ቪዲዮ ንብርብር ይቀመጣል። በነጻ ስሪቱ ትንሽ «Amharic Captions Pro» ምልክት ይጨመራል — ፈቃድ ሲገዙ ይጠፋል።',
  'Your free week has ended.': 'የነጻ ሙከራ ሳምንትዎ አብቅቷል።',
  'Your free week has ended. Buy a license to keep making captions.': 'የነጻ ሙከራ ሳምንትዎ አብቅቷል። ካፕሽን መስራት ለመቀጠል ፈቃድ ይግዙ።',
  'Connecting…': 'በመገናኘት ላይ…',
  '✓ Model ready — starting your captions.': '✓ ሞዴሉ ዝግጁ ነው — ካፕሽኑ እየጀመረ ነው።',
  'Press Generate (or "Download the Amharic model" at the top). It is a': '«ካፕሽን ፍጠር»ን ይጫኑ (ወይም ከላይ «የአማርኛ ሞዴሉን አውርድ»)። ይህ',
  'one-time download; if the connection drops it continues where it stopped.': 'አንድ ጊዜ ብቻ የሚወርድ ነው፤ ኢንተርኔት ቢቋረጥ ካቆመበት ይቀጥላል።',
  'Tap the button below — our Telegram bot opens.': 'ከታች ያለውን ቁልፍ ይጫኑ — የኛ የቴሌግራም ቦት ይከፈታል።',
  'Press START in Telegram.': 'በቴሌግራም START ይጫኑ።',
  'Come back here — your captions start by themselves.': 'ወደዚህ ይመለሱ — ካፕሽኑ በራሱ ይጀምራል።',
  'Waiting for Telegram… press START there. Your captions start by themselves.': 'ቴሌግራምን በመጠበቅ ላይ… እዚያ START ይጫኑ። ካፕሽኑ በራሱ ይጀምራል።',
  'Free, no payment. Already have a license key? Enter it below.': 'ነጻ ነው፣ ክፍያ የለውም። የፈቃድ ቁልፍ አለዎት? ከታች ያስገቡት።',
  '⏳ Your free minutes are being checked': '⏳ ነጻ ደቂቃዎችዎ እየተረጋገጡ ነው',
  'We check a few requests by hand. You will get a message in Telegram.': 'አንዳንድ ጥያቄዎችን በእጅ እናረጋግጣለን። በቴሌግራም መልዕክት ይደርስዎታል።',
  'Then press Generate again.': 'ከዚያ «ካፕሽን ፍጠር»ን እንደገና ይጫኑ።',
  'Already have a license key? Enter it below.': 'የፈቃድ ቁልፍ አለዎት? ከታች ያስገቡት።',
  '📶 Cannot reach our server': '📶 ከሰርቨራችን ጋር መገናኘት አልተቻለም',
  'The free minutes need the internet (a license works offline).': 'ነጻ ደቂቃዎቹ ኢንተርኔት ይፈልጋሉ (ፈቃድ ያለ ኢንተርኔት ይሰራል)።',
  'Check the internet, then tap Try again.': 'ኢንተርኔቱን ያረጋግጡ፣ ከዚያ «እንደገና ሞክር»ን ይጫኑ።',
  '↻ Try again': '↻ እንደገና ሞክር',
  '✓ Free minutes received — starting your captions.': '✓ ነጻ ደቂቃዎቹ ደርሰዋል — ካፕሽኑ እየጀመረ ነው።',
  'Waiting for Telegram — press START there, then come back. This updates by itself.': 'ቴሌግራምን በመጠበቅ ላይ — እዚያ START ይጫኑ፣ ከዚያ ይመለሱ። ይህ በራሱ ይዘመናል።',
  'Your free minutes are used up.': 'ነጻ ደቂቃዎችዎ አልቀዋል።',
  'Buy a license (below) to keep making captions.': 'ካፕሽን መስራት ለመቀጠል ፈቃድ ይግዙ (ከታች)።',
  'Your free-minutes request is being checked — we will tell you in Telegram.': 'የነጻ ደቂቃዎች ጥያቄዎ እየተረጋገጠ ነው — በቴሌግራም እንነግርዎታለን።',
  'The free minutes of the stopped job were given back.': 'የቆመው ስራ ነጻ ደቂቃዎች ተመልሰዋል።',
  'Sent — thank you. We will look at it and reply in Telegram.': 'ተልኳል — እናመሰግናለን። አይተን በቴሌግራም እንመልስልዎታለን።',
  'Write a few words first.': 'መጀመሪያ ጥቂት ቃላት ይጻፉ።',
  'Thank you! We read every message.': 'እናመሰግናለን! እያንዳንዱን መልእክት እናነባለን።',
  'Could not send — check the internet and try again.': 'መላክ አልተቻለም — ኢንተርኔትዎን ፈትሸው እንደገና ይሞክሩ።',
  'Could not send — check the internet and try again, or send a screenshot of the Log to @AmharicCaptionsBot.': 'መላክ አልተቻለም — ኢንተርኔትዎን ፈትሸው እንደገና ይሞክሩ፣ ወይም የLog ስክሪንሾት ለ@AmharicCaptionsBot ይላኩ።',
  'Your computer ran out of memory. Close other programs (Chrome, other editors), then try again.': 'የኮምፒውተሩ ሜሞሪ (RAM) አልበቃም። ሌሎች ፕሮግራሞችን (Chrome፣ ሌሎች ኤዲተሮች) ዘግተው እንደገና ይሞክሩ።',
  'Windows or an antivirus blocked the transcription engine. Allow Amharic Captions in your antivirus, then try again.': 'Windows ወይም አንቲቫይረስ የጽሑፍ መቀየሪያውን ከልክሎታል። በአንቲቫይረስዎ Amharic Captions ን ይፍቀዱ፣ ከዚያ እንደገና ይሞክሩ።',
  'The transcription engine stopped responding. Close other programs, plug in the charger, and try again.': 'የጽሑፍ መቀየሪያው መልስ መስጠት አቁሟል። ሌሎች ፕሮግራሞችን ዘግተው፣ ቻርጀር ሰክተው እንደገና ይሞክሩ።',
  'This computer has no active license. Activate your license key (or connect to the internet for a free caption).': 'ይህ ኮምፒውተር ፈቃድ የለውም። የፈቃድ ቁልፍዎን ያስገቡ (ወይም ለነጻ ሙከራ ኢንተርኔት ያገናኙ)።',
  'Transcription failed.': 'ወደ ጽሑፍ መቀየር አልተሳካም።',

  // progress under Generate
  'Transcribing…': 'ወደ ጽሑፍ በመቀየር ላይ…',
  'Transcription complete': 'ተጠናቋል',
  'Reading cached captions': 'የተቀመጡ ካፕሽኖችን በማንበብ ላይ',
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
  'This key is used on other computers — contact @sumpak6 on Telegram': 'ይህ ቁልፍ በሌሎች ኮምፒውተሮች ላይ እየተሰራበት ነው — በቴሌግራም @sumpak6 ያግኙ',
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
  'Paste your activation code or license key first': 'መጀመሪያ የማግበሪያ ኮድ ወይም የፈቃድ ቁልፍ ያስገቡ',
  'Checking your activation code…': 'የማግበሪያ ኮድዎን በመፈተሽ ላይ…',
  'Activation code not found — check the letters in the bot message.': 'የማግበሪያ ኮዱ አልተገኘም — በቦቱ መልዕክት ያሉትን ፊደሎች ያረጋግጡ።',
  'This activation code was already used on another computer. Contact @sumpak6 on Telegram.': 'ይህ ኮድ በሌላ ኮምፒውተር ላይ ተጠቅመውበታል። በቴሌግራም @sumpak6 ያግኙ።',
  'This computer already has a license — use your key from “My Key” in the bot.': 'ይህ ኮምፒውተር ቀድሞውኑ ፈቃድ አለው — ከቦቱ «ቁልፌ» ያለውን ቁልፍ ይጠቀሙ።',
  'Cannot reach the license server (or too many tries) — check the internet and try again in a few minutes.': 'ከፈቃድ ሰርቨሩ ጋር መገናኘት አልተቻለም (ወይም ብዙ ሙከራ) — ኢንተርኔቱን ፈትሸው ከጥቂት ደቂቃ በኋላ ይሞክሩ።',
  '⏳ Payment received — waiting for confirmation. This panel activates itself.': '⏳ ክፍያዎ ደርሷል — እየተረጋገጠ ነው። ይህ ፓነል በራሱ ይነቃል።',
  'After paying, send the screenshot to the bot in Telegram — this panel then activates itself.': 'ከከፈሉ በኋላ ስክሪንሾቱን በቴሌግራም ለቦቱ ይላኩ — ከዚያ ይህ ፓነል በራሱ ይነቃል።',
  '⚠️ The payment could not be confirmed — see the bot’s message in Telegram.': '⚠️ ክፍያው አልተረጋገጠም — በቴሌግራም የቦቱን መልዕክት ይመልከቱ።',
  '✓ Payment confirmed — activating…': '✓ ክፍያዎ ተረጋግጧል — በማግበር ላይ…',

  // review overlay
  'Shift this caption −0.1s': 'ካፕሽኑን 0.1 ሰከንድ ወደ ኋላ',
  'Shift this caption +0.1s': 'ካፕሽኑን 0.1 ሰከንድ ወደ ፊት',
  'Split this caption into two': 'ካፕሽኑን ለሁለት ክፈል',
  'Merge this caption into the next': 'ከሚቀጥለው ካፕሽን ጋር አዋህድ',
  'Delete this caption': 'ይህን ካፕሽን ሰርዝ',
  'More actions': 'ተጨማሪ',
  'Split at the cursor (Enter)': 'በጠቋሚው ቦታ ክፈል (Enter)',
  'Join with the next caption': 'ከሚቀጥለው ካፕሽን ጋር አገናኝ',
  'Add a caption below': 'ከታች ካፕሽን ጨምር',
  'Undo split': 'መከፈሉን መልስ',
  'Undo join': 'መገናኘቱን መልስ',
  'Undo delete': 'መሰረዙን መልስ',
  'Undo shift': 'ማሸጋገሩን መልስ',
  'Undo add': 'መጨመሩን መልስ',
  'Undo change all': '«ሁሉንም ቀይር»ን መልስ',
  'Undo the last change (Ctrl+Z)': 'የመጨረሻውን ለውጥ መልስ (Ctrl+Z)',
  'Change all': 'ሁሉንም ቀይር',
  'Always fix': 'ሁልጊዜ አርም',
  'Change this word in the other captions of this video': 'ይህን ቃል በዚህ ቪዲዮ ሌሎች ካፕሽኖች ውስጥ ቀይር',
  'Change this word in every caption now and in every new video': 'ይህን ቃል አሁን በሁሉም ካፕሽን እና በእያንዳንዱ አዲስ ቪዲዮ አርም',
  'Will be fixed automatically from now on': 'ከአሁን በኋላ በራሱ ይታረማል',
  'from memory': 'ከማስታወሻ',
  'Put back': 'መልስ',
  'Put the original word back in this caption': 'የቀድሞውን ቃል በዚህ ካፕሽን መልስ',
  'Stop fixing this word, and put the original back everywhere': 'ይህን ቃል ማረም አቁም፣ የቀድሞውንም በሁሉም ቦታ መልስ',
  'Forgotten — it will not be changed again': 'ተረስቷል — ከእንግዲህ አይቀየርም',
  'Undo put back': 'መመለሱን መልስ',
  'Undo forget': 'መርሳቱን መልስ',
  'Close': 'ዝጋ',
  'Memory': 'ማስታወሻ',
  'Remembered fixes': 'የተያዙ እርማቶች',
  'Words you taught the panel — they are fixed automatically in every new transcription.': 'ያስተማሩት ቃላት — በእያንዳንዱ አዲስ ትራንስክሪፕሽን በራሳቸው ይታረማሉ።',
  'Nothing remembered yet — fix a word, then tap “🧠 Remember”.': 'ገና የተያዘ እርማት የለም — አንድ ቃል አርመው «🧠 አስታውስ» ይጫኑ።',
  'Forget this fix': 'ይህን እርማት እርሳ',
  'Forget all': 'ሁሉንም እርሳ',
  'Tap again to forget all': 'ሁሉንም ለመርሳት እንደገና ይንኩ',
  // 👤 client words (a per-client list, kept on this computer only)
  'Client': 'ደንበኛ',
  'Client words': 'የደንበኛ ቃላት',
  'Choose a client — their names and words are fixed automatically': 'ደንበኛ ይምረጡ — ስሞቹና ቃላቱ በራሳቸው ይታረማሉ',
  'Choose a client — their names and words are fixed in that client’s videos only.': 'ደንበኛ ይምረጡ — ስሞቹና ቃላቱ በዚያ ደንበኛ ቪዲዮዎች ውስጥ ብቻ በራሳቸው ይታረማሉ።',
  'This client’s names and words — fixed automatically in this project.': 'የዚህ ደንበኛ ስሞችና ቃላት — በዚህ ፕሮጀክት ውስጥ በራሳቸው ይታረማሉ።',
  'This client’s words are fixed in this project': 'የዚህ ደንበኛ ቃላት በዚህ ፕሮጀክት ውስጥ ይታረማሉ',
  'Use this client in this project': 'ይህን ደንበኛ በዚህ ፕሮጀክት ይጠቀሙ',
  'Fix no client words in this project': 'በዚህ ፕሮጀክት ውስጥ የደንበኛ ቃል አይታረም',
  'No client': 'ደንበኛ የለም',
  'New client…': 'አዲስ ደንበኛ…',
  'Add a client of this computer': 'በዚህ ኮምፒውተር ላይ ደንበኛ ይጨምሩ',
  'Client name': 'የደንበኛ ስም',
  'Save': 'አስቀምጡ',
  'Cancel': 'ተዉት',
  'Add a word': 'ቃል ይጨምሩ',
  'Add a word to this client’s list': 'በዚህ ደንበኛ ዝርዝር ውስጥ ቃል ይጨምሩ',
  'Wrong word': 'የተሳሳተው ቃል',
  'Right word': 'ትክክለኛው ቃል',
  'For this client': 'ለዚህ ደንበኛ',
  'Fix this word in this client’s videos only': 'ይህን ቃል በዚህ ደንበኛ ቪዲዮዎች ውስጥ ብቻ ያርሙ',
  'Fixed in this client’s videos': 'በዚህ ደንበኛ ቪዲዮዎች ውስጥ ተስተካክሏል',
  'from the client list': 'ከደንበኛው ዝርዝር',
  'Stop fixing this word in this client’s videos, and put the original back everywhere': 'ይህን ቃል በዚህ ደንበኛ ቪዲዮዎች ውስጥ መስተካከል ያቁሙ፣ የቀድሞውንም በሁሉም ቦታ መልሱ',
  'Forget every word of this client': 'የዚህን ደንበኛ ቃላት ሁሉ ይርሱ',
  'Import': 'አስገቡ',
  'Export': 'አውጡ',
  'Import a client word list from a .txt or .json file': 'የደንበኛ ቃላት ዝርዝር ከ .txt ወይም .json ፋይል ያስገቡ',
  'Export this client’s list as .txt and .json': 'የዚህን ደንበኛ ዝርዝር እንደ .txt እና .json ያውጡ',
  'Nothing in this client’s list yet — fix a word in a caption, then tap “👤 For this client”, or add one here.': 'በዚህ ደንበኛ ዝርዝር ውስጥ ገና ምንም የለም — በካፕሽን ውስጥ አንድ ቃል አርመው «👤 ለዚህ ደንበኛ» ይጫኑ፣ ወይም እዚህ ይጨምሩ።',
  'Saved on this computer only — nothing is uploaded.': 'በዚህ ኮምፒውተር ላይ ብቻ ይቀመጣል — ወደ ኢንተርኔት አይላክም።',
  'Start (m:ss.cc)': 'መጀመሪያ (m:ss.cc)',
  'End (m:ss.cc)': 'መጨረሻ (m:ss.cc)',
  'caption text': 'የካፕሽን ጽሑፍ',
  'No captions yet — click "+ Add cue".': 'እስካሁን ካፕሽን የለም — «+ ካፕሽን ጨምር» ይጫኑ።',
};

// Parameterised English → Amharic ($1.. are the regex groups).
const AM_PATTERNS = [
  [/^Plain: (.+)'s own captions — you can edit and restyle them there\.$/, 'መደበኛ፦ የ$1 የራሱ ካፕሽን — እዚያው ማስተካከልና ማስዋብ ይችላሉ።'],
  [/^⏳ (.+) (\d+)%$/, function (m, a, n) { return '⏳ ' + T(a) + ' ' + n + '%'; }],
  [/^until (\d{4}-\d{2}-\d{2})$/, 'እስከ $1'],
  [/^First the Amharic model is downloaded \((\d+) MB, one time only\)\.$/, 'መጀመሪያ የአማርኛ ሞዴሉ ይወርዳል ($1 MB፣ አንድ ጊዜ ብቻ)።'],
  [/^Internet connection lost at (\d+) \/ (\d+) MB — trying again in (\d+) s\. Nothing downloaded is lost\.$/,
    'ኢንተርኔት ተቋርጧል ($1 / $2 MB) — በ$3 ሰከንድ ውስጥ እንደገና ይሞከራል። የወረደው አይጠፋም።'],
  [/^Downloading… (\d+) \/ (\d+) MB · about (\d+) min left$/, 'በማውረድ ላይ… $1 / $2 MB · ወደ $3 ደቂቃ ቀርቷል'],
  [/^Downloading… (\d+) \/ (\d+) MB · less than 2 min left$/, 'በማውረድ ላይ… $1 / $2 MB · ከ2 ደቂቃ ያነሰ ቀርቷል'],
  [/^🎁 First, get your (\d+) free minutes$/, '🎁 መጀመሪያ $1 ነጻ ደቂቃዎችዎን ይውሰዱ'],
  [/^🎁 Get (\d+) free minutes — 1 tap$/, '🎁 $1 ነጻ ደቂቃ ያግኙ — 1 ንክኪ'],
  [/^Trial: (\d+) free transcriptions? left$/, 'ሙከራ፦ $1 ነጻ ሙከራ ቀርቷል'],
  [/^Free trial: (\d+:\d\d) minutes left$/, 'ነጻ ሙከራ፦ $1 ደቂቃ ቀርቷል'],
  [/^Try (\d+) minutes free$/, '$1 ደቂቃ በነጻ ይሞክሩ'],
  [/^You have (\d+:\d\d) free minutes left\.$/, '$1 ነጻ ደቂቃ ቀርቶዎታል።'],
  [/^Your free minutes covered the first (\d+:\d\d) of this video\.$/, 'ነጻ ደቂቃዎችዎ የዚህን ቪዲዮ የመጀመሪያ $1 ሸፍነዋል።'],
  [/^Get your (\d+) free minutes in Telegram first — the button under Generate\.$/, 'መጀመሪያ $1 ነጻ ደቂቃዎችዎን በቴሌግራም ይቀበሉ — ከ«ካፕሽን ፍጠር» በታች ያለውን ቁልፍ ይጫኑ።'],
  [/^Free trial: (\d+:\d\d) of free minutes for this job, (\d+:\d\d) left\.$/, 'ነጻ ሙከራ፦ ለዚህ ስራ $1 ደቂቃ፣ $2 ቀርቷል።'],
  [/^✓ (\d+:\d\d) free minutes are ready — press Generate\.$/, '✓ $1 ነጻ ደቂቃዎች ዝግጁ ናቸው — ካፕሽን ፍጠር ይጫኑ።'],
  [/^Licensed \(expires (\d+)\)$/, 'ፈቃድ አለው (እስከ $1)'],
  [/^License expired on (.+)$/, 'ፈቃዱ $1 ላይ አብቅቷል'],
  [/^Licensed until (\d{4}-\d{2}-\d{2})$/, 'ፈቃድ አለው — እስከ $1'],
  [/^(\d+) captions?$/, '$1 ካፕሽን'],
  [/^(\d+) to check$/, '$1 ለማረጋገጥ'],
  [/^Version (\d+\.\d+\.\d+) is available\.$/, 'አዲስ ስሪት $1 ወጥቷል።'],
  [/^You are up to date \(v(\d+\.\d+\.\d+)\)\.$/, 'አዲሱ ስሪት አለዎት (v$1)።'],
  [/^What's new in (\d+\.\d+\.\d+)$/, 'በስሪት $1 አዲስ የመጣ'],
  [/^Extracting audio (\d+)\/(\d+)$/, 'ድምፅ በማውጣት ላይ $1/$2'],
  [/^Transcribing (\d+)\/(\d+)(.*)$/, function (m, a, b, rest) {
    rest = rest
      .replace(/ · about (\d+) min left/, ' · ወደ $1 ደቂቃ ቀርቷል')
      .replace(/ · (?:about |~)(\d+)s left/, ' · ወደ $1 ሰከንድ ቀርቷል')
      .replace(/ · 🔌 plug in the charger to go faster/, ' · 🔌 ቻርጀር ይሰኩ — ይፈጥናል');
    return 'ወደ ጽሑፍ በመቀየር ላይ ' + a + '/' + b + rest;
  }],
  [/^The Work Area bar is not over your clips \(they are at ([\d:]+)–([\d:]+)\)\. Drag the Work Area bar over them, or choose Whole Edit\.$/,
    'የWork Area አሞሌው ክሊፖችዎ ላይ አይደለም (ክሊፖችዎ $1–$2 ላይ ናቸው)። አሞሌውን ወደ ክሊፖቹ ይጎትቱት፣ ወይም «ሙሉ ኤዲት»ን ይምረጡ።'],
  [/^(.+) See “Details for support” below\.$/, function (m, inner) {
    return T(inner) + ' ዝርዝሩ ከታች «ለድጋፍ ዝርዝር መረጃ» ውስጥ አለ።';
  }],
  [/^⬇ Download the Amharic model \((\d+) MB\)$/, '⬇ የአማርኛ ሞዴሉን አውርድ ($1 MB)'],
  [/^Downloading… (\d+) \/ (\d+) MB$/, 'በማውረድ ላይ… $1 / $2 MB'],
  [/^Paused at (\d+) \/ (\d+) MB$/, 'ቆሟል፦ $1 / $2 MB'],
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
