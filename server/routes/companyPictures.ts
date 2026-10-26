// Pictures for stocks and memecoins. Anybody can look at them (the market is public); only the player who launched a company and the owner can
// change its picture, and the rules for what is accepted are in server/companyPictures.ts (and server/profile.ts decodePicture).

import { HANDLED } from '../router';
import { HttpError, readJson } from '../http';
import { AVATAR_MAX_BYTES, ProfileError } from '../profile';
import type { Router } from '../router';
import type { Services } from '../services';

/** A picture comes as text (base64 is a third bigger than the bytes), plus the JSON around it. */
const PICTURE_BODY_LIMIT = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 1024;

export function registerCompanyPictureRoutes(router: Router, s: Services): void {
  const { companyPictures } = s;

  function guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ProfileError) throw new HttpError(error.status, error.code, error.message);
      throw error;
    }
  }

  /** Every company picture there is, as ticker -> version. The page keeps this list and shows a picture only for the tickers on it. */
  router.get('/api/company-pictures', () => ({ pictures: companyPictures.versions() }));

  /** The picture itself. The address carries the version (?v=...), so a browser can keep it for good as long as the number does not change. */
  router.get('/api/company-picture/:ticker', (ctx) => {
    const picture = companyPictures.image(ctx.params.ticker ?? '');
    if (!picture) throw new HttpError(404, 'no_picture', 'That company has no picture.');
    const tag = `"${picture.updatedMs}"`;
    const asked = ctx.url.searchParams.get('v');
    const headers: Record<string, string> = {
      'Content-Type': picture.mime,
      'Cache-Control': asked === String(picture.updatedMs) ? 'public, max-age=31536000, immutable' : 'public, no-cache',
      ETag: tag,
      'X-Content-Type-Options': 'nosniff',
      // Even if somebody got a page to open this address on its own, nothing in it can run.
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    if (ctx.req.headers['if-none-match'] === tag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return HANDLED;
    }
    ctx.res.writeHead(200, { ...headers, 'Content-Length': picture.data.length });
    ctx.res.end(Buffer.from(picture.data));
    return HANDLED;
  });

  /** Whether the signed-in player may change this company's picture (the launcher and the owner may). */
  router.get('/api/company-picture/:ticker/rights', (ctx) => {
    const user = ctx.requireUser();
    return guard(() => companyPictures.canChange(user, ctx.params.ticker));
  });

  router.post('/api/company-picture/:ticker', async (ctx) => {
    const user = ctx.requireUser();
    const body = await readJson(ctx.req, PICTURE_BODY_LIMIT);
    return guard(() => companyPictures.set(user, { ticker: ctx.params.ticker, image: body.image, requestId: body.requestId }));
  });

  router.post('/api/company-picture/:ticker/remove', async (ctx) => {
    const user = ctx.requireUser();
    const b = await ctx.body();
    return guard(() => companyPictures.clear(user, { ticker: ctx.params.ticker, requestId: b.requestId }));
  });
}
