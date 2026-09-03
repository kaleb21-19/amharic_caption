export const metadata = {
  title: "Amharic Captions — Amharic Speech-to-Text for Premiere Pro",
  description:
    "Turn Amharic speech into captions right inside Adobe Premiere Pro. Fully on-device — no internet, no uploads. One-time fee ETB 1,500.",
};

export default function EnglishPage() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <h1>Amharic Captions for Adobe Premiere Pro</h1>
          <p className="hero-sub">
            Automatically turn Amharic speech into editable captions. Runs entirely
            on your machine — no internet, no uploads, no cloud.
          </p>
          <div className="hero-cta">
            <a className="btn btn-primary btn-lg" href="https://t.me/sumpak6" target="_blank" rel="noopener">
              Buy — ETB 1,500
            </a>
            <span className="hero-note">One-time payment · Free trial · 2 captions</span>
          </div>
        </div>
      </section>

      <section className="features section" id="features">
        <div className="container">
          <h2>Why Amharic Captions?</h2>
          <div className="grid">
            <article className="card">
              <h3>100% On-device</h3>
              <p>
                Your speech never leaves your computer. Everything runs locally for
                privacy and speed.
              </p>
            </article>
            <article className="card">
              <h3>Straight into Premiere</h3>
              <p>
                Captions land directly on your timeline, ready to edit. Works for the
                whole edit or a selected clip.
              </p>
            </article>
            <article className="card">
              <h3>Free trial</h3>
              <p>
                Every machine gets <strong>2 free captions</strong> before you need a
                license, so you can try it in your own Premiere first.
              </p>
            </article>
          </div>
        </div>
      </section>

      <section className="pricing section" id="pricing">
        <div className="container">
          <h2>Pricing</h2>
          <div className="pricing-card">
            <p className="price-label">Lifetime license</p>
            <p className="price">ETB 1,500</p>
            <ul>
              <li>One-time fee — no subscriptions.</li>
              <li>Per-machine, hardware-locked license key.</li>
              <li>Windows 10/11 and macOS (Intel / Apple Silicon).</li>
              <li>2 free captions before you buy.</li>
            </ul>
            <a className="btn btn-primary btn-lg" href="https://t.me/sumpak6" target="_blank" rel="noopener">
              Buy — ETB 1,500
            </a>
            <p className="tiny">Pay by Telebirr to <strong>0907 628 809</strong></p>
          </div>
        </div>
      </section>

      <section className="cta section">
        <div className="container">
          <h2>Get started today</h2>
          <p>Start your free trial — create 2 captions before you buy.</p>
          <a className="btn btn-primary btn-lg" href="https://t.me/sumpak6" target="_blank" rel="noopener">
            Message us on Telegram
          </a>
        </div>
      </section>
    </>
  );
}
