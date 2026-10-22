// Logging with a memory of recent problems, so the health endpoint can show what went wrong instead of an empty screen.

export type Level = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  readonly ms: number;
  readonly level: Level;
  readonly area: string;
  readonly message: string;
}

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  private readonly recent: LogEntry[] = [];
  private readonly minLevel: number;
  private readonly sink: ((line: string) => void) | null;
  private readonly now: () => number;

  constructor(options: { level?: Level; sink?: ((line: string) => void) | null; now?: () => number } = {}) {
    this.minLevel = ORDER[options.level ?? 'info'];
    this.sink = options.sink === undefined ? (line) => console.log(line) : options.sink;
    this.now = options.now ?? (() => Date.now());
  }

  private write(level: Level, area: string, message: string): void {
    const entry: LogEntry = { ms: this.now(), level, area, message };
    if (level === 'warn' || level === 'error') {
      this.recent.push(entry);
      if (this.recent.length > 50) this.recent.shift();
    }
    if (ORDER[level] >= this.minLevel && this.sink) {
      this.sink(`${new Date(entry.ms).toISOString()} ${level.toUpperCase().padEnd(5)} [${area}] ${message}`);
    }
  }

  debug(area: string, message: string): void {
    this.write('debug', area, message);
  }
  info(area: string, message: string): void {
    this.write('info', area, message);
  }
  warn(area: string, message: string): void {
    this.write('warn', area, message);
  }
  error(area: string, message: string): void {
    this.write('error', area, message);
  }

  /** The most recent warnings and errors, newest last. */
  problems(): readonly LogEntry[] {
    return this.recent;
  }
}
