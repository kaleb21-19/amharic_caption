import Tx from "./Tx";
import { UPDATES, UPDATED } from "../lib/updates";

// W1 (2026-11): proof the product is alive - the latest version, when, and
// what changed, in the customer's words (lib/updates.js).
export default function WhatsNew() {
  const latest = UPDATES[0];
  return (
    <section className="whatsnew" aria-labelledby="whatsnew-h">
      <div className="container whatsnew-in">
        <p className="whatsnew-head" id="whatsnew-h">
          <span className="whatsnew-dot" aria-hidden="true" />
          <Tx am={`አዲስ · v${latest.v} · ${UPDATED.am}`} en={`New · v${latest.v} · ${UPDATED.en}`} />
        </p>
        <ul className="whatsnew-list">
          {UPDATES.slice(0, 3).map((u) => (
            <li key={u.v}>
              <span className="whatsnew-v">v{u.v}</span>
              <span><Tx am={u.am} en={u.en} /></span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
