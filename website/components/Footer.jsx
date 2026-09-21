import Link from "next/link";
import { BOT_URL, SUPPORT_URL, GROUP_URL, PRICE } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-brand-col">
          <p className="footer-brand"><span className="brand-mark brand-mark-sm">AC</span> Amharic Captions Pro</p>
          <p className="footer-tag">
            Amharic speech-to-text captions for Adobe Premiere Pro. Runs 100% on
            your machine — no uploads, no cloud, one-time {PRICE} lifetime license.
          </p>
        </div>
        <div className="footer-col">
          <h4>Product</h4>
          <Link href="/#offline">Why offline</Link>
          <Link href="/#how">How it works</Link>
          <Link href="/pricing/">Pricing</Link>
          <Link href="/install/">Install</Link>
          <Link href="/faq/">FAQ</Link>
          <Link href="/legal/">Legal</Link>
        </div>
        <div className="footer-col">
          <h4>Support</h4>
          <a href={GROUP_URL} target="_blank" rel="noopener">Support group</a>
          <a href={SUPPORT_URL} target="_blank" rel="noopener">Contact support</a>
          <a href={BOT_URL} target="_blank" rel="noopener">Start a purchase</a>
        </div>
        <div className="footer-col">
          <h4>Contact</h4>
          <p>Telegram: <a href={BOT_URL} target="_blank" rel="noopener">@AmharicCaptionsBot</a></p>
          <p>Hours: daily</p>
        </div>
      </div>
      <div className="footer-bottom">
        <div className="container footer-bottom-inner">
          <p>© {new Date().getFullYear()} Amharic Captions Pro. All rights reserved.</p>
          <Link href="/legal/">EULA · Privacy · Refund</Link>
        </div>
      </div>
    </footer>
  );
}