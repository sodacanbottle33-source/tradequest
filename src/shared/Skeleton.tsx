// Grey bars that shimmer while a screen waits for its data, under the "Loading…" line (the line stays: it is what a screen reader reads). Looks only.
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true" data-testid="skeleton">
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="skeleton-bar" />
      ))}
    </div>
  );
}
