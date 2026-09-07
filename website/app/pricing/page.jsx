import Link from "next/link";
import Reveal from "@/components/Reveal";
import { BOT_URL, BOT_USERNAME, PRICE, PRICE_NUM, PRICE_OLD, PRICE_OLD_NUM } from "@/lib/site";

export const metadata = {
  title: "Pricing — Amharic Captions for Premiere Pro",
  description:
    `One-time ${PRICE} lifetime license for Amharic speech-to-text captions in Premiere Pro. No subscription. Order through our Telegram bot and receive your key instantly.`,
};

export default function PricingPage() {
  const priceLbl = Number(PRICE_NUM).toLocaleString("en-US");
  const oldPriceLbl = Number(PRICE_OLD_NUM).toLocaleString("en-US");
  const usd = Math.round(Number(PRICE_NUM) / 50);
  return (
    <>
      <section className="page-hero">
        <div className="container">
          <p className="eyebrow">Pricing</p>
          <h1>Simple, honest pricing.</h1>
          <p className="hero-sub">Pay once. Own it forever. No subscriptions, no per-minute fees.</p>
        </div>
      </section>

      <section className="pricing-page section">
        <div className="container">
          <Reveal>
            <div className="pricing-card">
            <p className="price-badge">Introductory price</p>
            <p className="price-label">Lifetime license</p>
            <p className="price">
              <span className="price-old">ETB {oldPriceLbl}</span>{" "}
              <span className="cur">ETB</span> {priceLbl}
            </p>
            <p className="price-sub">≈ ${usd} USD · One-time payment</p>
            <ul className="price-features">
              <li>Unlimited captions — no per-minute fees</li>
              <li>Premiere Pro 2024+ · Windows &amp; macOS</li>
              <li>2 free captions before you pay</li>
              <li>Editable, native caption tracks</li>
              <li>Lifetime updates for the current version</li>
              <li>Support from the team on Telegram</li>
            </ul>
            <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
              Buy now via Telegram
            </a>
            <p className="tiny">
              Ordering opens our Telegram bot — you pay and your license key is
              delivered right there.
            </p>
          </div></Reveal>
        </div>
      </section>

      <section className="how-pay section">
        <div className="container">
          <h2>How buying works</h2>
          <div className="grid">
            <Reveal><div className="card">
              <h3>1 · Open the bot</h3>
              <p>
                Tap Buy, which opens <strong>@{BOT_USERNAME}</strong> on Telegram.
              </p>
            </div></Reveal>
            <Reveal delay={90}><div className="card">
              <h3>2 · Pay</h3>
              <p>Send {PRICE} to one of the bank accounts (CBE, Abyssinia, or Zemen).</p>
            </div></Reveal>
            <Reveal delay={180}><div className="card">
              <h3>3 · Get your key</h3>
              <p>Your license key is delivered instantly, locked to your machine.</p>
            </div></Reveal>
          </div>
          <Reveal delay={120}><div className="center">
            <Link className="btn btn-ghost btn-lg" href="/install/">
              Need to install first? See the guide
            </Link>
          </div></Reveal>
        </div>
      </section>
    </>
  );
}
