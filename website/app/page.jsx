import Link from "next/link";
import Reveal from "@/components/Reveal";
import BuySafely from "@/components/BuySafely";
import PanelMock from "@/components/PanelMock";
import Tx from "@/components/Tx";
import {
  BOT_URL, ACCT_NAME, PRICE, PRICE_AM, PRICE_NUM, PRICE_OLD_NUM,
} from "@/lib/site";

const steps = [
  {
    n: "1",
    title: { am: "አንድ ጊዜ ይጫኑ", en: "Install once" },
    text: {
      am: "ጫኚውን ሁለቴ ይጫኑ። አንድ ደቂቃ ገደማ ይወስዳል፤ የቴክኒክ እውቀት አያስፈልግም። Premiere እና After Effects ውስጥ ፓነል፣ ዴስክቶፕ ላይ ደግሞ ለCapCut እና DaVinci መተግበሪያ ያገኛሉ።",
      en: "Double-click the installer — about a minute, no technical skills needed. You get a panel inside Premiere and After Effects, and an app on your desktop for CapCut and DaVinci.",
    },
  },
  {
    n: "2",
    title: { am: "ቪዲዮ ወይም ክሊፕ ይምረጡ", en: "Pick your video" },
    text: {
      am: "Premiere ላይ ክሊፕ፣ Work Area ወይም ሙሉ ኤዲቱን ይምረጡ፤ ለCapCut ወይም DaVinci ቪዲዮውን ወደ መተግበሪያው ይጎትቱ። በቡድን ወይም ካራኦኬ ካፕሽን ይምረጡ።",
      en: "In Premiere select a clip, the work area or the whole sequence; for CapCut or DaVinci drag the video into the app. Choose grouped or karaoke captions.",
    },
  },
  {
    n: "3",
    title: { am: "ፍጠር፣ ገምግም፣ አስቀምጥ", en: "Generate, review, place" },
    text: {
      am: "ቪዲዮውን እያዩ ካፕሽኖቹን ይገምግሙና ያስተካክሉ። ከዚያ በPremiere ታይምላይኑ ላይ ያስቀምጡ — ወይም .srt አስቀምጠው ወደ CapCut ወይም DaVinci ያስገቡ።",
      en: "Review and fix the captions while you watch. Then place them on your Premiere timeline — or save the .srt and import it into CapCut or DaVinci.",
    },
  },
];

// The four editors, each with what actually happens there.
const editors = [
  {
    icon: "Pr", name: "Premiere Pro",
    text: {
      am: "ፓነሉ ውስጥ ይስሩ፣ ካፕሽኑ በቀጥታ ታይምላይኑ ላይ እንደሚስተካከል የካፕሽን ትራክ ይገባል።",
      en: "Work in the panel; the captions land on your timeline as an editable caption track.",
    },
  },
  {
    icon: "Ae", name: "After Effects",
    text: {
      am: "ያው ፓነል — ካፕሽኑ በኮምፖዚሽንዎ ውስጥ እንደ አንድ ቴክስት ሌየር ይገባል፣ ለስታይል እና አኒሜሽን ዝግጁ።",
      en: "The same panel — captions arrive as one text layer in your comp, ready to style and animate.",
    },
  },
  {
    icon: "✂", name: "CapCut",
    text: {
      am: "«Make Amharic Captions» መተግበሪያ፦ ቪዲዮውን ይጎትቱ፣ እያዩት ያስተካክሉ፣ .srt አስቀምጠው በCapCut ውስጥ Import ያድርጉ።",
      en: "The Make Amharic Captions app: drag the video in, fix the captions while it plays, save the .srt and import it in CapCut.",
    },
  },
  {
    icon: "◐", name: "DaVinci Resolve",
    text: {
      am: "ያው መተግበሪያ — .srt ፋይሉን File → Import → Subtitle ብለው ወደ ታይምላይኑ ያስገቡ።",
      en: "The same app — bring the .srt onto your timeline with File → Import → Subtitle.",
    },
  },
];

const buySteps = [
  {
    t: { am: "ይጫኑና 2 ካፕሽን በነጻ ይሞክሩ", en: "Install and try 2 captions free" },
    c: {
      am: "ከመክፈልዎ በፊት በራስዎ ቪዲዮ እንደሚሰራ ያረጋግጡ።",
      en: "Make sure it works on your own footage before you pay anything.",
    },
  },
  {
    t: { am: "በፓነሉ ወይም በመተግበሪያው «ፈቃድ ይግዙ» ይጫኑ", en: "Press “Buy a license” in the panel or the app" },
    c: {
      am: "የቴሌግራም ቦቱ ከኮምፒውተርዎ ጋር ተገናኝቶ ይከፈታል — ምንም መቅዳት አያስፈልግም።",
      en: "The Telegram bot opens already linked to your computer — nothing to copy.",
    },
  },
  {
    t: { am: `${PRICE_AM} በባንክ ያስተላልፉ`, en: `Transfer ${PRICE} by bank` },
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
      am: "አዎ። ዴስክቶፕ ላይ ያለውን «Make Amharic Captions» መተግበሪያ ይክፈቱ፣ ቪዲዮዎን ወደ ውስጥ ይጎትቱ፣ ቪዲዮውን እያዩ ካፕሽኑን ያስተካክሉ፣ ከዚያ «SRT አስቀምጥ» ይጫኑ። የ.srt ፋይሉ ከቪዲዮው አጠገብ ይቀመጣል፦ CapCut (ኮምፒውተር) ውስጥ Text → Captions → Import፣ DaVinci ውስጥ File → Import → Subtitle። Windows እና Mac (Intel ወይም M1/M2/M3) ላይ ይሰራል። የCapCut የስልክ መተግበሪያ .srt አይቀበልም — CapCut ኮምፒውተር ላይ ይጠቀሙ።",
      en: "Yes. Open the Make Amharic Captions app on your desktop, drag your video in, fix the captions while the video plays, then press “Save SRT”. The .srt lands next to your video: in CapCut desktop use Text → Captions → Import, in DaVinci File → Import → Subtitle. Works on Windows and Mac (Intel or Apple silicon). The CapCut phone app cannot import .srt files — use CapCut on a computer.",
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
                  am="እያንዳንዱን መስመር በእጅ ከመጻፍ ይልቅ፣ ሊስተካከሉ የሚችሉ የአማርኛ ካፕሽኖችን ይፍጠሩ — በቀጥታ በPremiere ወይም After Effects ታይምላይንዎ ላይ፣ ወይም ለCapCut እና DaVinci ዝግጁ .srt።"
                  en="Generate editable Amharic captions instead of typing every line by hand — straight onto your Premiere or After Effects timeline, or as a ready .srt for CapCut and DaVinci."
                />
              </p>

              <div className="hero-cta cta-row">
                <a className="btn btn-primary btn-lg" href={BOT_URL} target="_blank" rel="noopener">
                  <Tx am={`ቁልፍ ያግኙ — ${PRICE_AM}`} en={`Get your key — ${PRICE}`} />
                </a>
                <Link className="btn btn-ghost btn-lg" href="/install/">
                  <Tx am="የመጫኛ መመሪያ" en="Install guide" />
                </Link>
              </div>

              <p className="hero-note">
                <Tx
                  am="መጀመሪያ 2 ካፕሽን በነጻ ይሞክሩ · አንድ ጊዜ ብቻ ይከፍላሉ · ወርሃዊ ክፍያ የለም"
                  en="Try 2 captions free first · One-time payment · No subscription"
                />
              </p>
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
              <strong><Tx am="ወርሃዊ ክፍያ የለም" en="No monthly fee" /></strong>
              <span><Tx am="አንድ ክፍያ ብቻ" en="One payment, that’s it" /></span>
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
              <h2><Tx am="አንድ ጊዜ ይክፈሉ፣ የእርስዎ ነው።" en="Pay once. Yours to keep." /></h2>
            </div>
          </Reveal>

          <Reveal delay={80}>
            <div className="price-card">
              <span className="price-badge"><Tx am="ዘላቂ ፈቃድ · ለአንድ ኮምፒውተር" en="Lifetime license · 1 computer" /></span>
              <div className="price">
                <span className="price-old"><Tx am={`${oldLbl} ብር`} en={`ETB ${oldLbl}`} /></span>
                <span className="price-cur"><Tx am="ብር" en="ETB" /></span>
                <span className="price-now">{priceLbl}</span>
              </div>

              <ul className="price-features">
                <li><Tx am="ያልተገደበ ካፕሽን — የፈለጉትን ያህል" en="Unlimited captions — caption as much as you like" /></li>
                <li><Tx am="Premiere Pro እና After Effects 2022+ — በቀጥታ ታይምላይኑ ላይ" en="Premiere Pro & After Effects 2022+ — straight onto the timeline" /></li>
                <li><Tx am="CapCut እና DaVinci Resolve — መተግበሪያ፣ ቪዲዮውን እያዩ ማስተካከያ፣ .srt" en="CapCut & DaVinci Resolve — an app with video preview, saves the .srt" /></li>
                <li><Tx am="Windows 10/11 እና macOS (Intel ወይም M1/M2/M3)" en="Windows 10/11 & macOS (Intel or Apple silicon)" /></li>
                <li><Tx am="በአማርኛ ወይም በእንግሊዝኛ" en="In Amharic or English" /></li>
                <li><Tx am="በቴሌግራም ድጋፍ — ከሰሩት ሰዎች በቀጥታ" en="Support on Telegram from the people who built it" /></li>
              </ul>

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
                  am="በራስዎ ቪዲዮ በነጻ ይሞክሩ — 20 ደቂቃ፣ ያለ ክፍያ፣ በቴሌግራም አንድ ጊዜ በመጫን።"
                  en="Try it free on your own footage — 20 minutes, no payment, one tap in Telegram."
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
