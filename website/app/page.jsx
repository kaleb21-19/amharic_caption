import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import PanelMock from "@/components/PanelMock";
import Tx from "@/components/Tx";
import {
  BOT_URL, ACCT_NAME, PRICE, PRICE_AM, PRICE_NUM, PRICE_OLD_NUM, PRICE_M1_NUM, PRICE_M2_NUM,
} from "@/lib/site";

const steps = [
  {
    n: "1",
    title: { am: "አንድ ጊዜ ይጫኑ", en: "Install once" },
    text: {
      am: "ጫኚውን ሁለቴ ይጫኑ። አንድ ደቂቃ ገደማ ይወስዳል፤ የቴክኒክ እውቀት አያስፈልግም። Premiere እና After Effects ውስጥ ፓነል፣ ዴስክቶፕ ላይ ደግሞ ለCapCut እና DaVinci «Amharic Captions Studio» ያገኛሉ።",
      en: "Double-click the installer — about a minute, no technical skills needed. You get a panel inside Premiere and After Effects, and Amharic Captions Studio on your desktop for CapCut and DaVinci.",
    },
  },
  {
    n: "2",
    title: { am: "ቪዲዮ ወይም ክሊፕ ይምረጡ", en: "Pick your video" },
    text: {
      am: "Premiere ላይ ክሊፕ፣ Work Area ወይም ሙሉ ኤዲቱን ይምረጡ፤ ለCapCut ወይም DaVinci ቪዲዮውን ወደ Studio ይጎትቱ። ካፕሽኖቹ ያለ ኢንተርኔት በደቂቃዎች ይጻፋሉ።",
      en: "In Premiere select a clip, the work area or the whole sequence; for CapCut or DaVinci drag the video into the Studio. The captions are written in minutes, offline.",
    },
  },
  {
    n: "3",
    title: { am: "ያርሙ፣ ስታይል ይምረጡ፣ ይላኩ", en: "Fix, style, send" },
    text: {
      am: "አጠራጣሪ ቃላትን አንድ በአንድ ያረጋግጡ፣ ከ19 ስታይሎች አንዱን ይምረጡ፣ ከዚያ ወደ Premiere ታይምላይን፣ ወደ CapCut ወይም ወደ DaVinci ይላኩ — ወይም ካፕሽኑ የተጻፈበት MP4 ቪዲዮ ያውጡ።",
      en: "Check the doubtful words one by one, pick one of 19 styles, then send the captions to your Premiere timeline, CapCut or DaVinci — or export an MP4 with the captions burned in.",
    },
  },
];

// The four editors, each with what actually happens there.
const editors = [
  {
    icon: "Pr", name: "Premiere Pro",
    text: {
      am: "ፓነሉ ውስጥ ይስሩ። ካፕሽኖቹ በመረጡት ስታይል በታይምላይኑ ላይ ይገባሉ — እያንዳንዱ ካፕሽን የራሱ ክሊፕ ነው፤ አንዱን ቢያርሙ ያ ብቻ ይቀየራል። ቀላል የካፕሽን ትራክም ይቻላል።",
      en: "Work in the panel. Captions land on your timeline in the style you chose — each caption its own clip, so fixing one redraws only that one. A plain caption track works too.",
    },
  },
  {
    icon: "Ae", name: "After Effects",
    text: {
      am: "ያው ፓነል — ካፕሽኖቹ በመረጡት ስታይል በኮምፖዚሽንዎ ውስጥ ይገባሉ፣ ለተጨማሪ አኒሜሽን ዝግጁ።",
      en: "The same panel — captions arrive in your composition in the style you chose, ready for more animation.",
    },
  },
  {
    icon: "✂", name: "CapCut",
    text: {
      am: "Studio በአንድ ጠቅታ አዲስ የCapCut ፕሮጀክት ይሰራል — ቪዲዮው፣ በስታይሉ ያሉ ካፕሽኖችና አኒሜሽናቸው ውስጥ ሆነው። እያንዳንዱ ካፕሽን የሚታረም የCapCut ጽሑፍ ነው። ያለዎትን ፕሮጀክትም ካፕሽን ማድረግና ማዘመን ይችላሉ።",
      en: "One click in the Studio makes a new CapCut project — the video, the styled captions and their animation already inside. Every caption is a normal, editable CapCut text. Your own projects can be captioned and updated too.",
    },
  },
  {
    icon: "◐", name: "DaVinci Resolve",
    text: {
      am: "ካፕሽኖቹ በስታይሉ፣ እንደሚታረሙ Text+ በTimelineዎ ላይ ይገባሉ (Workspace → Scripts → Amharic Captions)። ቪዲዮዎ አይነካም። ነፃው DaVinci Resolveም ይሰራል።",
      en: "Captions arrive styled, as editable Text+ on your timeline (Workspace → Scripts → Amharic Captions). Your video isn't touched. Works in the free DaVinci Resolve too.",
    },
  },
];

// More than captions: what an editor actually gets (each one in the product today).
const features = [
  {
    icon: "Aa",
    title: { am: "19 ስታይሎች · 12 የአማርኛ ፎንቶች", en: "19 styles · 12 Amharic fonts" },
    text: {
      am: "ካራኦኬ፣ Bounce፣ Neon፣ Habesha… Typewriter እና Wave አኒሜሽን፣ በአንድ ወይም በሁለት መስመር። የራስዎን ስታይል አስቀምጠው በአንድ ጠቅታ ይጠቀሙ።",
      en: "Karaoke, Bounce, Neon, Habesha… Typewriter and Wave animation, on one line or two. Save your own look and reuse it in one click.",
    },
  },
  {
    icon: "✓",
    title: { am: "ቃላትን አንድ በአንድ ያረጋግጡ", en: "Check words one by one" },
    text: {
      am: "አጠራጣሪ ቃላት ይደምቃሉ፤ እያንዳንዱን ይሰሙታል። Enter = ትክክል፣ ይጻፉ = ያርሙ። ከ69,000 ቃላት የአማርኛ መዝገበ ቃላት ምክር ይሰጣል።",
      en: "Doubtful words are highlighted and play one by one. Enter = right, type = fix. Suggestions come from a 69,000-word Amharic dictionary.",
    },
  },
  {
    icon: "🧠",
    title: { am: "ቃላትዎን ይማራል", en: "Learns your words" },
    text: {
      am: "አንድ ጊዜ ያረሙት ቃል በሚቀጥለው ቪዲዮ በራሱ ይስተካከላል። ለእያንዳንዱ ደንበኛ የራሱ ስሞችና ቃላት።",
      en: "A word you fix once is fixed by itself in the next video. Each client keeps their own names and terms.",
    },
  },
  {
    icon: "✂",
    title: { am: "ቪዲዮውን በጽሑፍ ያርሙ", en: "Edit the video with text" },
    text: {
      am: "ቃላትን ይምረጡና ✂ ይጫኑ — ያ የቪዲዮው ክፍል ይቆረጣል፣ ካፕሽኖቹም አብረው ይንቀሳቀሳሉ።",
      en: "Select words and press ✂ — that part of the video is cut, and the captions move with it.",
    },
  },
  {
    icon: "⏸",
    title: { am: "ጸጥታን ያጽዱ", en: "Clean the silences" },
    text: {
      am: "ረጅም ዝምታ፣ ተደጋጋሚ ሙከራዎችና «እ…» ድምፆች በአንድ ጠቅታ ይወጣሉ — በሴኩዌንስዎ ቅጂ ላይ።",
      en: "Long pauses, repeated takes and “እ…” sounds go in one click — on a copy of your sequence.",
    },
  },
  {
    icon: "▶",
    title: { am: "ለTikTok ዝግጁ ቪዲዮ", en: "Ready for TikTok" },
    text: {
      am: "Amharic Captions Studio፦ ቆርጠው፣ ሙዚቃ ጨምረው፣ ለTikTok፣ Reels ወይም YouTube MP4 ያውጡ — ካፕሽኑ ተጽፎበት፣ በግራፊክስ ካርድ በፍጥነት።",
      en: "Amharic Captions Studio: cut, add music, and export an MP4 for TikTok, Reels or YouTube — captions burned in, fast on your graphics card.",
    },
  },
  {
    icon: "አ",
    title: { am: "በላቲን ፊደል አማርኛ ይጻፉ", en: "Type Amharic with Latin letters" },
    text: {
      am: "selam ብለው ይጻፉ → ሰላም። ካፕሽን ሲያርሙ የአማርኛ ኪቦርድ አያስፈልግም።",
      en: "Type selam → ሰላም. No Amharic keyboard needed to fix a caption.",
    },
  },
  {
    icon: "🔒",
    title: { am: "ሁሉም በኮምፒውተርዎ", en: "Everything on your computer" },
    text: {
      am: "ቪዲዮዎ ወደ የትም አይላክም። ያለ ኢንተርኔት ይሰራል፤ የዳታ ወጪ የለም።",
      en: "Your video is never uploaded. It works offline — no data costs.",
    },
  },
];

const buySteps = [
  {
    t: { am: "ይጫኑና 30 ደቂቃ በነጻ ይሞክሩ", en: "Install and try 30 minutes free" },
    c: {
      am: "ከመክፈልዎ በፊት በራስዎ ቪዲዮ እንደሚሰራ ያረጋግጡ።",
      en: "Make sure it works on your own footage before you pay anything.",
    },
  },
  {
    t: { am: "በፓነሉ ወይም በStudio «ፈቃድ ይግዙ» ይጫኑ", en: "Press “Buy a license” in the panel or the Studio" },
    c: {
      am: "የሚታየውን QR በስልክዎ ይቃኙ — የቴሌግራም ቦቱ ከኮምፒውተርዎ ጋር ተገናኝቶ ይከፈታል። ምንም መቅዳት አያስፈልግም።",
      en: "Scan the QR with your phone — the Telegram bot opens already linked to your computer. Nothing to copy.",
    },
  },
  {
    t: { am: "ፕላን ይምረጡና በባንክ ያስተላልፉ", en: "Choose a plan and transfer by bank" },
    c: {
      am: `ለ ${ACCT_NAME} (CBE፣ አቢሲኒያ ወይም ዘመን ባንክ) ያስተላልፉ፣ የደረሰኙን ስክሪንሾት ለቦቱ ይላኩ።`,
      en: `Pay ${ACCT_NAME} (CBE, Abyssinia or Zemen) and send the receipt screenshot to the bot.`,
    },
  },
  {
    t: { am: "በራሱ ይነቃል", en: "It activates itself" },
    c: {
      am: "ክፍያው ሲረጋገጥ ፓነሉ ወይም መተግበሪያው በራሱ ይነቃል — ምንም መለጠፍ አያስፈልግም። በስልክ ብቻ ከከፈሉ አጭር ኮድ ይደርስዎታል፤ «የፈቃድ ቁልፍ» ላይ ጽፈው «አግብር» ይጫኑ።",
      en: "Once the payment is confirmed the panel or app turns itself on — nothing to paste. Paid from your phone only? You get a short code; type it into “License key” and press Activate.",
    },
  },
];

const faqs = [
  {
    q: { am: "ኢንተርኔት ያስፈልገኛል?", en: "Do I need internet to use it?" },
    a: {
      am: "አይ። ወደ ጽሑፍ መቀየሩ ሙሉ በሙሉ በኮምፒውተርዎ ላይ ይሰራል። ኢንተርኔት የሚያስፈልገው ለመጫን (የአማርኛ ሞዴሉ አንድ ጊዜ ይወርዳል፤ ቢቋረጥ ካቆመበት ይቀጥላል) እና የፈቃድ ቁልፍዎን ለመቀበል ብቻ ነው — ከዚያ በኋላ ያለ ኢንተርኔት መስራት ይችላሉ።",
      en: "No. Transcription runs entirely on your computer. You need internet once to install (the Amharic model downloads once, and continues if your connection drops) and once to receive your license key — after that you can work completely offline.",
    },
  },
  {
    q: { am: "ቪዲዮዬ የሆነ ቦታ ይላካል?", en: "Is my footage uploaded anywhere?" },
    a: {
      am: "በፍጹም። ቪዲዮዎና ድምፅዎ ከኮምፒውተርዎ አይወጡም። የሚላኩበት ሰርቨር የለም — ለዚህም ነው ያለ ኢንተርኔት የሚሰራው።",
      en: "Never. Your video and audio never leave your computer. There is no server to send it to, which is why it works with no connection at all.",
    },
  },
  {
    q: { am: "የትኞቹ የAdobe ስሪቶች ይሰራሉ?", en: "Which Adobe versions work?" },
    a: {
      am: "Premiere Pro 2022 (v22) እና ከዚያ በኋላ ያሉት፣ በWindows 10/11 እና macOS (Intel ወይም Apple Silicon)። After Effects 2022 እና ከዚያ በኋላ ያሉትም ይሰራሉ — ካፕሽኖቹ በኮምፖዚሽንዎ ውስጥ እንደ አንድ ቴክስት ሌየር ይገባሉ። ፓነሉ በ2021–2023 ስሪቶች ላይ አይከፈትም፤ እዚያ የ.srt መስሪያውን ይጠቀሙ።",
      en: "Premiere Pro 2022 (v22) and newer, on Windows 10/11 and macOS (Intel or Apple Silicon). After Effects 2022 and newer is supported too — captions arrive as one text layer in your composition. The panel does not load on 2021–2023 versions; use the drag-and-drop .srt tool there instead.",
    },
  },
  {
    q: { am: "በCapCut ወይም DaVinci Resolve ይሰራል?", en: "Does it work with CapCut or DaVinci Resolve?" },
    a: {
      am: "አዎ — በስታይሉ፣ እንደሚታረሙ ካፕሽኖች። ዴስክቶፕ ላይ «Make Amharic Captions» ይክፈቱ (Amharic Captions Studio)፣ ቪዲዮዎን ይጎትቱ። CapCut፦ «ወደ CapCut ላክ» — ቪዲዮውና ካፕሽኖቹ ከአኒሜሽናቸው ጋር በአዲስ የCapCut ፕሮጀክት ውስጥ ይገባሉ፤ እያንዳንዱ ካፕሽን የሚታረም ጽሑፍ ነው። DaVinci፦ «ወደ DaVinci ላክ»፣ ከዚያ በDaVinci Workspace → Scripts → Amharic Captions — ካፕሽኖቹ እንደ Text+ ይገባሉ፤ ነፃው DaVinciም ይሰራል። .srt ፋይልም ማስቀመጥ ይቻላል። የCapCut የስልክ መተግበሪያ አይደገፍም — CapCut ኮምፒውተር ላይ ይጠቀሙ።",
      en: "Yes — styled, as editable captions. Open “Make Amharic Captions” on your desktop (Amharic Captions Studio) and drag your video in. CapCut: “Send to CapCut” — the video and the captions, with their animation, arrive in a new CapCut project; every caption is an editable text. DaVinci: “Send to DaVinci”, then in DaVinci Workspace → Scripts → Amharic Captions — the captions arrive as Text+; the free DaVinci works too. You can still save an .srt as well. The CapCut phone app isn't supported — use CapCut on a computer.",
    },
  },
  {
    q: { am: "ምን ያህል ትክክል ነው?", en: "How accurate is it?" },
    a: {
      am: "ግልጽ ንግግርና ጥሩ ማይክራፎን ሲኖር አብዛኞቹ ቃላት በትክክል ይወጣሉ፤ የሚያስተካክሉት በአብዛኛው ስሞችንና ቁጥሮችን ነው። ውጤቱን እንደ ረቂቅ ይቁጠሩት፣ ከማተምዎ በፊት በፓነሉ ውስጥ ይገምግሙት።",
      en: "On clear speech with a good microphone most words come out right; you mainly fix names and numbers. Treat the result as a draft and review it in the panel before you publish.",
    },
  },
  {
    q: { am: "ፈቃዱ እንዴት ይሰራል?", en: "How does the license work?" },
    a: {
      am: "አንድ ቁልፍ ለአንድ ኮምፒውተር። ኮምፒውተር ከቀየሩ ወይም Windows እንደገና ከጫኑ ድጋፍን ያግኙ፤ ፈቃድዎን እናዛውርልዎታለን። ሁለተኛ አይግዙ።",
      en: "One key per computer. Changed computer or reinstalled Windows? Message support and we'll move your license. Don't buy a second one.",
    },
  },
  {
    q: { am: "በኮምፒውተሬ ላይ ካልሰራስ?", en: "What if it doesn't work on my computer?" },
    a: {
      am: "በመጀመሪያ እናስተካክለዋለን። ፕሮግራሙ በኮምፒውተርዎ ላይ ካልሰራና በተገቢው ጊዜ ልናስተካክለው ካልቻልን፣ በገዙ በ14 ቀን ውስጥ ከጠየቁ ሙሉ ገንዘብዎ ይመለሳል። ዝርዝሩ በህጋዊ ውሎች ገጽ ላይ ነው።",
      en: "We fix it first. If the software does not work on your computer and we cannot resolve it within a reasonable time, you get a full refund when you ask within 14 days of purchase. Details are on the legal page.",
    },
  },
];

export const metadata = {
  alternates: { canonical: "/" },
};

export default function HomePage() {
  const priceLbl = Number(PRICE_NUM).toLocaleString("en-US");
  const oldLbl = Number(PRICE_OLD_NUM).toLocaleString("en-US");
  const num = (n) => Number(n).toLocaleString("en-US");
  // The three plans, each as big and clear as the others (owner, 2026-10-25:
  // "500 and 900 as clear and bold as 2,500").
  const plans = [
    { n: num(PRICE_M1_NUM), am: "1 ወር", en: "1 month", subAm: "30 ቀን", subEn: "30 days" },
    { n: num(PRICE_M2_NUM), am: "2 ወር", en: "2 months", subAm: "60 ቀን", subEn: "60 days" },
    { n: priceLbl, am: "ለዘለቄታው", en: "Forever", subAm: "አንድ ጊዜ ብቻ", subEn: "pay once", best: true },
  ];

  // Search engines get the English FAQ; the Amharic copy is on the page itself.
  const faqLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.q.en,
      acceptedAnswer: { "@type": "Answer", text: f.a.en },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }}
      />

      {/* ---------------------------------------------------------- hero */}
      <section className="hero" id="top">
        <div className="container">
          <div className="hero-grid">
            <div className="hero-copy">
              <p className="eyebrow">
                <Tx am="Premiere Pro · After Effects · CapCut · DaVinci Resolve" en="Premiere Pro · After Effects · CapCut · DaVinci Resolve" />
              </p>

              <h1>
                <Tx
                  am="የአማርኛ ካፕሽን በደቂቃዎች — በሰዓታት አይደለም።"
                  en={<>Amharic subtitles in minutes,<br className="hide-sm" /> not hours.</>}
                />
              </h1>

              <p className="hero-sub">
                <Tx
                  am="እያንዳንዱን መስመር በእጅ መጻፍ ይቅር፦ ፕሮግራሙ በስታይል ያሉ፣ የሚታረሙ የአማርኛ ካፕሽኖችን ይጽፍልዎታል — በPremiere እና After Effects ታይምላይን ላይ፣ በCapCut ፕሮጀክትዎ ውስጥ፣ ወይም በDaVinci (ነፃውም) እንደ Text+። ያለ ኢንተርኔት።"
                  en="Stop typing every line by hand: get styled, editable Amharic captions — on your Premiere and After Effects timeline, inside your CapCut project, or as Text+ in DaVinci Resolve (the free one too). Fully offline."
                />
              </p>

              <div className="hero-cta cta-row">
                <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                  <Tx am="ቁልፍ ያግኙ — ከ500 ብር ጀምሮ" en="Get your key — from ETB 500" />
                </a>
                <Link className="btn btn-ghost btn-lg" href="/install/">
                  <Tx am="የመጫኛ መመሪያ" en="Install guide" />
                </Link>
              </div>

              <p className="hero-note">
                <Tx am="መጀመሪያ 30 ደቂቃ በነጻ ይሞክሩ፤ ከዚያ፦" en="Try 30 minutes free first, then:" />
              </p>
              <ul className="hero-plans">
                {plans.map((pl) => (
                  <li key={pl.en} className={pl.best ? "is-best" : undefined}>
                    <span className="hp-term"><Tx am={pl.am} en={pl.en} /></span>
                    <span className="hp-price"><Tx am={`${pl.n} ብር`} en={`ETB ${pl.n}`} /></span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Deliberately NOT wrapped in Reveal: this is the hero visual and
                the largest paint on the page. Fading it in delays the one thing
                a visitor came to see, for an effect they never scrolled to. */}
            <div className="hero-visual">
              <PanelMock />
            </div>
          </div>
        </div>
      </section>

      {/* A thin band, not a section: the practical reasons this matters to an
          editor in Ethiopia, said plainly. */}
      <section className="strip">
        <div className="container">
          <ul className="strip-list">
            <li>
              <strong><Tx am="ኢንተርኔት አያስፈልግም" en="No internet needed" /></strong>
              <span><Tx am="ኔትወርክ ቢጠፋም ይሰራል" en="Works when the connection doesn't" /></span>
            </li>
            <li>
              <strong><Tx am="የዳታ ወጪ የለም" en="No data charges" /></strong>
              <span><Tx am="ቪዲዮዎ ወደ ኢንተርኔት አይላክም" en="Nothing is uploaded, ever" /></span>
            </li>
            <li>
              <strong><Tx am="ለዘለቄታው አንድ ጊዜ" en="Pay once, forever" /></strong>
              <span><Tx am={<><b>500</b> · <b>900</b> · <b>2,500</b> ብር</>} en={<>ETB <b>500</b> · <b>900</b> · <b>2,500</b></>} /></span>
            </li>
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="section" id="how" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="እንዴት ይሰራል" en="How it works" /></p>
              <h2><Tx am="በሶስት ደረጃ ኤዲት ማድረግ ይጀምራሉ።" en="Three steps, then you're editing." /></h2>
            </div>
          </Reveal>
          <div className="steps">
            {steps.map((s, i) => (
              <Reveal key={s.n} delay={i * 110}>
                <div className="step">
                  <span className="step-n">{s.n}</span>
                  <h3><Tx am={s.title.am} en={s.title.en} /></h3>
                  <p><Tx am={s.text.am} en={s.text.en} /></p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------- works with editors */}
      <section className="section" id="editors">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="ከኤዲተርዎ ጋር ይሰራል" en="Works with your editor" /></p>
              <h2><Tx am="Premiere፣ After Effects፣ CapCut ወይም DaVinci።" en="Premiere, After Effects, CapCut or DaVinci." /></h2>
              <p className="section-sub">
                <Tx
                  am="አንድ ፈቃድ — ሁሉም። በሁሉም ላይ ካፕሽኑን ቪዲዮውን እያዩ ያስተካክላሉ።"
                  en="One license covers all of them. Everywhere, you fix the captions while you watch the video."
                />
              </p>
            </div>
          </Reveal>
          <div className="editors">
            {editors.map((e, i) => (
              <Reveal key={e.name} delay={i * 90}>
                <div className="editor-card">
                  <span className="editor-icon" aria-hidden="true">{e.icon}</span>
                  <h3>{e.name}</h3>
                  <p><Tx am={e.text.am} en={e.text.en} /></p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- features */}
      <section className="section" id="features" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="ከካፕሽን በላይ" en="More than captions" /></p>
              <h2><Tx am="ኤዲተሮች የሚፈልጉት ሁሉ።" en="Everything an editor needs." /></h2>
              <p className="section-sub">
                <Tx
                  am="በፓነሉም በStudioም — አንድ ፈቃድ፣ ሁሉም ባህሪያት።"
                  en="In the panel and in the Studio — one license, every feature."
                />
              </p>
            </div>
          </Reveal>
          <div className="editors">
            {features.map((f, i) => (
              <Reveal key={f.title.en} delay={(i % 4) * 80}>
                <div className="editor-card">
                  <span className="editor-icon" aria-hidden="true">{f.icon}</span>
                  <h3><Tx am={f.title.am} en={f.title.en} /></h3>
                  <p><Tx am={f.text.am} en={f.text.en} /></p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- audio quality */}
      <section className="section" id="quality">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="እውነቱን እንንገርዎ" en="Be realistic" /></p>
              <h2><Tx am="የትኛው ድምፅ በደንብ ይሰራል።" en="What kind of audio works best." /></h2>
              <p className="section-sub">
                <Tx
                  am="ምንም የድምፅ-ወደ-ጽሑፍ ፕሮግራም ፍጹም አይደለም። ከገዙ በኋላ ቅር ከሚሰኙ፣ ከመግዛትዎ በፊት ቢያውቁ እንመርጣለን።"
                  en="No speech-to-text is perfect, and we'd rather you know where it shines before you buy than be disappointed after."
                />
              </p>
            </div>
          </Reveal>

          <div className="quality">
            <Reveal>
              <div className="q-card q-good">
                <h3><Tx am="✓ በጣም ጥሩ ይሰራል" en="✓ Works great" /></h3>
                <ul>
                  <li><Tx am={<><strong>ግልጽ ንግግር</strong> — ስቱዲዮ፣ የዜና አይነት አቀራረብ</>} en={<><strong>Clear speech</strong> — studio, news-style delivery</>} /></li>
                  <li><Tx am={<><strong>ቅርብ ማይክራፎን</strong> — የኮሌታ (lapel) ወይም የጠረጴዛ ማይክ</>} en={<><strong>Close microphone</strong> — lapel or desk mic</>} /></li>
                  <li><Tx am={<><strong>ጸጥ ያለ አካባቢ</strong> — ከድምፁ ጀርባ ትንሽ ጫጫታ</>} en={<><strong>Quiet background</strong> — little noise behind the voice</>} /></li>
                  <li><Tx am={<><strong>መደበኛ ክፍሎች</strong> — ቢሮዎች፣ ትናንሽ ስቱዲዮዎች</>} en={<><strong>Normal rooms</strong> — offices, small studios</>} /></li>
                </ul>
              </div>
            </Reveal>
            <Reveal delay={90}>
              <div className="q-card q-warn">
                <h3><Tx am="⚠ ተጨማሪ ማስተካከያ ይፈልጋል" en="⚠ Needs more editing" /></h3>
                <ul>
                  <li><Tx am={<><strong>የስልክ ቀረጻ</strong> — ጠባብና የተጨመቀ ድምፅ</>} en={<><strong>Phone recordings</strong> — narrow, compressed audio</>} /></li>
                  <li><Tx am={<><strong>የውጪ ቀረጻ</strong> — ንፋስ፣ የመኪና ጫጫታ፣ ብዙ ሰው</>} en={<><strong>Outdoor footage</strong> — wind, traffic, crowds</>} /></li>
                  <li><Tx am={<><strong>የሚደራረቡ ተናጋሪዎች</strong> — ሰዎች በአንድ ጊዜ ሲናገሩ</>} en={<><strong>Overlapping speakers</strong> — people talking across each other</>} /></li>
                </ul>
              </div>
            </Reveal>
            <Reveal delay={180}>
              <div className="q-card q-avoid">
                <h3><Tx am="✗ ይቸገራል" en="✗ Struggles" /></h3>
                <ul>
                  <li><Tx am={<><strong>ትላልቅ አዳራሾችና ቤተ ክርስቲያኖች</strong> — ከፍተኛ ማሚቶ (echo) በጣም ከባዱ ነው</>} en={<><strong>Big halls and churches</strong> — strong echo is the hardest case</>} /></li>
                  <li><Tx am={<><strong>ከንግግሩ ስር ከፍ ያለ ሙዚቃ</strong> — መጀመሪያ የሙዚቃውን ትራክ mute ያድርጉ</>} en={<><strong>Loud music under speech</strong> — mute the music track first</>} /></li>
                  <li><Tx am={<><strong>በጣም ደካማ ማይክራፎን</strong> — ያለዎትን ምርጥ ድምፅ ይጠቀሙ</>} en={<><strong>Very low-quality mics</strong> — use your best available audio</>} /></li>
                </ul>
              </div>
            </Reveal>
          </div>

        </div>
      </section>

      {/* ------------------------------------------------------------ pricing */}
      <section className="section" id="pricing">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="ዋጋ" en="Pricing" /></p>
              <h2><Tx am="አንድ ጊዜ ይክፈሉ — ወይም በወር ይጀምሩ።" en="Pay once — or start monthly." /></h2>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="price-card">
              <span className="price-badge"><Tx am="ለአንድ ኮምፒውተር · ሁሉም ባህሪያት በሶስቱም" en="1 computer · every feature in all three" /></span>
              <div className="plans">
                {plans.map((pl) => (
                  <div key={pl.en} className={pl.best ? "plan is-best" : "plan"}>
                    {pl.best && <span className="plan-flag"><Tx am="ምርጥ ዋጋ" en="Best value" /></span>}
                    <span className="plan-term"><Tx am={pl.am} en={pl.en} /></span>
                    <span className="plan-price">
                      <span className="price-now">{pl.n}</span>
                      <span className="price-cur"><Tx am="ብር" en="ETB" /></span>
                    </span>
                    <span className="plan-sub">
                      {pl.best && <span className="price-old"><Tx am={`${oldLbl} ብር`} en={`ETB ${oldLbl}`} /></span>}{" "}
                      <Tx am={pl.subAm} en={pl.subEn} />
                    </span>
                  </div>
                ))}
              </div>

              <ul className="price-features">
                <li><Tx am="ያልተገደበ ካፕሽን — የፈለጉትን ያህል" en="Unlimited captions — caption as much as you like" /></li>
                <li><Tx am="Premiere Pro እና After Effects 2022+ — በቀጥታ ታይምላይኑ ላይ" en="Premiere Pro & After Effects 2022+ — straight onto the timeline" /></li>
                <li><Tx am="CapCut እና DaVinci Resolve — Amharic Captions Studio፦ የሚታረሙ ካፕሽኖች በፕሮጀክትዎ ውስጥ፣ MP4 ለTikTok፣ .srt" en="CapCut & DaVinci Resolve — Amharic Captions Studio: editable captions inside your project, MP4 for TikTok, .srt" /></li>
                <li><Tx am="19 ስታይሎች፣ 12 የአማርኛ ፎንቶች፣ አኒሜሽን — ሁሉም ባህሪያት ተካትተዋል" en="19 styles, 12 Amharic fonts, animation — every feature included" /></li>
                <li><Tx am="Windows 10/11 እና macOS (Intel ወይም M1/M2/M3)" en="Windows 10/11 & macOS (Intel or Apple silicon)" /></li>
                <li><Tx am="በአማርኛ ወይም በእንግሊዝኛ" en="In Amharic or English" /></li>
                <li><Tx am="በቴሌግራም ድጋፍ — ከሰሩት ሰዎች በቀጥታ" en="Support on Telegram from the people who built it" /></li>
              </ul>

              <p className="price-plans" style={{ margin: "14px 0 16px", lineHeight: 1.6, fontSize: "0.95em" }}>
                <Tx
                  am="በወር ይጀምሩ፣ በኋላ ለዘለቄታው ሲገዙ የከፈሉት ይቀነሳል።"
                  en="Start monthly, go Forever later and what you paid is deducted."
                />
              </p>

              <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
                <Tx am="ቁልፍዎን በቴሌግራም ያግኙ" en="Get your key on Telegram" />
              </a>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <div className="buy-steps" id="buy">
              <h3><Tx am="እንዴት እንደሚገዙ — 4 ደረጃዎች" en="How to buy — 4 steps" /></h3>
              <ol className="istep-list">
                {buySteps.map((s, i) => (
                  <li className="istep" key={s.t.en}>
                    <span className="istep-n">{i + 1}</span>
                    <div className="istep-body">
                      <h3><Tx am={s.t.am} en={s.t.en} /></h3>
                      <p><Tx am={s.c.am} en={s.c.en} /></p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </Reveal>
        </div>
      </section>

      <BuySafely />

      {/* ---------------------------------------------------------------- faq */}
      <section className="section" id="faq" style={{ background: "var(--bg-soft)" }}>
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="ጥያቄዎች" en="Questions" /></p>
              <h2><Tx am="ከመግዛትዎ በፊት።" en="Before you buy." /></h2>
            </div>
          </Reveal>

          <div className="faq-list">
            {faqs.map((f, i) => (
              <Reveal key={f.q.en} delay={i * 50}>
                <details>
                  <summary><Tx am={f.q.am} en={f.q.en} /></summary>
                  <p><Tx am={f.a.am} en={f.a.en} /></p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- final push */}
      <section className="section">
        <div className="container">
          <Reveal>
            <div className="final-cta">
              <h2><Tx am="የአማርኛ ካፕሽንን በእጅ መጻፍ ያቁሙ።" en="Stop typing Amharic captions by hand." /></h2>
              <p className="section-sub" style={{ marginInline: "auto" }}>
                <Tx
                  am="በራስዎ ቪዲዮ በነጻ ይሞክሩ — 30 ደቂቃ፣ ያለ ክፍያ፣ በቴሌግራም አንድ ጊዜ በመጫን።"
                  en="Try it free on your own footage — 30 minutes, no payment, one tap in Telegram."
                />
              </p>
              <div className="cta-row">
                <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                  <Tx am="የፈቃድ ቁልፍ ያግኙ" en="Get your license key" />
                </a>
                <Link className="btn btn-ghost btn-lg" href="/install/">
                  <Tx am="የመጫኛ መመሪያውን ያንብቡ" en="Read the install guide" />
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
