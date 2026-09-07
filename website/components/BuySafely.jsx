import Reveal from "@/components/Reveal";
import { BOT_URL, BOT_USERNAME, ACCT_NAME, ACCOUNTS, SUPPORT_URL } from "@/lib/site";

// Buy-safely block: shows the ONLY official (bot, accounts, seller name) so
// buyers can never be tricked into paying a fake account or fake seller.
export default function BuySafely() {
  return (
    <section className="safe section" id="safety">
      <div className="container">
        <Reveal>
          <h2>How to buy safely — no scams, ever.</h2>
          <p className="section-sub">
            Telegram is full of fake sellers. We make it impossible to pay anyone
            but the real team. Please verify every payment against this page.
          </p>
        </Reveal>

        <div className="safe-grid">
          <Reveal>
            <div className="safe-card">
              <span className="safe-icon" aria-hidden="true">🤖</span>
              <h3>Only bot that sells</h3>
              <p>
                We sell only through the official bot{" "}
                <strong>
                  <a href={BOT_URL} target="_blank" rel="noopener">@{BOT_USERNAME}</a>
                </strong>
                . A real team member or another account will{" "}
                <strong>never</strong> ask you to pay them directly.
              </p>
            </div>
          </Reveal>

          <Reveal delay={90}>
            <div className="safe-card">
              <span className="safe-icon" aria-hidden="true">🏦</span>
              <h3>Only these accounts</h3>
              <p>
                Pay only to <strong>{ACCT_NAME}</strong> via bank transfer. We use{" "}
                exactly these three accounts and no others:
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
              <h3>Key is sent in the bot</h3>
              <p>
                After your payment is confirmed, your license key arrives{" "}
                <strong>inside the bot chat</strong> — never by email, never by a
                stranger&apos;s DM, never for an extra fee.
              </p>
              <a className="btn btn-ghost btn-sm" href={SUPPORT_URL} target="_blank" rel="noopener">
                Report a suspicious message
              </a>
            </div>
          </Reveal>
        </div>

        <Reveal delay={120}>
          <p className="safe-note">
            ⚠️ If someone asks you to pay to a different name, phone, or account,
            or pressures you to send money first — <strong>stop</strong> and
            message us on Telegram before paying.
          </p>
        </Reveal>
      </div>
    </section>
  );
}