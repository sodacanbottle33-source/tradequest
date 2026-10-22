// Server-sent events: one open connection per browser tab. The server pushes every tick; the browser never has to ask.

import type { IncomingMessage, ServerResponse } from 'node:http';

interface Client {
  readonly id: number;
  readonly userId: number | null;
  readonly res: ServerResponse;
}

export class SseHub {
  private readonly clients = new Map<number, Client>();
  private nextId = 1;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  get size(): number {
    return this.clients.size;
  }

  start(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const c of this.clients.values()) this.write(c, ': keep-alive\n\n');
    }, 15_000);
    this.heartbeat.unref?.();
  }

  stop(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const c of this.clients.values()) c.res.end();
    this.clients.clear();
  }

  /** Opens the stream. `hello` is sent first so the page knows the current state immediately. */
  connect(req: IncomingMessage, res: ServerResponse, userId: number | null, hello: unknown): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write('retry: 2000\n\n');
    const client: Client = { id: this.nextId++, userId, res };
    this.clients.set(client.id, client);
    req.on('close', () => this.clients.delete(client.id));
    this.write(client, frame('hello', hello));
  }

  publish(event: string, data: unknown): void {
    const text = frame(event, data);
    for (const c of this.clients.values()) this.write(c, text);
  }

  publishTo(userId: number, event: string, data: unknown): void {
    const text = frame(event, data);
    for (const c of this.clients.values()) if (c.userId === userId) this.write(c, text);
  }

  /** Closes every open stream of one user (a banned player). The browser reconnects at once and is then treated as signed out. */
  dropUser(userId: number): number {
    let n = 0;
    for (const c of [...this.clients.values()]) {
      if (c.userId !== userId) continue;
      this.clients.delete(c.id);
      c.res.end();
      n += 1;
    }
    return n;
  }

  private write(c: Client, text: string): void {
    // A browser that cannot keep up is dropped; it reconnects and gets a fresh "hello".
    if (c.res.writableLength > 1_000_000 || c.res.destroyed) {
      this.clients.delete(c.id);
      c.res.destroy();
      return;
    }
    c.res.write(text);
  }
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
