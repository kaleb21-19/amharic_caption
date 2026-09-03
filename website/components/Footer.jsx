import Link from "next/link";
import { BOT_URL, SUPPORT_URL, PAYMENT } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand-col">
          <p className="footer-brand"><span className="brand-mark sm">አ</span> Amharic Captions</p>
          <p className="footer-tag">
            Amharic speech-to-text captions for Adobe Premiere Pro. Runs fully
            on your machine.
          </p>
        </div>
        <div className="footer-col">
          <h4>Product</h4>
          <Link href="#features">Features</Link>
          <Link href="#how">How it works</Link>
          <Link href="#pricing">Pricing</Link>
          <Link href="#faq">FAQ</Link>
        </div>
        <div className="footer-col">
          <h4>Support</h4>
          <a href={SUPPORT_URL} target="_blank" rel="noopener">Contact support</a>
          <a href={BOT_URL} target="_blank" rel="noopener">Start a purchase</a>
        </div>
        <div className="footer-col">
          <h4>Contact</h4>
          <p>Telegram: <a href={BOT_URL} target="_blank" rel="noopener">@AmharicCaptionsBot</a></p>
          <p>Payment: {PAYMENT}</p>
        </div>
      </div>
      <div className="footer-bottom">
        <div className="container">
          <p>© {new Date().getFullYear()} Amharic Captions. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}
