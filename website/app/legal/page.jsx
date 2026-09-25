import Link from "next/link";
import { BOT_URL, CONTACT_URL, ACCT_NAME, ACCOUNTS_LABEL, PRICE } from "@/lib/site";

export const metadata = {
  title: "License, Privacy & Refund — Amharic Captions for Premiere Pro",
  description:
    "End User License Agreement, privacy policy and refund policy for Amharic Captions Pro. One-time ETB 2,500 license, local transcription, file-bound license terms.",
};

export default function LegalPage() {
  return (
    <>
      <section className="page-hero">
        <div className="container">
          <p className="eyebrow">Legal</p>
          <h1>License, privacy & refunds.</h1>
          <p className="hero-sub">
            The short version: local transcription, one license per licensed
            installation, and a clear money-back path if it does not work on
            your setup. The full terms are below.
          </p>
        </div>
      </section>

      <section className="section">
        <div className="container legal">
          <div className="legal-toc">
            <a href="#eula">End User License Agreement</a>
            <a href="#privacy">Privacy policy</a>
            <a href="#refund">Refund policy</a>
          </div>

          <h2 id="eula">End User License Agreement (EULA)</h2>
          <p><em>Effective: {new Date().toISOString().slice(0, 10)} · Version 1.0</em></p>
          <p>
            By installing, running, or otherwise using Amharic Captions Pro
            ("the Software"), you agree to this End User License Agreement with
            {ACCT_NAME} ("the Licensor").
          </p>

          <h3>1. Grant of license</h3>
          <p>
            The Licensor grants you a non-exclusive, non-transferable, personal
            right to install and use the Software on a single licensed installation, subject
            to the terms below. The license is perpetual by default — you pay once
            ({PRICE} one-time payment). If the seller explicitly issues a dated key before approval, that disclosed expiry applies.
          </p>

          <h3>2. License boundary</h3>
          <p>
            Each license key is bound to a random installation identifier stored
            in your user profile. This is a file-bound license, not a hardware
            attestation or TPM-backed lock. Do not copy the identity/license
            files or share them with another person. A second licensed
            installation requires a second key.
          </p>

          <h3>3. Free trial</h3>
          <p>
            Every new machine may run up to 2 free transcriptions (2 captions)
            before a license key is required, so you can test the Software on
            your own Premiere Pro before paying. The trial requires no card and
            no account.
          </p>

          <h3>4. Restrictions</h3>
          <p>You may not, and may not allow others to:</p>
          <ul>
            <li>redistribute, resell, sub-license, rent or lend the Software, its installer, or a recycled license key;</li>
            <li>copy, modify, reverse engineer, decompile or disassemble the Software (except as allowed by law);</li>
            <li>use unauthorized, forged, or shared spread of a single key across machines (see §5).</li>
          </ul>

          <h3>5. Deactivation</h3>
          <p>
            The Licensor may refuse or revoke a license key if it was obtained
            or used improperly — for example fraud, a chargeback, a refund
            abuse, or a key repeatedly used across installations. Revocation is
            communicated to the key holder by Telegram. Online checks can
            enforce revocation; an already-issued offline lease may remain
            usable until the client next contacts the license server.
            Legitimate keys are not revoked.
          </p>

          <h3>6. Transcription accuracy</h3>
          <p>
            Transcription is produced on your machine by speech-recognition
            models. Accuracy depends on audio quality, speaker, accent,
            background noise, music and reverberation. Captions may require substantial
            correction; the current model has not yet met the project's ≤15%
            real-audio WER target. You are responsible for reviewing and
            correcting every caption before publishing.
          </p>

          <h3>7. No warranty</h3>
          <p>
            The Software is provided "as is" and "as available" without
            warranty of any kind, express or implied, including merchantability
            or fitness for a particular purpose. The Licensor does not warrant
            that the Software will be uninterrupted, error-free, or produce
            captions without defects.
          </p>

          <h3>8. Limitation of liability</h3>
          <p>
            To the maximum extent permitted by law, the Licensor shall not be
            liable for any indirect, incidental, special or consequential
            damages, including lost profits or lost data, arising from the use
            of the Software. This applies even if the Licensor was advised of
            the possibility of such damages.
          </p>

          <h3>9. Taxes and payment</h3>
          <p>
            Payment is made by bank transfer to {ACCT_NAME} ({ACCOUNTS_LABEL}).
            Only keys delivered through the official channel (
            <a href={BOT_URL} target="_blank" rel="noopener">@AmharicCaptionsBot</a>) are
            recognized by the Software. Never pay anyone presenting other
            accounts; the official accounts above never change without a public
            notice on this website.
          </p>

          <h3>10. Governing law</h3>
          <p>
            This agreement is governed by the laws of the Federal Democratic
            Republic of Ethiopia. Contact for any question: Telegram{" "}
            <a href={CONTACT_URL} target="_blank" rel="noopener">@sumpak6</a>.
          </p>

          <h2 id="privacy">Privacy policy</h2>
          <p><em>Effective: {new Date().toISOString().slice(0, 10)} · Version 1.0</em></p>

          <h3>What transcription never does</h3>
          <p>
            All speech recognition, language correction, speaker labeling and
            caption placement happen entirely on your own computer. Your audio,
            video, footage, transcripts, project files and captions{" "}
            <strong>never leave your machine</strong> and are never uploaded to
            any server. You do not need internet to transcribe.
          </p>

          <h3>What the Software does send</h3>
          <ul>
            <li>
              <strong>License activation.</strong> When you activate a key, the
              Software sends your Machine ID and the key to the license server
              to confirm the key belongs to this installation. The server also
              re-derives the key&rsquo;s cryptographic signature — this is how
              forged or stolen keys are rejected. The license is file-bound,
              not a hardware attestation; do not share the identity/license files.
            </li>
            <li>
              <strong>Usage beacon.</strong> When the panel opens, it may send
              your application version, a pseudonymous Machine ID, origin, and
              network source information to the license server. It is used to
              count installs, detect abuse, and support version diagnostics. It
              does not contain audio, text, or transcripts. Telemetry retention
              is bounded separately from license records.
            </li>
            <li>
              <strong>Free-trial usage.</strong> The number of free
              transcriptions used on your installation is synced with the
              license server so the trial limit is enforced. Trial counters may
              be retained as pseudonymous abuse-prevention records.
            </li>
          </ul>

          <h3>What is stored and where</h3>
          <p>
            License data lives on Cloudflare&rsquo;s platform (Workers + D1
            database): Machine ID, license key, order record (name/nickname,
            account used, amount), Telegram account identifiers, and source
            IPs for fraud detection. Order history, webhook idempotency records,
            and short-lived telemetry are pruned separately; license and
            trial-abuse records may be retained while needed to support or
            protect an active license. We do not sell your data. Service
            providers include Cloudflare, Vercel (website hosting), and Telegram
            (ordering and support).
          </p>

          <h3>Local identity storage</h3>
          <p>
            Your Machine ID is stored in a small file in your user profile and
            in the panel&rsquo;s local storage; it is a random installation
            identifier. A hashed fingerprint of your username, home-directory
            path, and platform is stored locally to help detect a copied
            profile. That fingerprint is not sent to any server and never
            leaves your machine.
          </p>

          <h3>Deletion &amp; your rights</h3>
          <p>
            You may request deletion or correction of your license/order record
            at any time by messaging{" "}
            <a href={CONTACT_URL} target="_blank" rel="noopener">@sumpak6</a> on
            Telegram. Removing your data deactivates the associated license key.
          </p>

          <h2 id="refund">Refund policy</h2>
          <p><em>Effective: {new Date().toISOString().slice(0, 10)} · Version 1.0</em></p>
          <h3>Digital goods — replacement first</h3>
          <p>
            The product is a digital license key delivered by bot after
            payment, so it is generally a final sale. That said, we stand behind
            it:
          </p>
          <ul>
            <li>
              <strong>14-day money-back.</strong> If the Software does not work
              on your machine (key fails activation, panel will not load, or a
              supported Premiere version is not recognized) and we cannot
              resolve it within a reasonable time, you get a full refund. Ask
              within 14 days of purchase on{" "}
              <a href={CONTACT_URL} target="_blank" rel="noopener">@sumpak6</a>,
              quoting your order.
            </li>
            <li>
              <strong>Refunds are paid by the same payment method and to the
              same account the payment came from.</strong> A refunded key is
              permanently deactivated.
            </li>
            <li>
              <strong>Not covered:</strong> captions rejected for accuracy on
              extreme audio quality (see EULA §6), lost or reused keys, keys
              bought from resellers or unofficial channels, or remorse after
              successful installation.
            </li>
          </ul>
          <p>
            Questions? Message{" "}
            <a href={CONTACT_URL} target="_blank" rel="noopener">@sumpak6</a>,
            or read the{" "}
            <Link href="/#faq">FAQ</Link>.
          </p>
        </div>
      </section>
    </>
  );
}