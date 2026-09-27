import Reveal from "@/components/Reveal";
import Tx from "@/components/Tx";
import { BOT_URL, BOT_USERNAME, ACCT_NAME, ACCOUNTS, SUPPORT_URL } from "@/lib/site";

// Buy-safely block: shows the ONLY official (bot, accounts, seller name) so
// buyers can never be tricked into paying a fake account or fake seller.
export default function BuySafely() {
  const bot = (
    <strong>
      <a href={BOT_URL} target="_blank" rel="noopener">@{BOT_USERNAME}</a>
    </strong>
  );
  return (
    <section className="safe section" id="safety">
      <div className="container">
        <Reveal className="section-head center">
          <h2><Tx am="በጥንቃቄ ይግዙ — ከማጭበርበር ይጠበቁ።" en="How to buy safely — no scams, ever." /></h2>
          <p className="section-sub">
            <Tx
              am="በቴሌግራም ብዙ ሀሰተኛ ሻጮች አሉ። ከእውነተኛው ሻጭ ውጪ ለማንም እንዳይከፍሉ፣ እያንዳንዱን ክፍያ ከዚህ ገጽ ጋር ያመሳክሩ።"
              en="Telegram is full of fake sellers. We make it impossible to pay anyone but the real team. Please verify every payment against this page."
            />
          </p>
        </Reveal>

        <div className="safe-grid">
          <Reveal>
            <div className="safe-card">
              <span className="safe-icon" aria-hidden="true">🤖</span>
              <h3><Tx am="የሚሸጥ ብቸኛው ቦት" en="Only bot that sells" /></h3>
              <p>
                <Tx
                  am={<>የምንሸጠው በይፋዊው ቦት {bot} ብቻ ነው። የቡድናችን አባልም ሆነ ሌላ አካውንት በቀጥታ እንዲከፍሉት <strong>በፍጹም</strong> አይጠይቅዎትም።</>}
                  en={<>We sell only through the official bot {bot}. A real team member or another account will <strong>never</strong> ask you to pay them directly.</>}
                />
              </p>
            </div>
          </Reveal>

          <Reveal delay={90}>
            <div className="safe-card">
              <span className="safe-icon" aria-hidden="true">🏦</span>
              <h3><Tx am="እነዚህ አካውንቶች ብቻ" en="Only these accounts" /></h3>
              <p>
                <Tx
                  am={<>ክፍያ ለ <strong>{ACCT_NAME}</strong> ብቻ በባንክ ያስተላልፉ። የምንጠቀመው እነዚህን ሶስት አካውንቶች ብቻ ነው፦</>}
                  en={<>Pay only to <strong>{ACCT_NAME}</strong> via bank transfer. We use exactly these three accounts and no others:</>}
                />
              </p>
              <ul className="safe-accounts">
                {ACCOUNTS.map((a) => (
                  <li key={a.bank}>
                    <span className="safe-bank">{a.bank}</span>
                    <code>{a.number}</code>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>

          <Reveal delay={180}>
            <div className="safe-card">
              <span className="safe-icon" aria-hidden="true">🔐</span>
              <h3><Tx am="ቁልፉ በቦቱ ይላካል" en="Key is sent in the bot" /></h3>
              <p>
                <Tx
                  am={<>ክፍያዎ ከተረጋገጠ በኋላ ቁልፍዎ <strong>በቦቱ ቻት ውስጥ</strong> ይደርሳል — በኢሜይል፣ ከማያውቁት ሰው መልዕክት ወይም በተጨማሪ ክፍያ በፍጹም አይደለም።</>}
                  en={<>After your payment is confirmed, your license key arrives <strong>inside the bot chat</strong> — never by email, never by a stranger&apos;s DM, never for an extra fee.</>}
                />
              </p>
              <a className="btn btn-ghost btn-sm" href={SUPPORT_URL} target="_blank" rel="noopener">
                <Tx am="አጠራጣሪ መልዕክት ሪፖርት ያድርጉ" en="Report a suspicious message" />
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={120}>
          <p className="safe-note">
            <Tx
              am={<>⚠️ ማንም ሰው ለሌላ ስም፣ ስልክ ወይም አካውንት እንዲከፍሉ ቢጠይቅዎ፣ ወይም መጀመሪያ ገንዘብ እንዲልኩ ቢያጣድፍዎ — <strong>ያቁሙ</strong>፣ ከመክፈልዎ በፊት በቴሌግራም ያግኙን።</>}
              en={<>⚠️ If someone asks you to pay to a different name, phone, or account, or pressures you to send money first — <strong>stop</strong> and message us on Telegram before paying.</>}
            />
          </p>
        </Reveal>
      </div>
    </section>
  );
}
