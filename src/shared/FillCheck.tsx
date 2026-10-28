// A small check mark that draws itself (a circle, then the tick) next to the answer to an order that went through. Looks only; the words next to it
// are what the server answered. Drawn with CSS (src/styles.css, ".fill-check"); a person who asked for reduced motion sees the finished mark at once.
export function FillCheck() {
  return (
    <svg className="fill-check" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="10" fill="none" strokeWidth="2" />
      <path d="M7 12.5l3.2 3.2L17 9" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
