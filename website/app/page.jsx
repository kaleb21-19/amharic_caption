import { Fragment } from "react";
import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import StudioMock from "@/components/StudioMock";
import StyleShowcase from "@/components/StyleShowcase";
import WhatsNew from "@/components/WhatsNew";
import DemoVideo from "@/components/DemoVideo";
import Bento from "@/components/Bento";
import CountUp from "@/components/CountUp";
import Spotlight from "@/components/Spotlight";
import Tx from "@/components/Tx";
import {
  BOT_URL, ACCT_NAME, PRICE_NUM, PRICE_M1_NUM, PRICE_M2_NUM,
} from "@/lib/site";

// W2 (2026-11): the page redesigned to be read in seconds - short lines, one
// idea per block, the product shown moving. The long explanations live in
// the FAQ and the install guide.

const steps = [
  { title: { am: "አንድ ጊዜ ይጫኑ", en: "Install once" },
    text: { am: "ጫኚውን ሁለቴ ይጫኑ — አንድ ደቂቃ ገደማ። የቴክኒክ እውቀት አያስፈልግም።", en: "Double-click the installer — about a minute. No technical skills needed." } },
  { title: { am: "ቪዲዮ ይምረጡ", en: "Pick your video" },
    text: { am: "ክሊፕ ይምረጡ ወይም ቪዲዮውን ወደ Studio ይጎትቱ። ካፕሽኖቹ ያለ ኢንተርኔት በደቂቃዎች ይጻፋሉ።", en: "Select a clip or drag the video into the Studio. Captions are written in minutes, offline." } },
  { title: { am: "ያርሙ፣ ስታይል ይምረጡ፣ ይላኩ", en: "Fix, style, send" },
    text: { am: "ከ60 በላይ ስታይሎች አንዱን ይምረጡ፣ ወደ ኤዲተርዎ ይላኩ — ወይም MP4 ያውጡ።", en: "Pick one of 60+ styles and send it to your editor — or export an MP4." } },
];

// The four editors, each with what actually happens there.
const editors = [
  { icon: "Pr", cls: "pr", name: "Premiere Pro",
    text: { am: "ካፕሽኖቹ በስታይሉ በታይምላይኑ ላይ ይገባሉ — እያንዳንዱ የራሱ፣ የሚታረም ክሊፕ።", en: "Captions land on your timeline in your style — each its own editable clip." } },
  { icon: "Ae", cls: "ae", name: "After Effects",
    text: { am: "በስታይሉ በኮምፖዚሽንዎ ውስጥ ይገባሉ — ለተጨማሪ አኒሜሽን ዝግጁ።", en: "Styled captions arrive in your composition, ready for more animation." } },
  { icon: "✂", cls: "cc", name: "CapCut",
    text: { am: "በአንድ ጠቅታ አዲስ የCapCut ፕሮጀክት — ቪዲዮውና አኒሜሽን ያላቸው፣ የሚታረሙ ካፕሽኖች።", en: "One click makes a CapCut project — the video plus animated, editable captions." } },
  { icon: "◐", cls: "dv", name: "DaVinci Resolve",
    text: { am: "እንደሚታረም Text+ በTimelineዎ ላይ። ነፃው DaVinci Resolveም ይሰራል።", en: "Editable Text+ on your timeline. The free DaVinci Resolve works too." } },
];

const buySteps = [
  {
    t: { am: "ይጫኑና 30 ደቂቃ በነጻ ይሞክሩ", en: "Install and try 30 minutes free" },
    c: { am: "ከመክፈልዎ በፊት በራስዎ ቪዲዮ እንደሚሰራ ያረጋግጡ።", en: "Make sure it works on your own footage before you pay anything." },
  },
  {
    t: { am: "«ፈቃድ ይግዙ» ይጫኑ", en: "Press “Buy a license”" },
    c: { am: "በፓነሉ ወይም በStudio። QRውን በስልክዎ ይቃኙ — ቦቱ ከኮምፒውተርዎ ጋር ተገናኝቶ ይከፈታል።", en: "In the panel or the Studio. Scan the QR — the Telegram bot opens already linked to your computer." },
  },
  {
    t: { am: "በባንክ ያስተላልፉ", en: "Transfer by bank" },
    c: { am: `ለ ${ACCT_NAME} (CBE፣ አቢሲኒያ ወይም ዘመን) ይክፈሉ፣ የደረሰኙን ስክሪንሾት ለቦቱ ይላኩ።`, en: `Pay ${ACCT_NAME} (CBE, Abyssinia or Zemen) and send the receipt screenshot to the bot.` },
  },
  {
    t: { am: "በራሱ ይነቃል", en: "It activates itself" },
    c: { am: "ክፍያው ሲረጋገጥ ፓነሉ ወይም መተግበሪያው በራሱ ይነቃል — ምንም መለጠፍ አያስፈልግም።", en: "Once the payment is confirmed the panel or app turns itself on — nothing to paste." },
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
      am: "አንድ ቁልፍ ለአንድ ኮምፒውተር። ኮምፒውተር ከቀየሩ ወይም Windows እንደገና ከጫኑ ድጋፍን ያግኙ፤ ፈቃድዎን እናዛውርልዎታለን። ሁለተኛ አይግዙ። በስልክ ብቻ ከከፈሉ አጭር ኮድ ይደርስዎታል፤ «የፈቃድ ቁልፍ» ላይ ጽፈው «አግብር» ይጫኑ።",
      en: "One key per computer. Changed computer or reinstalled Windows? Message support and we'll move your license. Don't buy a second one. Paid from your phone only? You get a short code; type it into “License key” and press Activate.",
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

// the hero headline: each word its own span (a short rise, one after the other)
function Words({ text, from = 0 }) {
  // (the space stays OUTSIDE the inline-block word, or it collapses)
  return text.split(" ").map((w, i) => (
    <Fragment key={i}><span className="hw" style={{ "--i": from + i }}>{w}</span>{" "}</Fragment>
  ));
}

export default function HomePage() {
  const num = (n) => Number(n).toLocaleString("en-US");
  // The three plans, each as big and clear as the others (owner, 2026-10-25:
  // "500 and 900 as clear and bold as 2,500").
  const plans = [
    { n: num(PRICE_M1_NUM), am: "1 ወር", en: "1 month", subAm: "30 ቀን", subEn: "30 days" },
    { n: num(PRICE_M2_NUM), am: "2 ወር", en: "2 months", subAm: "60 ቀን", subEn: "60 days" },
    { n: num(PRICE_NUM), am: "1 ዓመት", en: "1 year", subAm: "365 ቀን — በወር ዝቅተኛው ዋጋ", subEn: "365 days — the lowest price per month", best: true },
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
      <Spotlight />

      {/* ---------------------------------------------------------- hero */}
      <section className="hero hero2" id="top">
        <div className="hero2-bg" aria-hidden="true"><i /><i /><i /></div>
        <div className="container hero2-in">
          <p className="hero-moat">
            <span className="hero-moat-dot" aria-hidden="true" />
            <Tx am="ለአማርኛ ብቻ የተሰራ — ያለ ኢንተርኔት፣ በኮምፒውተርዎ ላይ" en="Made only for Amharic — offline, on your own computer" />
          </p>

          <h1 className="hero-title">
            <Tx
              am={<Words text="የአማርኛ ካፕሽን በደቂቃዎች — በሰዓታት አይደለም።" />}
              en={<><Words text="Amharic subtitles in minutes," /><br className="hide-sm" /> <Words text="not hours." from={5} /></>}
            />
          </h1>

          <p className="hero-sub">
            <Tx
              am="በስታይል ያሉ፣ የሚታረሙ የአማርኛ ካፕሽኖች — ለPremiere፣ After Effects፣ CapCut እና DaVinci። ወይም ያለ Adobe፣ በራሱ በAmharic Captions Studio።"
              en="Styled, editable Amharic captions for Premiere, After Effects, CapCut and DaVinci — or with no Adobe at all, in the Amharic Captions Studio."
            />
          </p>

          <div className="hero-cta cta-row">
            <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
              <Tx am="ቁልፍ ያግኙ — ከ500 ብር ጀምሮ" en="Get your key — from ETB 500" />
            </a>
            <Link className="btn btn-ghost btn-lg" href="/install/">
              <Tx am="በነጻ ይሞክሩ" en="Try it free" /> <span aria-hidden="true">→</span>
            </Link>
          </div>

          <ul className="hero-meta">
            <li><Tx am="30 ደቂቃ በነጻ" en="30 minutes free" /></li>
            <li>Windows · macOS</li>
            <li><Tx am="ቪዲዮዎ አይላክም" en="Nothing uploaded" /></li>
          </ul>
        </div>

        {/* Deliberately NOT wrapped in Reveal: this is the hero visual and
            the largest paint on the page. */}
        <div className="container hero2-visual">
          <div className="hero2-stage">
            <StudioMock />
          </div>
        </div>

        {/* the four editors, as a logo row */}
        <div className="container">
          <p className="works-label"><Tx am="ከእነዚህ ጋር ይሰራል" en="Works with" /></p>
          <ul className="works-row">
            {editors.map((e) => (
              <li key={e.name}><span className={"wr-ico " + e.cls} aria-hidden="true">{e.icon}</span>{e.name}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------ numbers (product facts) */}
      <section className="stats" aria-label="In numbers">
        <div className="container">
          <ul className="stats-row">
            <li><strong><CountUp to={60} suffix="+" /></strong><span><Tx am="የካፕሽን ስታይሎች" en="caption styles" /></span></li>
            <li><strong><CountUp to={12} /></strong><span><Tx am="የአማርኛ ፎንቶች" en="Amharic fonts" /></span></li>
            <li><strong><CountUp to={69000} /></strong><span><Tx am="ቃላት ያሉት መዝገበ ቃላት" en="word dictionary" /></span></li>
            <li><strong>0</strong><span><Tx am="ወደ ኢንተርኔት የሚላክ ፋይል" en="files uploaded" /></span></li>
          </ul>
        </div>
      </section>

      <WhatsNew />

      <DemoVideo />

      <Bento />

      <StyleShowcase />

      {/* ------------------------------------------------------ how it works */}
      <section className="section" id="how">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="እንዴት ይሰራል" en="How it works" /></p>
              <h2><Tx am="በሶስት ደረጃ ኤዲት ማድረግ ይጀምራሉ።" en="Three steps, then you're editing." /></h2>
            </div>
          </Reveal>
          <Reveal className="steps-wrap">
            <span className="steps-line" aria-hidden="true"><i /></span>
            <ol className="steps2">
              {steps.map((s, i) => (
                <li key={s.title.en} className="step2 spot" style={{ "--d": `${i * 120}ms` }}>
                  <span className="step2-n" aria-hidden="true">{i + 1}</span>
                  <h3><Tx am={s.title.am} en={s.title.en} /></h3>
                  <p><Tx am={s.text.am} en={s.text.en} /></p>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------- works with editors */}
      <section className="section section-soft" id="editors">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="ከኤዲተርዎ ጋር ይሰራል" en="Works with your editor" /></p>
              <h2><Tx am="አንድ ፈቃድ — አራት ኤዲተሮች።" en="One license. Four editors." /></h2>
            </div>
          </Reveal>
          <div className="editors2">
            {editors.map((e, i) => (
              <Reveal key={e.name} delay={i * 80}>
                <div className="editor2 spot">
                  <span className={"editor2-ico " + e.cls} aria-hidden="true">{e.icon}</span>
                  <h3>{e.name}</h3>
                  <p><Tx am={e.text.am} en={e.text.en} /></p>
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
                <Tx am="ከመግዛትዎ በፊት ቢያውቁ እንመርጣለን።" en="We'd rather you know before you buy." />
              </p>
            </div>
          </Reveal>
          <div className="quality2">
            {[
              { cls: "good", h: { am: "በጣም ጥሩ", en: "Works great" }, mark: "✓",
                items: [{ am: "ግልጽ ንግግር", en: "Clear speech" }, { am: "ቅርብ ማይክራፎን", en: "A close microphone" }, { am: "ጸጥ ያለ ክፍል", en: "A quiet room" }] },
              { cls: "warn", h: { am: "ማስተካከያ ይፈልጋል", en: "Needs more fixing" }, mark: "!",
                items: [{ am: "የስልክ ቀረጻ", en: "Phone recordings" }, { am: "የውጪ ቀረጻ — ንፋስ፣ መኪና", en: "Outdoors — wind, traffic" }, { am: "የሚደራረቡ ተናጋሪዎች", en: "Overlapping speakers" }] },
              { cls: "bad", h: { am: "ይቸገራል", en: "Struggles" }, mark: "✗",
                items: [{ am: "ትላልቅ አዳራሾች — ማሚቶ", en: "Big halls — echo" }, { am: "ከንግግሩ ስር ከፍ ያለ ሙዚቃ", en: "Loud music under speech" }, { am: "በጣም ደካማ ማይክራፎን", en: "A very poor microphone" }] },
            ].map((q, i) => (
              <Reveal key={q.cls} delay={i * 80}>
                <div className={"q2 q2-" + q.cls}>
                  <h3><span className="q2-mark" aria-hidden="true">{q.mark}</span><Tx am={q.h.am} en={q.h.en} /></h3>
                  <ul>{q.items.map((it) => <li key={it.en}><Tx am={it.am} en={it.en} /></li>)}</ul>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ pricing */}
      <section className="section section-soft" id="pricing">
        <div className="container">
          <Reveal>
            <div className="section-head center">
              <p className="eyebrow"><Tx am="ዋጋ" en="Pricing" /></p>
              <h2><Tx am="በወር ይጀምሩ — ወይም ዓመቱን ይውሰዱ።" en="Start monthly — or take the year." /></h2>
              <p className="section-sub">
                <Tx am="ሁሉም ባህሪያት በሶስቱም። በወር ጀምረው በኋላ ዓመቱን ሲገዙ የከፈሉት ይቀነሳል። በራሳቸው አይታደሱም።"
                  en="Every feature in all three. Start monthly — take the year later and what you paid is deducted. Nothing renews by itself." />
              </p>
            </div>
          </Reveal>

          <div className="plans2">
            {plans.map((pl, i) => (
              <Reveal key={pl.en} delay={i * 90}>
                <div className={pl.best ? "plan2 is-best spot" : "plan2 spot"}>
                  {pl.best && <span className="plan2-flag"><Tx am="ምርጥ ዋጋ" en="Best value" /></span>}
                  <span className="plan2-term"><Tx am={pl.am} en={pl.en} /></span>
                  <span className="plan2-price">
                    <strong>{pl.n}</strong>
                    <span><Tx am="ብር" en="ETB" /></span>
                  </span>
                  <span className="plan2-sub"><Tx am={pl.subAm} en={pl.subEn} /></span>
                  <a className={pl.best ? "btn btn-primary btn-block" : "btn btn-ghost btn-block"} href={BOT_URL} target="_blank" rel="noopener">
                    <Tx am="ቁልፍ ያግኙ" en="Get your key" />
                  </a>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal delay={120}>
            <ul className="price-incl">
              <li><Tx am="ያልተገደበ ካፕሽን" en="Unlimited captions" /></li>
              <li><Tx am="Premiere እና After Effects 2022+" en="Premiere & After Effects 2022+" /></li>
              <li><Tx am="CapCut እና DaVinci — Studio" en="CapCut & DaVinci — the Studio" /></li>
              <li><Tx am="60+ ስታይሎች · 12 ፎንቶች" en="60+ styles · 12 fonts" /></li>
              <li>Windows 10/11 · macOS</li>
              <li><Tx am="በቴሌግራም ድጋፍ — ከሰሩት ሰዎች" en="Telegram support from the makers" /></li>
            </ul>
          </Reveal>

          <Reveal delay={160}>
            <div className="buy2" id="buy">
              <h3><Tx am="እንዴት እንደሚገዙ" en="How to buy" /></h3>
              <ol className="istep-list buy2-list">
                {buySteps.map((s) => (
                  <li className="istep" key={s.t.en}>
                    <span className="istep-n" aria-hidden="true" />
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
      <section className="section section-soft" id="faq">
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
            <div className="final2">
              <div className="final2-glow" aria-hidden="true" />
              <h2><Tx am="የአማርኛ ካፕሽንን በእጅ መጻፍ ያቁሙ።" en="Stop typing Amharic captions by hand." /></h2>
              <p className="section-sub">
                <Tx am="በራስዎ ቪዲዮ በነጻ ይሞክሩ — 30 ደቂቃ፣ ያለ ክፍያ።" en="Try it free on your own footage — 30 minutes, no payment." />
              </p>
              <div className="cta-row">
                <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                  <Tx am="የፈቃድ ቁልፍ ያግኙ" en="Get your license key" />
                </a>
                <Link className="btn btn-ghost btn-lg" href="/install/">
                  <Tx am="የመጫኛ መመሪያ" en="Install guide" />
                </Link>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
