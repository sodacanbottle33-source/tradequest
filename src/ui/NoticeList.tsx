import type { Notice } from '../engine';

/** Latest notices first (fills, rejections, replacements, cancellations). */
export function NoticeList({
  notices,
  emptyText = 'Read the history candles, then place an order or press Next.',
}: {
  notices: readonly Notice[];
  emptyText?: string;
}) {
  const latest = [...notices].reverse().slice(0, 4);
  return (
    <section className="notices" aria-live="polite" aria-label="Notices">
      {latest.length === 0 ? (
        <p className="notice info">{emptyText}</p>
      ) : (
        latest.map((n, i) => (
          <p key={n.id} className={`notice ${n.kind} ${i === 0 ? 'newest' : ''}`}>
            {n.message}
          </p>
        ))
      )}
    </section>
  );
}
