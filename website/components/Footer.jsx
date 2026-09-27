import Link from "next/link";
import Tx from "@/components/Tx";
import { BOT_URL, BOT_USERNAME, SUPPORT_URL, GROUP_URL, PRICE, PRICE_AM } from "@/lib/site";

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
            <Tx
              am={`ለAdobe Premiere Pro እና After Effects የአማርኛ ካፕሽን። ሙሉ በሙሉ በኮምፒውተርዎ ላይ ይሰራል — upload የለም፣ ክላውድ የለም። አንድ ጊዜ ብቻ ${PRICE_AM}።`}
              en={`Amharic speech-to-text captions for Adobe Premiere Pro and After Effects. Runs entirely on your computer — no uploads, no cloud. One-time ${PRICE}.`}
            />
          </p>
        </div>

        <div className="footer-col">
          <h4><Tx am="ምርት" en="Product" /></h4>
          <Link href="/#how"><Tx am="እንዴት ይሰራል" en="How it works" /></Link>
          <Link href="/#pricing"><Tx am="ዋጋ" en="Pricing" /></Link>
          <Link href="/install/"><Tx am="የመጫኛ መመሪያ" en="Install guide" /></Link>
          <Link href="/#faq"><Tx am="ጥያቄዎች" en="FAQ" /></Link>
        </div>

        <div className="footer-col">
          <h4><Tx am="ድጋፍ" en="Support" /></h4>
          <a href={BOT_URL} target="_blank" rel="noopener"><Tx am="ይግዙ" en="Buy" /> · @{BOT_USERNAME}</a>
          <a href={GROUP_URL} target="_blank" rel="noopener"><Tx am="የድጋፍ ግሩፕ" en="Support group" /></a>
          <a href={SUPPORT_URL} target="_blank" rel="noopener"><Tx am="ድጋፍ ያግኙ" en="Contact support" /></a>
          <Link href="/legal/"><Tx am="ህጋዊ ውሎች" en="Legal" /></Link>
        </div>
      </div>

      <div className="footer-bottom">
        <div className="container footer-bottom-inner">
          <p>© {new Date().getFullYear()} Amharic Captions Pro. <Tx am="መብቱ በህግ የተጠበቀ ነው።" en="All rights reserved." /></p>
          <Link href="/legal/"><Tx am="ፈቃድ · ግላዊነት · ተመላሽ" en="EULA · Privacy · Refund" /></Link>
        </div>
      </div>
    </footer>
  );
}
