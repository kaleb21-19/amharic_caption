import Link from "next/link";
import { BOT_URL, BOT_USERNAME, SUPPORT_URL, GROUP_URL, PRICE } from "@/lib/site";

export default function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <p className="footer-brand">
            <span className="brand-mark brand-mark-sm" aria-hidden="true">AC</span>
            Amharic Captions Pro
          </p>
          <p className="footer-tag">
            Amharic speech-to-text captions for Adobe Premiere Pro. Runs entirely on your
            machine — no uploads, no cloud, one-time {PRICE} lifetime license.
          </p>
        </div>

        <div className="footer-col">
          <h4>Product</h4>
          <Link href="/#how">How it works</Link>
          <Link href="/#compare">Why offline</Link>
          <Link href="/#pricing">Pricing</Link>
          <Link href="/install/">Install guide</Link>
          <Link href="/#faq">FAQ</Link>
        </div>

        <div className="footer-col">
          <h4>Support</h4>
          <a href={BOT_URL} target="_blank" rel="noopener">Buy · @{BOT_USERNAME}</a>
          <a href={GROUP_URL} target="_blank" rel="noopener">Support group</a>
          <a href={SUPPORT_URL} target="_blank" rel="noopener">Contact support</a>
          <Link href="/legal/">Legal</Link>
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
