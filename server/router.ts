// A tiny router: patterns like /api/market/:ticker, handlers that return the JSON answer.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { User } from './auth';
import { HttpError, readJson } from './http';

export interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Record<string, string>;
  readonly user: User | null;
  readonly ip: string;
  readonly token: string | undefined;
  /** The JSON body (POST only). */
  body(): Promise<Record<string, unknown>>;
  /** Extra headers for the answer (cookies). */
  readonly headers: Record<string, string | string[]>;
  /** Throws 401 unless signed in. */
  requireUser(): User;
}

export const HANDLED = Symbol('handled');
export type Result = unknown | { status: number; body: unknown } | typeof HANDLED;
export type Handler = (ctx: Ctx) => Result | Promise<Result>;

interface Route {
  readonly method: string;
  readonly parts: string[];
  readonly handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: 'GET' | 'POST', pattern: string, handler: Handler): void {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }

  get(pattern: string, handler: Handler): void {
    this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add('POST', pattern, handler);
  }

  /** The handler and URL parameters for a request, or null. `methodMismatch` is true if the path exists for another method. */
  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | { methodMismatch: boolean } {
    const segs = path.split('/').filter(Boolean);
    let mismatch = false;
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i += 1) {
        const p = r.parts[i] as string;
        const s = segs[i] as string;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(s);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method !== method) {
        mismatch = true;
        continue;
      }
      return { handler: r.handler, params };
    }
    return { methodMismatch: mismatch };
  }
}

export function makeBodyReader(req: IncomingMessage): () => Promise<Record<string, unknown>> {
  let cached: Promise<Record<string, unknown>> | null = null;
  return () => (cached ??= readJson(req));
}

export function requireUserOf(user: User | null): User {
  if (!user) throw new HttpError(401, 'sign_in_required', 'Sign in to do that.');
  return user;
}
