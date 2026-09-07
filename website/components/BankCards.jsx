import { ACCOUNTS, ACCT_NAME } from "@/lib/site";

export default function BankCards({ className = "" }) {
  return (
    <div className={`bank-list ${className}`}>
      <p className="bank-name">Account holder: <strong>{ACCT_NAME}</strong></p>
      <div className="bank-grid">
        {ACCOUNTS.map((a) => (
          <div className="bank-card" key={a.short}>
            <span className="bank-bank">{a.bank}</span>
            <code className="bank-num">{a.number}</code>
          </div>
        ))}
      </div>
    </div>
  );
}