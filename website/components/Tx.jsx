// Bilingual text. Both languages are in the HTML; CSS shows one of them based
// on <html data-lang>, which an inline script in app/layout.jsx sets before the
// first paint from the visitor's saved choice. So:
//   - no flash of the wrong language and no hydration mismatch,
//   - works in server components (no hooks, no client JS),
//   - search engines and "view source" see both languages.
// Amharic is the default; English only shows when data-lang="en".
export default function Tx({ am, en }) {
  return (
    <>
      <span className="l-am" lang="am">{am}</span>
      <span className="l-en" lang="en">{en}</span>
    </>
  );
}
