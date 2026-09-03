export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <h1>የአማርኛ ትርጉም አድራጊ ለAdobe Premiere Pro</h1>
          <p className="hero-sub">
            የአማርኛ ንግግርን በራስ-ሰር ወደ ትርጉም (captions) ይለውጡ። ሙሉ በሙሉ
            በመሣሪያዎ ላይ ይሠራል — በይነመረብ አያስፈልግም፣ ቪዲዮዎ አይላክም።
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary btn-lg" href="https://t.me/sumpak6" target="_blank" rel="noopener">
              ግዛ — ETB 1,500
            </a>
            <span className="hero-note">የአንድ ጊዜ ክፍያ · ነጻ ሙከራ · 2 ትርጉሞች</span>
          </div>
        </div>
      </section>

      <section className="features section" id="features">
        <div className="container">
          <h2>ለምን Amharic Captions ይመርጣሉ?</h2>
          <div className="grid">
            <article className="card">
              <h3>በመሣሪያዎ ላይ ብቻ</h3>
              <p>
                ንግግርዎ ወደ ውጭ ተላላኪ አይደለም። ሁሉም ሂደት በኮምፒውተርዎ
                ላይ ይከናወናል። ታማኝነት እና ግላዊነትዎ የተጠበቀ ነው።
              </p>
            </article>
            <article className="card">
              <h3>በራስ-ሰር ወደ Premiere</h3>
              <p>
                የአማርኛ ትርጉሞችዎ በቀጥታ ወደ ታይምላይኑ ይከለላሉ (land on the
                timeline) እና ወዲያውኑ ማርትዕ ይችላሉ። GMT ወይም የጊዜ መከፋፈል አይቸገሩም።
              </p>
            </article>
            <article className="card">
              <h3>ነጻ ሙከራ</h3>
              <p>
                እያንዳንዱ አዲስ መሣሪያ <strong>2 ትርጉሞችን ነጻ</strong> ይፈጥራል፣
                ስለዚህ ከመግዛትዎ በፊት በራስዎ Premiere ላይ መሞከር ይችላሉ።
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="works section" id="works">
        <div className="container">
          <h2>እንዴት ይሠራል?</h2>
          <ol className="steps">
            <li><span>1</span> ማንኛውንም የአማርኛ ቪዲዮ በPremiere ውስጥ ይምረጡ</li>
            <li><span>2</span> "Generate Captions" የሚለውን ይጫኑ</li>
            <li><span>3</span> ወዲያውኑ የአማርኛ ትርጉሞቹ ታይምላይኑ ላይ ይደርሳሉ</li>
          </ol>
        </div>
      </section>

      <section className="pricing section" id="pricing">
        <div className="container">
          <h2>ዋጋ</h2>
          <div className="pricing-card">
            <p className="price-label">የአንድ ጊዜ ፈቃድ (Lifetime license)</p>
            <p className="price">ETB 1,500</p>
            <ul>
              <li>የአንድ ጊዜ ክፍያ — ከዚህ በኋላ ወርሃዊ ወይም ዓመታዊ አለ።</li>
              <li>በመሣሪያ የተጠበቀ ቁልፍ (በኮምፒውተር የሚወሰን)</li>
              <li>Windows 10/11 እና macOS (Intel / Apple Silicon)</li>
              <li>ከመግዛትዎ በፊት 2 ነጻ ትርጉሞች</li>
            </ul>
            <a className="btn btn-primary btn-lg" href="https://t.me/sumpak6" target="_blank" rel="noopener">
              ግዛ — ETB 1,500
            </a>
            <p className="tiny">
              በTelebirr ወደ <strong>0907 628 809</strong> ይክፈሉ
            </p>
          </div>
        </div>
      </section>

      <section className="install section" id="install">
        <div className="container">
          <h2>እንዴት እንደሚጫን</h2>
          <div className="grid">
            <div>
              <h3>Windows</h3>
              <ol>
                <li><code>amharic-captions-win-x64.zip</code> ያውርዱ እና ይቅመቱ</li>
                <li>የ<code>com.amharic.captions</code> አቃፊውን ወደ <code>C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\</code> ይቅዱ</li>
                <li>Premiereን ያቆሙ እና እንደገና ይክፈቱ</li>
              </ol>
            </div>
            <div>
              <h3>macOS</h3>
              <ol>
                <li><code>amharic-captions-mac-x64.zip</code> (Intel) ወይም <code>mac-arm64</code> (Apple Silicon) ያውርዱ</li>
                <li>የ<code>com.amharic.captions</code> አቃፊውን ወደ <code>~/Library/Application Support/Adobe/CEP/extensions/</code> ያስገቡ</li>
                <li>Premiereን ያቆሙ እና እንደገና ይክፈቱ</li>
              </ol>
            </div>
          </div>
          <p className="note">
            ዝርዝር መመሪያ ለማግኘት ወደ <a href="https://t.me/sumpak6" target="_blank" rel="noopener">ድጋፋችን</a> ይጻፉ።
          </p>
        </div>
      </section>

      <section className="cta section">
        <div className="container">
          <h2>ዛሬውኑ ይጀምሩ</h2>
          <p>ነጻ ሙከራ ይጀምሩ — ከመግዛትዎ በፊት 2 ትርጉሞችን ይፈጥሩ።</p>
          <a className="btn btn-primary btn-lg" href="https://t.me/sumpak6" target="_blank" rel="noopener">
            በTelegram ይጻፉ
          </a>
        </div>
      </section>
    </>
  );
}
