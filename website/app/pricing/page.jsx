import Link from "next/link";
import { BOT_URL, BOT_USERNAME, PAYMENT } from "@/lib/site";

export const metadata = {
  title: "Pricing — Amharic Captions for Premiere Pro",
  description:
    "One-time ETB 1,500 lifetime license for Amharic speech-to-text captions in Premiere Pro. No subscription. Order through our Telegram bot and receive your key instantly.",
};

export default function PricingPage() {
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
          <div className="pricing-card">
            <p className="price-label">Lifetime license</p>
            <p className="price"><span className="cur">ETB</span> 1,500</p>
            <p className="price-sub">≈ $30 USD · One-time payment</p>
            <ul className="price-features">
              <li>Unlimited captions — no per-minute fees</li>
              <li>Premiere Pro 2024+ · Windows &amp; macOS</li>
              <li>2 free captions before you pay</li>
              <li>Editable, native caption tracks</li>
              <li>Support from the team on Telegram</li>
            </ul>
            <a className="btn btn-primary btn-lg btn-block" href={BOT_URL} target="_blank" rel="noopener">
              Buy now via Telegram
            </a>
            <p className="tiny">
              Ordering opens our Telegram bot — pay by {PAYMENT} and receive your
              license key right there.
            </p>
          </div>
        </div>
      </section>

      <section className="how-pay section">
        <div className="container">
          <h2>How buying works</h2>
          <div className="grid">
            <div className="card">
              <h3>1 · Open the bot</h3>
              <p>
                Tap Buy, which opens <strong>@{BOT_USERNAME}</strong> on Telegram.
              </p>
            </div>
            <div className="card">
              <h3>2 · Pay</h3>
              <p>Pay ETB 1,500 via Telebirr, right from the conversation.</p>
            </div>
            <div className="card">
              <h3>3 · Get your key</h3>
              <p>Your license key is delivered instantly, locked to your machine.</p>
            </div>
          </div>
          <div className="center">
            <Link className="btn btn-ghost btn-lg" href="/install/">
              Need to install first? See the guide
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
