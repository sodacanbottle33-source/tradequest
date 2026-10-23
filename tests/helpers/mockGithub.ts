// A tiny pretend GitHub for the tests (and for rehearsing the online backup without a real account): just the few address the
// backup store uses — a repository, one release, and that release's assets (upload, list, download, delete).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockAsset {
  id: number;
  name: string;
  data: Buffer;
  state: 'uploaded' | 'starter';
}

export interface MockGithub {
  /** Address to give the program as both TQ_BACKUP_API and TQ_BACKUP_UPLOAD_API, e.g. http://127.0.0.1:41234 */
  readonly url: string;
  readonly assets: MockAsset[];
  /** Every request seen, with the Authorization header it carried (undefined = none). */
  readonly requests: { method: string; path: string; auth: string | undefined }[];
  readonly flags: {
    /** The repository answers 404 (does not exist, or the token cannot see it). */
    hideRepo: boolean;
    /** The repository is public. */
    isPublic: boolean;
    /** The next upload fails with 502 and leaves an unfinished ("starter") asset behind. */
    failNextUpload: boolean;
    /** Release exists already. */
    hasRelease: boolean;
  };
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers });
  res.end(raw);
}

export async function startMockGithub(options: { repo?: string; token?: string } = {}): Promise<MockGithub> {
  const repo = options.repo ?? 'owner/data';
  const token = options.token ?? 'secret-token';
  const assets: MockAsset[] = [];
  const requests: MockGithub['requests'] = [];
  const flags: MockGithub['flags'] = { hideRepo: false, isPublic: false, failNextUpload: false, hasRelease: false };
  let nextId = 100;
  const RELEASE_ID = 7;

  // The download address handed out by a redirect lives on ANOTHER origin (as on GitHub: a storage host with a signed link), so a
  // client that forwards its token there is caught by the 'auth' column of the request log.
  const storage = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    requests.push({ method: req.method ?? 'GET', path: url.pathname, auth: req.headers.authorization });
    const dl = /^\/download\/(\d+)$/.exec(url.pathname);
    const a = dl ? assets.find((x) => x.id === Number(dl[1])) : undefined;
    if (a) send(res, 200, a.data);
    else send(res, 404, { message: 'Not Found' });
  });
  await new Promise<void>((resolve) => storage.listen(0, '127.0.0.1', resolve));
  const storagePort = (storage.address() as AddressInfo).port;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock');
      const path = url.pathname;
      const method = req.method ?? 'GET';
      const auth = req.headers.authorization;
      requests.push({ method, path, auth });
      const body = await readBody(req);

      if (auth !== `Bearer ${token}`) return send(res, 401, { message: 'Bad credentials' });
      const base = `/repos/${repo}`;
      if (!path.startsWith(`/repos/`)) return send(res, 404, { message: 'Not Found' });
      if (flags.hideRepo || !path.startsWith(base)) return send(res, 404, { message: 'Not Found' });

      if (method === 'GET' && path === base) return send(res, 200, { full_name: repo, private: !flags.isPublic });
      if (method === 'GET' && path === `${base}/releases/tags/tradequest-data`) return flags.hasRelease ? send(res, 200, { id: RELEASE_ID, tag_name: 'tradequest-data' }) : send(res, 404, { message: 'Not Found' });
      if (method === 'POST' && path === `${base}/releases`) {
        if (flags.hasRelease) return send(res, 422, { message: 'Validation Failed' });
        const info = JSON.parse(body.toString('utf8')) as { tag_name?: string; draft?: boolean };
        if (info.tag_name !== 'tradequest-data' || info.draft === true) return send(res, 422, { message: 'Validation Failed' });
        flags.hasRelease = true;
        return send(res, 201, { id: RELEASE_ID, tag_name: 'tradequest-data' });
      }
      if (method === 'GET' && path === `${base}/releases/${RELEASE_ID}/assets`) {
        const per = Number(url.searchParams.get('per_page') ?? 30);
        const page = Number(url.searchParams.get('page') ?? 1);
        const list = assets.slice((page - 1) * per, page * per).map((a) => ({ id: a.id, name: a.name, size: a.data.length, state: a.state }));
        return send(res, 200, list);
      }
      if (method === 'POST' && path === `${base}/releases/${RELEASE_ID}/assets`) {
        const name = url.searchParams.get('name') ?? '';
        if (req.headers['content-type'] !== 'application/gzip') return send(res, 415, { message: 'Unsupported media type' });
        if (assets.some((a) => a.name === name)) return send(res, 422, { message: 'Validation Failed', errors: [{ code: 'already_exists' }] });
        if (flags.failNextUpload) {
          flags.failNextUpload = false;
          assets.push({ id: nextId++, name, data: Buffer.alloc(0), state: 'starter' });
          return send(res, 502, { message: 'Bad gateway' });
        }
        const asset: MockAsset = { id: nextId++, name, data: body, state: 'uploaded' };
        assets.push(asset);
        return send(res, 201, { id: asset.id, name, size: body.length, state: 'uploaded' });
      }
      const one = new RegExp(`^${base}/releases/assets/(\\d+)$`).exec(path);
      if (one) {
        const a = assets.find((x) => x.id === Number(one[1]));
        if (!a) return send(res, 404, { message: 'Not Found' });
        if (method === 'DELETE') {
          assets.splice(assets.indexOf(a), 1);
          return send(res, 204);
        }
        if (method === 'GET') {
          if (req.headers.accept === 'application/octet-stream') return send(res, 302, undefined, { Location: `http://127.0.0.1:${storagePort}/download/${a.id}` });
          return send(res, 200, { id: a.id, name: a.name, size: a.data.length, state: a.state });
        }
      }
      return send(res, 404, { message: 'Not Found' });
    })().catch((error: unknown) => {
      send(res, 500, { message: String(error) });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    assets,
    requests,
    flags,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        storage.closeAllConnections?.();
        storage.close();
        server.close(() => resolve());
      }),
  };
}
