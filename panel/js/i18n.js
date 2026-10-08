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
  'opt.speakers':     'የተናጋሪ ለውጥ አሳይ (2 ሰዎች) — ለቃለ መጠይቅ',
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
  'lic.buy':          'ፈቃድ ይግዙ — 2,500 ብር',
  'tc.titleLeft':     'ነጻ ካፕሽንዎ ተሰርቷል',
  'tc.titleLast':     'ነጻ ደቂቃዎችዎ አልቀዋል',
  'tc.titleCut':      'የዚህ ቪዲዮ ቀሪ ክፍል ፈቃድ ይፈልጋል',
  'tc.cut':           'ሙሉ ቪዲዮዎችን ለመስራት ፈቃድ ይግዙ — አንድ ጊዜ ብቻ፣ ወርሃዊ ክፍያ የለም።',
  'fm.hint':          'በቴሌግራም ቦታችን አንድ ጊዜ ይጫኑ፣ ከዚያ እዚህ ይመለሱ — በራሱ ይዘመናል። ደቂቃዎቹን በማንኛውም ቪዲዮ ይጠቀሙ።',
  'fm.button':        'በቴሌግራም ይቀበሉ',
  'tc.last':          'ካፕሽን መስራት ለመቀጠል ፈቃድ ይግዙ — አንድ ጊዜ ብቻ፣ ወርሃዊ ክፍያ የለም።',
  'tc.group':         '<b>ጥያቄ ወይም ችግር አለ?</b><span>በቴሌግራም ግሩፓችን ይጠይቁ — በፍጥነት እንመልሳለን፣ ኤዲተሮችም ጠቃሚ ምክሮችን ይጋራሉ።</span>',
  'tc.join':          'የቴሌግራም ግሩፑን ይቀላቀሉ',
  'tc.later':         'አሁን አይደለም',
  'lic.buyHint':      'ቴሌግራም ይከፈታል። <b>2,500 ብር</b> ለ<b>KALEB TEGEGEN</b> ይክፈሉና ስክሪንሾቱን እዚያ ይላኩ — <b>ከዚያ ይህ ፓነል በራሱ ይነቃል</b>። ምንም መቅዳት አያስፈልግም።',
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

  'foot.license':     'ፈቃድ 2,500 ብር · አንድ ጊዜ ብቻ',
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
  'No transcribable clips in that range.': 'በዚህ ክፍል ውስጥ ወደ ጽሑፍ የሚቀየር ክሊፕ የለም።',
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
  'Your free minutes are used up. Buy a license to keep making captions.': 'ነጻ ደቂቃዎችዎ አልቀዋል። ካፕሽን መስራት ለመቀጠል ፈቃድ ይግዙ።',
  'Connect to the internet for the free trial (a license works offline).': 'ለነጻ ሙከራ ኢንተርኔት ያገናኙ (ፈቃድ ያለው ያለ ኢንተርኔት ይሰራል)።',
  'This computer has no active license. Activate your license key (or connect to the internet for the free trial).': 'ይህ ኮምፒውተር ፈቃድ የለውም። የፈቃድ ቁልፍዎን ያስገቡ (ወይም ለነጻ ሙከራ ኢንተርኔት ያገናኙ)።',
  'Cannot reach the server — check the internet and try again.': 'ሰርቨሩን ማግኘት አልተቻለም — ኢንተርኔትዎን ፈትሸው እንደገና ይሞክሩ።',
  'Your request is being checked — we will tell you in Telegram.': 'ጥያቄዎ እየተረጋገጠ ነው — በቴሌግራም እንነግርዎታለን።',
  'Waiting for Telegram — press START there, then come back. This updates by itself.': 'ቴሌግራምን በመጠበቅ ላይ — እዚያ START ይጫኑ፣ ከዚያ ይመለሱ። ይህ በራሱ ይዘመናል።',
  'Your free minutes are used up.': 'ነጻ ደቂቃዎችዎ አልቀዋል።',
  'Buy a license (below) to keep making captions.': 'ካፕሽን መስራት ለመቀጠል ፈቃድ ይግዙ (ከታች)።',
  'Your free-minutes request is being checked — we will tell you in Telegram.': 'የነጻ ደቂቃዎች ጥያቄዎ እየተረጋገጠ ነው — በቴሌግራም እንነግርዎታለን።',
  'The free minutes of the stopped job were given back.': 'የቆመው ስራ ነጻ ደቂቃዎች ተመልሰዋል።',
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
  'Speaker 1 — tap to switch': 'ተናጋሪ 1 — ለመቀየር ይጫኑ',
  'Speaker 2 — tap to switch': 'ተናጋሪ 2 — ለመቀየር ይጫኑ',
  '2 speakers found — each change is marked with “–”': '2 ተናጋሪዎች ተገኝተዋል — የተናጋሪ ለውጥ በ «–» ይታያል',
  'One voice only — no speaker marks added': 'አንድ ድምፅ ብቻ — የተናጋሪ ምልክት አልተጨመረም',
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
  'Start (m:ss.cc)': 'መጀመሪያ (m:ss.cc)',
  'End (m:ss.cc)': 'መጨረሻ (m:ss.cc)',
  'caption text': 'የካፕሽን ጽሑፍ',
  'No captions yet — click "+ Add cue".': 'እስካሁን ካፕሽን የለም — «+ ካፕሽን ጨምር» ይጫኑ።',
};

// Parameterised English → Amharic ($1.. are the regex groups).
const AM_PATTERNS = [
  [/^Trial: (\d+) free transcriptions? left$/, 'ሙከራ፦ $1 ነጻ ሙከራ ቀርቷል'],
  [/^Free trial: (\d+:\d\d) minutes left$/, 'ነጻ ሙከራ፦ $1 ደቂቃ ቀርቷል'],
  [/^Try (\d+) minutes free$/, '$1 ደቂቃ በነጻ ይሞክሩ'],
  [/^You have (\d+:\d\d) free minutes left\.$/, '$1 ነጻ ደቂቃ ቀርቶዎታል።'],
  [/^Your free minutes covered the first (\d+:\d\d) of this video\.$/, 'ነጻ ደቂቃዎችዎ የዚህን ቪዲዮ የመጀመሪያ $1 ሸፍነዋል።'],
  [/^Get your (\d+) free minutes in Telegram first — the button above the license\.$/, 'መጀመሪያ $1 ነጻ ደቂቃዎችዎን በቴሌግራም ይቀበሉ — ከፈቃዱ በላይ ያለው ቁልፍ።'],
  [/^Free trial: (\d+:\d\d) of free minutes for this job, (\d+:\d\d) left\.$/, 'ነጻ ሙከራ፦ ለዚህ ስራ $1 ደቂቃ፣ $2 ቀርቷል።'],
  [/^✓ (\d+:\d\d) free minutes are ready — press Generate\.$/, '✓ $1 ነጻ ደቂቃዎች ዝግጁ ናቸው — ካፕሽን ፍጠር ይጫኑ።'],
  [/^Licensed \(expires (\d+)\)$/, 'ፈቃድ አለው (እስከ $1)'],
  [/^License expired on (.+)$/, 'ፈቃዱ $1 ላይ አብቅቷል'],
  [/^(\d+) captions?$/, '$1 ካፕሽን'],
  [/^(\d+) to check$/, '$1 ለማረጋገጥ'],
  [/^Version (\d+\.\d+\.\d+) is available\.$/, 'አዲስ ስሪት $1 ወጥቷል።'],
  [/^Extracting audio (\d+)\/(\d+)$/, 'ድምፅ በማውጣት ላይ $1/$2'],
  [/^Transcribing (\d+)\/(\d+)(.*)$/, function (m, a, b, rest) {
    rest = rest
      .replace(/ · about (\d+) min left/, ' · ወደ $1 ደቂቃ ቀርቷል')
      .replace(/ · (?:about |~)(\d+)s left/, ' · ወደ $1 ሰከንድ ቀርቷል')
      .replace(/ · 🔌 plug in the charger to go faster/, ' · 🔌 ቻርጀር ይሰኩ — ይፈጥናል');
    return 'ወደ ጽሑፍ በመቀየር ላይ ' + a + '/' + b + rest;
  }],
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
