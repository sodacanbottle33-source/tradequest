// Source-level checks for the profile menu and the owner's admin panel (like menu.test.ts): the menu offers Log in / Log out, the
// admin panel is reachable only through the profile menu and only for the owner, and the admin screens never decide anything
// the server decides (they send requests; they do not change prices or balances themselves).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatCents } from '../src/shared/format';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Profile menu and admin panel (screens)', () => {
  it('ADMUI-1: the profile menu offers Log in and Create account when signed out, and My account and Log out when signed in', () => {
    const menu = code(src('shared', 'ProfileMenu.tsx'));
    for (const text of ['Log in', 'Create account', 'My account', 'Log out']) expect(menu).toContain(text);
    expect(menu).toMatch(/data-testid="profile-button"/);
    expect(menu).toMatch(/sharedStore\.signOut\(\)/);
    expect(menu).toMatch(/aria-haspopup="menu"/);
  });

  it('ADMUI-2: "Admin panel" is in the menu only for the owner, and the admin screen only opens for the owner', () => {
    const menu = code(src('shared', 'ProfileMenu.tsx'));
    const at = menu.indexOf('Admin panel');
    expect(at).toBeGreaterThan(0);
    expect(menu.slice(Math.max(0, at - 400), at)).toMatch(/isOwner &&/);
    expect(menu).toMatch(/const isOwner = user\?\.role === 'owner'/);
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/mode === 'admin' && isOwner && <AdminScreen/);
    expect(shell).toMatch(/mode === 'admin' && s\.authChecked && !isOwner/); // leaving the panel when not (or no longer) the owner
    const header = code(src('ui', 'Header.tsx'));
    expect(header).not.toMatch(/Admin/); // not one of the top menu buttons
  });

  it('ADMUI-3: the admin screens only send requests to the server: they do not set prices, balances or roles themselves', () => {
    const files = ['AdminScreen.tsx', 'AdminMarket.tsx', 'AdminPlayers.tsx', 'AdminLog.tsx'];
    const all = files.map((f) => code(src('shared', f))).join('\n');
    expect(all).toMatch(/api\.adminShock/);
    expect(all).toMatch(/api\.adminHalt/);
    expect(all).toMatch(/api\.adminCash/);
    expect(all).toMatch(/api\.adminCoins/);
    expect(all).not.toMatch(/localStorage|sessionStorage|Math\.random|role\s*[:=]\s*'owner'/);
    const api = code(src('shared', 'api.ts'));
    expect(api).toMatch(/'\/api\/admin\/shock'/);
  });

  it('ADMUI-4: a price move must be reviewed and confirmed before it is sent, with one request id per confirmation', () => {
    const market = code(src('shared', 'AdminMarket.tsx'));
    expect(market).toMatch(/data-testid="admin-review"/);
    expect(market).toMatch(/data-testid="admin-confirm"/);
    expect(market).toMatch(/setReview\(newRequestId\(\)\)/);
    expect(market).toMatch(/requestId: review/);
  });

  it('ADMUI-5: a halted company shows as halted in the list and on its page, and the order form is blocked', () => {
    expect(code(src('shared', 'MarketScreen.tsx'))).toMatch(/row\.halted &&/);
    const company = code(src('shared', 'CompanyView.tsx'));
    expect(company).toMatch(/halted \? \(autoPause \? PAUSED_MESSAGE\(detail\.ticker, autoPause\) : HALTED_MESSAGE\(detail\.ticker\)\)/);
    expect(company).toMatch(/companies\.find\(\(c\) => c\.ticker === detail\.ticker\)/);
    expect(company).toMatch(/listed\?\.halted \?\? detail\.halted/); // follows the live company list, so a pause or reopening shows at once
    expect(company).toMatch(/data-testid="halted-badge"/);
  });

  it('ADMUI-6: there is no dial for how strongly trades move prices (one fixed strength, only explained), and every trader sees what their order will do to the price', () => {
    const market = code(src('shared', 'AdminMarket.tsx'));
    expect(market).not.toMatch(/adminFlow|admin-flow-\$/); // no buttons, no request
    expect(market).toContain('data-testid="admin-flow-note"'); // only the explanation
    expect(code(src('shared', 'api.ts'))).not.toMatch(/\/api\/admin\/flow|adminFlow/);
    const panel = code(src('shared', 'TradePanel.tsx'));
    expect(panel).toMatch(/estimate\.moveBps !== 0 &&/); // shown only when the order really moves the price
    expect(panel).toMatch(/data-testid="estimate-move"/);
    expect(panel).toMatch(/formatBps\(estimate\.moveBps\)/);
    expect(code(src('shared', 'AdminLog.tsx'))).toMatch(/case 'flow':/);
  });

  it('ADMUI-8: banning, unbanning, shares, resets, the announcement and the pause switch are only requests to the server, and the risky ones need a second click with their own request id', () => {
    const players = code(src('shared', 'AdminPlayers.tsx'));
    for (const call of ['api.adminBan', 'api.adminUnban', 'api.adminShares', 'api.adminReset']) expect(players).toContain(call);
    expect(players).toMatch(/setConfirm\(\{ type: 'ban', id: newRequestId\(\) \}\)/);
    expect(players).toMatch(/setConfirm\(\{ type: 'reset', id: newRequestId\(\) \}\)/);
    expect(players).toMatch(/requestId: confirm\.id, username: player\.username, reason/);
    expect(players).toMatch(/requestId: confirm\.id, username: player\.username \}\)/);
    expect(players).toMatch(/data-testid="admin-ban-confirm"/);
    expect(players).toMatch(/data-testid="admin-reset-confirm"/);
    expect(players).toMatch(/The owner cannot be banned\./); // no ban button for the owner's own row
    const broadcast = code(src('shared', 'AdminBroadcast.tsx'));
    for (const call of ['api.adminAnnounce', 'api.adminPause']) expect(broadcast).toContain(call);
    expect(broadcast).toMatch(/setConfirmPause\(newRequestId\(\)\)/);
    expect(broadcast).toMatch(/requestId: confirmPause/);
    expect(broadcast).toMatch(/data-testid="admin-pause-confirm"/);
    const all = [players, broadcast].join('\n');
    expect(all).not.toMatch(/localStorage|sessionStorage|Math\.random|role\s*[:=]\s*'owner'/);
    const api = code(src('shared', 'api.ts'));
    for (const path of ['ban', 'unban', 'shares', 'reset', 'announce', 'pause']) expect(api).toContain(`'/api/admin/${path}'`);
    expect(code(src('shared', 'AdminMarket.tsx'))).toMatch(/<AdminBroadcast state=\{state\} reload=\{reload\} \/>/);
    const log = code(src('shared', 'AdminLog.tsx'));
    for (const action of ['ban', 'unban', 'shares', 'reset', 'announce', 'pause', 'unpause']) expect(log).toContain(`case '${action}':`);
  });

  it('ADMUI-9: every player sees the announcement and the pause notice, a banned player is told why, and the page learns of them at once', () => {
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/<Notices \/>/);
    const notices = code(src('shared', 'Notices.tsx'));
    expect(notices).toMatch(/data-testid="banned-notice"/);
    expect(notices).toMatch(/data-testid="paused-notice"/);
    expect(notices).toMatch(/data-testid="announcement"/);
    expect(notices).toMatch(/s\.health\?\.announcement/);
    expect(notices).not.toMatch(/localStorage|sessionStorage/);
    const store = code(src('shared', 'store.ts'));
    expect(store).toMatch(/addEventListener\('notice'/);
    expect(store).toMatch(/banned: me\.banned \?\? null/);
    expect(store).toMatch(/void this\.recheckMe\(\)/); // a 401 on a signed-in page asks /api/me whether it was a ban
  });

  it('ADMUI-10: the Create stock tab only sends a request (after a second click with its own request id) and shows what the server says', () => {
    const screen = code(src('shared', 'AdminScreen.tsx'));
    expect(screen).toMatch(/\['stocks', 'Create stock'\]/);
    expect(screen).toMatch(/<AdminStocks state=\{state\} reload=\{reload\} \/>/);
    const stocks = code(src('shared', 'AdminStocks.tsx'));
    expect(stocks).toContain('api.adminStock');
    expect(stocks).toMatch(/setConfirm\(newRequestId\(\)\)/);
    expect(stocks).toMatch(/requestId: confirm,/);
    for (const id of ['admin-stock-name', 'admin-stock-ticker', 'admin-stock-sector', 'admin-stock-tier', 'admin-stock-personality', 'admin-stock-price', 'admin-stock-start', 'admin-stock-confirm', 'admin-stock-cancel', 'admin-stock-list']) {
      expect(stocks).toContain(`data-testid="${id}"`);
    }
    expect(stocks).toMatch(/state\?\.stockForm/); // the lists and limits come from the server
    expect(stocks).not.toMatch(/localStorage|sessionStorage|Math\.random|role\s*[:=]\s*'owner'/);
    expect(code(src('shared', 'api.ts'))).toContain("'/api/admin/stock'");
    expect(code(src('shared', 'AdminLog.tsx'))).toContain("case 'stock':");
    // No choice of how strongly trades move a stock: neither in the form nor on a row of the list, and no request for it.
    expect(stocks).not.toMatch(/ensitivit/);
    expect(code(src('shared', 'api.ts'))).not.toMatch(/stock-sensitivity|adminStockSensitivity/);
    // The log still reads the entries older versions wrote.
    expect(code(src('shared', 'AdminLog.tsx'))).toContain("case 'flow':");
    expect(code(src('shared', 'AdminLog.tsx'))).toContain("case 'sens':");
  });

  it('ADMUI-12: the owner\'s Launches tab only lists what players launched (no coin maker of his own any more) and reads it from the server', () => {
    const screen = code(src('shared', 'AdminScreen.tsx'));
    expect(screen).toMatch(/\['launches', 'Launches'\]/);
    expect(screen).toMatch(/<AdminLaunches state=\{state\} \/>/);
    expect(screen).not.toMatch(/AdminCoins|Create coin/);
    const launches = code(src('shared', 'AdminLaunches.tsx'));
    for (const id of ['admin-launch-list', 'admin-launch-empty']) expect(launches).toContain(`data-testid="${id}"`);
    expect(launches).toMatch(/state\?\.launches/);
    expect(launches).not.toMatch(/api\./); // read only: no request at all
    expect(launches).not.toMatch(/localStorage|sessionStorage|Math\.random|role\s*[:=]\s*'owner'/);
    const api = code(src('shared', 'api.ts'));
    expect(api).not.toContain('/api/admin/coin\'');
    expect(api).not.toContain('/api/admin/coin-preview');
    expect(code(src('shared', 'AdminLog.tsx'))).toContain("case 'coin':"); // the log still reads the entries the earlier owner-only tab wrote
  });

  it('ADMUI-13: the Launch tab (every player) has no size menu (the size comes from the money), only sends a request after a second click with its own request id, and takes every number from the server', () => {
    const shell = code(src('shared', 'SharedApp.tsx'));
    expect(shell).toMatch(/\['launch', 'Launch'\]/);
    expect(shell).toMatch(/<LaunchScreen onOpen=\{openCompany\} \/>/);
    const launch = code(src('shared', 'LaunchScreen.tsx'));
    expect(launch).toMatch(/<AuthPanel \/>/); // signed out: the sign-in form
    expect(launch).toContain('api.launchCoin(');
    expect(launch).toContain('api.launchStock(');
    expect(launch).toContain('api.rugPull(');
    expect(launch).toMatch(/api\.launchCoinPreview/);
    // A coin's starting price is not typed: there is no price box in the coin form, nothing about a price is sent, and the price shown is the server's.
    expect(launch).not.toContain('htmlFor="launch-coin-price"');
    expect(launch).not.toMatch(/<input[^>]*launch-coin-price/);
    expect(launch).not.toMatch(/api\.launchCoin\(\{[^}]*priceCents/);
    expect(launch).toMatch(/<strong data-testid="launch-coin-price">\{formatCents\(shown\.priceCents\)\}<\/strong>/);
    expect(launch).toMatch(/launchCoinPreview\(s\)/);
    expect(launch).toMatch(/api\.launchStockPreview/);
    expect((launch.match(/setConfirm\(newRequestId\(\)\)/g) ?? []).length).toBe(2); // the coin and the stock form
    expect(launch).toMatch(/requestId: confirm,/);
    expect(launch).toMatch(/requestId: confirm\.id,/); // the rug pull
    for (const id of [
      'launch-coin-name', 'launch-coin-ticker', 'launch-coin-seed', 'launch-coin-price', 'launch-coin-preview', 'launch-coin-size', 'launch-coin-start', 'launch-coin-confirm', 'launch-coin-cancel', 'launch-coin-ladder',
      'launch-stock-name', 'launch-stock-ticker', 'launch-stock-sector', 'launch-stock-seed', 'launch-stock-price', 'launch-stock-preview', 'launch-stock-start', 'launch-stock-confirm', 'launch-stock-cancel',
    ]) {
      expect(launch).toContain(`data-testid="${id}"`);
    }
    for (const id of ['launch-row-${l.ticker}', 'launch-rug-${l.ticker}', 'launch-rug-confirm-${l.ticker}', 'launch-rug-cancel-${l.ticker}']) expect(launch).toContain(`data-testid={\`${id}\`}`);
    // No size to pick: the only select is the stock's sector, and the forms are the server's (limits, ladder).
    expect((launch.match(/<select/g) ?? []).length).toBe(1);
    expect(launch).not.toMatch(/\btier\b\s*[:=]|launch-coin-tier|launch-stock-tier/);
    expect(launch).toMatch(/state\.coinForm/);
    expect(launch).toMatch(/state\.stockForm/);
    // The dump is a normal order: the screen shows the server's estimate before and the server's answer after, and decides nothing itself.
    expect(launch).toMatch(/api\.estimate\(l\.ticker, 'sell', l\.sharesNow, 'career'\)/);
    expect(launch).not.toMatch(/localStorage|sessionStorage|Math\.random|role\s*[:=]\s*'owner'/);
    const api = code(src('shared', 'api.ts'));
    for (const path of ["'/api/launch'", "'/api/launch/coin'", "'/api/launch/stock'", "'/api/launch/rug'", '/api/launch/coin-preview', '/api/launch/stock-preview']) expect(api).toContain(path);
  });

  it('ADMUI-11: a company the market paused by itself is shown as "Paused" with the reason and the reopening time, and the owner list marks it Auto', () => {
    const company = code(src('shared', 'CompanyView.tsx'));
    expect(company).toContain('PAUSED_MESSAGE');
    expect(company).toMatch(/autoPause \? 'Paused' : 'Halted'/);
    expect(company).toMatch(/reopensInTicks/);
    expect(code(src('shared', 'MarketScreen.tsx'))).toMatch(/row\.autoPause \? 'Paused' : 'Halted'/);
    expect(code(src('shared', 'AdminMarket.tsx'))).toMatch(/h\.auto &&/);
    expect(code(src('shared', 'types.ts'))).toMatch(/autoPause:/);
  });

  it('ADMUI-7: an average price that is a fraction of a cent is shown rounded to a cent, not as garbage like "$8.21.5161"', () => {
    expect(formatCents(821.516174121405697)).toBe('$8.22');
    expect(formatCents(821)).toBe('$8.21');
    expect(formatCents(3479)).toBe('$34.79');
    expect(formatCents(100_000)).toBe('$1,000.00');
  });
});
