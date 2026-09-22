import Link from "next/link";
import { BOT_URL, CONTACT_URL, ACCT_NAME, ACCOUNTS_LABEL, PRICE } from "@/lib/site";

export const metadata = {
  title: "License, Privacy & Refund — Amharic Captions for Premiere Pro",
  description:
    "End User License Agreement, privacy policy and refund policy for Amharic Captions Pro. One-time ETB 2,500 lifetime license, fully offline transcription, machine-locked keys.",
};

export default function LegalPage() {
  return (
    <>
      <section className="page-hero">
        <div className="container">
          <p className="eyebrow">Legal</p>
          <h1>License, privacy & refunds.</h1>
          <p className="hero-sub">
            The short version: 100% offline transcription, one license per
            machine, and a clear money-back path if it does not work on your
            setup. The full terms are below.
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
            right to install and use the Software on a single machine, subject
            to the terms below. The license is perpetual — you pay once
            ({PRICE} one-time payment) and the key never expires.
          </p>

          <h3>2. Machine locking</h3>
          <p>
            Each license key is hardware-locked to the "Machine ID"
            generated on your computer. The key activates only on the exact
            machine whose ID was used to purchase it. One key = one machine. To
            run the Software on another computer you must obtain a second key.
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
            abuse, or a key repeatedly used/activated across many machines.
            Revocation is communicated to the key holder by Telegram. Legitimate
            keys are never revoked.
          </p>

          <h3>6. Transcription accuracy</h3>
          <p>
            Transcription is produced on your machine by speech-recognition
            models. Accuracy depends on the audio quality of your footage —
            clean studio sound, phone microphones, background noise, music and
            reverberation all affect results, and captions may need minor edits.
            You remain responsible for reviewing captions before publishing.
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
              to confirm the key belongs to your machine. The server also
              re-derives the key&rsquo;s cryptographic signature — this is how
              forged or stolen keys are rejected.
            </li>
            <li>
              <strong>Anonymous usage beacon.</strong> Each time you open the
              panel, a single request is sent containing your application
              version and your Machine ID. It is used to count installs, detect
              abuse, and (for support) confirm which version you run. It
              contains no audio, text, transcript, or personal data.
            </li>
            <li>
              <strong>Free-trial usage.</strong> The number of free
              transcriptions used on your machine is synced with the license
              server so the trial limit is enforced.
            </li>
          </ul>

          <h3>What is stored and where</h3>
          <p>
            License data lives on Cloudflare&rsquo;s platform (Workers + D1
            database): Machine ID, license key, order record (name/nickname,
            account used, amount), and the source IP of activations for fraud
            detection. Old order/history records are automatically pruned after
            30 days. We do not sell or share your data with any third party
            other than the hosting provider (Cloudflare) and the messaging
            service you use to order (Telegram).
          </p>

          <h3>Local identity storage</h3>
          <p>
            Your Machine ID is stored in a small file in your user profile and
            in the panel&rsquo;s local storage; it is a random identifier with
            no personal information. A hashed (one-way) fingerprint of your
            hostname and username is stored locally so support can recognize
            records copied onto another computer. That fingerprint is not sent
            to any server and never leaves your machine.
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