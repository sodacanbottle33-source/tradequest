import type { ReactNode } from 'react';

/**
 * The three places of the game: your Career, the 1v1 battles, and the news. The owner's admin panel is a fourth screen that
 * is reached only from the profile menu, so it has no button here.
 */
export type Mode = 'career' | 'battle' | 'news' | 'admin';

const MODES: readonly { id: Exclude<Mode, 'admin'>; label: string }[] = [
  { id: 'career', label: 'Career' },
  { id: 'battle', label: '1v1' },
  { id: 'news', label: 'News' },
];

interface Props {
  mode: Mode;
  onMode: (mode: Mode) => void;
  /** Buttons that belong to the current mode. */
  children?: ReactNode;
  /** The line next to the brand. */
  subtitle?: ReactNode;
}

export function Header({ mode, onMode, children, subtitle }: Props) {
  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden="true">▲</span>
        <span className="brand-name">TradeQuest</span>
        <span className="badge-simulated" title="Fictional companies, generated prices, virtual money">
          SIMULATED
        </span>
      </div>
      <div className="segmented mode-switch" role="group" aria-label="Game mode">
        {MODES.map((m) => (
          <button key={m.id} type="button" className={mode === m.id ? 'seg active' : 'seg'} aria-pressed={mode === m.id} onClick={() => onMode(m.id)} data-testid={`mode-${m.id}`}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="instrument">{subtitle}</div>
      <div className="header-actions">{children}</div>
    </header>
  );
}
