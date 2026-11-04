// PAYUI-1 … PAYUI-6 — the PayPal TEST button on the Shop page (docs/world.md §43). The rules are the server's (tests/server-paypal.test.ts). Here the page only has to: draw nothing about
// PayPal unless the server says PayPal is on, send the server only a look's id (never a price or a player), load PayPal's script from paypal.com only when a button is opened, say plainly
// that it is test money, and have a style rule for everything it draws.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COSMETICS } from '../src/shared/cosmeticCatalog';
import { PAYPAL_CURRENCY, PAYPAL_PRICE_CENTS } from '../src/shared/paypalCatalog';
import { paypalLock, paypalPaidText } from '../src/shared/shopUtil';

const src = (...parts: string[]): string => resolve(process.cwd(), 'src', ...parts);

/** A source file with its comments taken out, so a word in a comment never counts. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const shopScreen = code(src('shared', 'ShopScreen.tsx'));
const payButton = code(src('shared', 'PaypalPay.tsx'));
const apiSource = code(src('shared', 'api.ts'));
const css = readFileSync(src('styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('the PayPal button on the Shop page', () => {
  it('PAYUI-1: the page words are plain: a paid look says it was test money and that Career cash did not change; a repeat says nothing more was given; a badge look says which badge', () => {
    const first = paypalPaidText('Sky Blue', 50, false);
    expect(first).toContain('$0.50');
    expect(first).toMatch(/test mode/i);
    expect(first).toMatch(/No real money/);
    expect(first).toMatch(/Career cash did not change/);
    expect(first).toContain('Sky Blue');
    const again = paypalPaidText('Sky Blue', 50, true);
    expect(again).toMatch(/already finished/);
    expect(again).toMatch(/nothing more was given/);
    expect(again).not.toMatch(/You paid/);
    const badged = COSMETICS.find((c) => c.requiresBadge !== undefined);
    expect(badged).toBeDefined();
    if (!badged) return;
    expect(paypalLock(badged, { badges: [] })).toMatch(/^Needs the ".+" badge$/);
    expect(paypalLock(badged, { badges: [badged.requiresBadge as string] })).toBeNull();
    const plain = COSMETICS.find((c) => c.requiresBadge === undefined && c.earn === undefined);
    expect(plain && paypalLock(plain, { badges: [] })).toBeNull();
    // Test money has its own prices and its own currency, and never looks like Career cash.
    expect(PAYPAL_CURRENCY).toBe('USD');
    expect(PAYPAL_PRICE_CENTS.slice(1).every((c, i, all) => c > 0 && (i === 0 || c > (all[i - 1] as number)))).toBe(true);
  });

  it('PAYUI-2: nothing about PayPal is drawn unless the server says it is on: the button, the banner and the PayPal window all depend on the answer, and an error means "off"', () => {
    expect(shopScreen).toMatch(/api\s*\.paypalConfig\(\)/);
    expect(shopScreen).toMatch(/\.catch\(\(\) => \{\s*if \(alive\) setPaypal\(\{ enabled: false \}\);/);
    expect(shopScreen).toContain('const [paypal, setPaypal] = useState<PaypalConfig | null>(null);'); // unknown until the server answers: nothing is drawn meanwhile
    expect(shopScreen).toMatch(/const viaPaypal = paypal\?\.enabled === true && !owned && !earnedOnly && paypalLock\(def, v\) === null;/);
    expect(shopScreen).toMatch(/\{viaPaypal && \(/);
    expect(shopScreen).toMatch(/\{paypal\?\.enabled === true && \(\s*<p className="notice info paypal-banner" data-testid="paypal-banner">/);
    expect(shopScreen).toMatch(/paying === def\.id && paypal !== null \?/);
    // An earned look is never sold, so it never gets a PayPal button; an owned one neither.
    expect(shopScreen).toContain('!owned && !earnedOnly');
    // The PayPal window and the Career-cash confirmation never show at once.
    expect(shopScreen).toMatch(/setConfirming\(null\);\s*setPaying\(def\.id\);/);
  });

  it('PAYUI-3: the page tells the server only which look (never a price, an amount or a player), and only the order id after the buyer approved', () => {
    expect(apiSource).toContain("paypalConfig: () => request<PaypalConfig>('GET', '/api/paypal/config')");
    expect(apiSource).toContain("paypalCreate: (item: string) => request<PaypalOrderStarted>('POST', '/api/paypal/orders', { item })");
    expect(apiSource).toContain("paypalCapture: (orderId: string) => request<PaypalPaid>('POST', '/api/paypal/capture', { orderId })");
    expect(payButton).toMatch(/api\.paypalCreate\(def\.id\)/);
    expect(payButton).toMatch(/api\.paypalCapture\(data\.orderID\)/);
    expect(payButton).not.toMatch(/purchase_units|currency_code|amount_cents|userId|\bvalue:\s*['"`$\d]/);
    // What the buyer sees as the price is the catalog's, and the same one the server charges.
    expect(payButton).toMatch(/paypalMoneyText\(paypalPriceOf\(def\)\)/);
    // After a payment the page shows what the SERVER says he owns (no guessing).
    expect(shopScreen).toMatch(/setView\(\{ cashCents: out\.cashCents, owned: out\.owned, equipped: out\.equipped, gear: out\.gear, badges: out\.badges \}\);/);
  });

  it('PAYUI-4: PayPal\'s script comes only from paypal.com, only when a button is opened, only for test-mode buttons in US dollars, and nothing secret is anywhere in the page code', () => {
    expect(payButton).toContain("export const PAYPAL_SDK = 'https://www.paypal.com/sdk/js';");
    const urls = payButton.match(/https?:\/\/[^\s'"`)]+/g) ?? [];
    expect(urls).toEqual(['https://www.paypal.com/sdk/js']);
    expect(payButton).toMatch(/client-id=\$\{encodeURIComponent\(clientId\)\}&currency=\$\{PAYPAL_CURRENCY\}&intent=capture&components=buttons&disable-funding=credit,paylater,venmo/);
    expect(payButton).toMatch(/if \(loading !== null && loading\.clientId === clientId\) return loading\.promise;/); // loaded once
    expect(payButton).toMatch(/loadPaypal\(clientId\)/); // inside the component's effect, which only runs when the window is opened
    expect(shopScreen).not.toMatch(/loadPaypal|PAYPAL_SDK|sdkUrl/); // the Shop page itself never loads it
    // The script's address has no secret and never a real-money switch.
    for (const file of ['shared/PaypalPay.tsx', 'shared/paypalCatalog.ts', 'shared/ShopScreen.tsx', 'shared/api.ts', 'shared/shopUtil.ts', 'shared/types.ts']) {
      const text = readFileSync(src(file), 'utf8');
      expect(text, file).not.toMatch(/TQ_PAYPAL_SECRET|client-secret|client_secret|api-m\.paypal\.com|api\.paypal\.com|www\.paypal\.com\/sdk\/js\?.*env=production/);
    }
    // The buyer can always close the window, and cannot while the payment is being finished.
    expect(payButton).toMatch(/disabled=\{working\} onClick=\{onCancel\}/);
    expect(payButton).toContain("setProblem('You closed the PayPal window. Nothing was taken.')");
  });

  it('PAYUI-5: while PayPal loads and while a payment is finished the page says so; a problem is a plain notice with a role; the window says it is test money', () => {
    expect(payButton).toMatch(/Loading PayPal…/);
    expect(payButton).toMatch(/Finishing your payment…/);
    expect(payButton).toMatch(/role="status"/);
    expect(payButton).toMatch(/role="alert"/);
    expect(payButton).toMatch(/aria-busy=\{!ready \|\| working\}/);
    expect(payButton).toMatch(/<span className="paypal-test-tag">TEST<\/span>/);
    expect(payButton).toMatch(/in PayPal test money for \{def\.name\}/);
    expect(shopScreen).toMatch(/<strong>PayPal TEST MODE\.<\/strong>/);
    expect(shopScreen).toMatch(/no real money is ever taken/);
    // Every test id the checks above and the browser rehearsal rely on is there.
    for (const id of ['paypal-pay-', 'paypal-box-', 'paypal-loading-', 'paypal-working-', 'paypal-problem-', 'paypal-cancel-']) expect(payButton).toContain(`data-testid={\`${id}\${def.id}\`}`);
    expect(shopScreen).toContain('data-testid={`shop-paypal-${def.id}`}');
    expect(shopScreen).toContain('data-testid="paypal-banner"');
    // The window stops when the page leaves it: no state is set after that, and PayPal's buttons are closed.
    expect(payButton).toMatch(/let alive = true;/);
    expect(payButton).toMatch(/alive = false;\s*if \(buttons !== null\) void buttons\.close\(\)/);
  });

  it('PAYUI-6: every style class the PayPal parts use has a rule, nothing is animated or fetched by the styles, and the PayPal button colour is a plain colour', () => {
    const used = new Set<string>();
    for (const text of [payButton, shopScreen]) for (const m of text.matchAll(/className="([^"]*paypal[^"]*)"/g)) for (const c of (m[1] as string).split(/\s+/)) if (c.includes('paypal')) used.add(c);
    expect([...used].sort()).toEqual(['btn-paypal', 'paypal-banner', 'paypal-box', 'paypal-pay', 'paypal-pay-line', 'paypal-problem', 'paypal-test-tag', 'paypal-wait']);
    for (const cls of used) expect(css, cls).toMatch(new RegExp(`\\.${cls}\\s*[{,:]`));
    // While the window is open its card takes the whole row of the grid (so PayPal's button has room on a phone).
    expect(shopScreen).toMatch(/\$\{paying === def\.id && paypal !== null \? ' paying' : ''\}/);
    expect(css).toMatch(/\.shop-item\.paying\s*\{[^}]*grid-column:\s*1 \/ -1/);
    const from = css.indexOf('.btn-paypal {');
    const to = css.indexOf('.shop-wearing');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const own = css.slice(from, to);
    expect(own).not.toMatch(/url\(|@import|animation|transition|@keyframes/);
    expect(own).toMatch(/\.btn-paypal\s*\{[^}]*background:\s*#ffc439/);
  });
});
