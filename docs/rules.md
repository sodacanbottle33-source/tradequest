# TradeQuest — Milestone 1 Rules (`docs/rules.md`)

Status: **v0.3 — approved for implementation.**
Scope: Milestone 1 only (single-player, one fictional stock, long-only, turn-based).
**Addendum (Stage 2a):** §12 adds *market mode* — ten fictional stocks sharing one cash balance (engine v2). §1–§11 still describe the single-stock engine (engine v1), which stays in the code and keeps its tests; the app now plays market mode.

Words like **must**, **must not** and **may** are used deliberately. If code and this document disagree, this document wins until it is changed on purpose.

### Changes since v0.2 (clarifications only — no design changes)
- §5.1: Mulberry32 may use the bitwise operators and `Math.imul` its implementation needs; the exact reference implementation is now written out.
- §5.6: golden values must come from an independent reference implementation, never from the code under test.
- §3.4–3.6: negative display values (percentages, P&L) round their **magnitude** half-up and then apply the sign. Fixes a contradiction: v0.2 said every rounded value was non-negative, but a return percentage can be negative.
- §6.2: "whole positive number" defined exactly (digits only, no leading zero).
- §4.7: actions that are not allowed in the current state (e.g. Next after the round is finished) return the state unchanged.

### Changes since v0.1
- Added 10 **history candles** before the 60 playable candles (70 candles generated in total). Timeline (§4), draw order (§5.3) and indexing changed accordingly.
- The first order can now be submitted while viewing the last history candle and fills at the open of the first playable candle.
- Resolved open questions 1, 2, 4 and the news question (§11). Replacing a pending order now shows a notice (§6.4).

---

## 1. Locked decisions

| # | Decision |
|---|----------|
| D1 | Turn-based market. The player clicks **Next** to reveal one candle at a time. |
| D2 | Whole shares only. The fictional stock's first price is between $20.00 and $50.00. |
| D3 | Long positions only: buy shares, sell shares you own. No short selling, no fees. (Leverage, short selling, stop-loss and take-profit, memecoins and the memecoin trading fee exist only in the shared market, not in these offline modes: see docs/world.md §6.1–6.4, §6.6 and §12.) |
| D4 | All money and prices are stored as **integer cents**. Rounding rules are in §3. |
| D5 | Orders fill at the **open of the next candle**, never at a price already shown. |
| D6 | **10 history candles** are shown before the round. They give context only and can never be traded at. |
| D7 | The round has exactly **60 playable candles**. Any open position is closed at the final close for the results screen. |
| D8 | An order the player cannot afford at the fill price is **rejected entirely** (no partial fills). |
| D9 | At most **one pending order**. Submitting a new one replaces it, and the player is told. |
| D10 | Milestone 1 uses a **plain random walk**: no news, no events. |

---

## 2. Parameters

Values marked *tunable* are first guesses to be adjusted through playtesting. Changing any engine parameter changes the market, so it requires an engine-version bump (§5.6).

| Name | Value | Notes |
|------|-------|-------|
| `START_CASH` | 100000 | cents = $1,000.00 |
| `HISTORY_LENGTH` | 10 | history candles, indices 1–10 |
| `ROUND_LENGTH` | 60 | playable candles, indices 11–70 |
| `TOTAL_CANDLES` | 70 | `HISTORY_LENGTH + ROUND_LENGTH` |
| `FIRST_PLAYABLE` | 11 | index of the first playable candle |
| `LAST_INDEX` | 70 | index of the last candle |
| `START_PRICE_MIN` | 2000 | cents = $20.00 (open of candle 1) |
| `START_PRICE_MAX` | 5000 | cents = $50.00 (open of candle 1) |
| `MIN_PRICE` | 100 | cents = $1.00; no price may go below this |
| `MAX_ORDER_QTY` | 1000000 | input sanity limit |
| `DRIFT` | 0 | *tunable*; average return per candle |
| `BODY_SIGMA` | 0.015 | *tunable*; typical open→close move (1.5%) |
| `GAP_SIGMA` | 0.002 | *tunable*; typical close→next-open gap (0.2%) |
| `MAX_MOVE` | 0.10 | *tunable*; open→close return clamped to ±10% |
| `MAX_GAP` | 0.02 | *tunable*; gap clamped to ±2% |
| `WICK_MAX` | 0.01 | *tunable*; wicks extend up to 1% beyond the body |

Note: the $20–$50 range applies to the open of **candle 1** (the first history candle). The first playable candle will usually be close to that range but is not guaranteed to be inside it.

---

## 3. Money, units and rounding

1. Every price, cash balance, cost basis, proceeds and P&L value is an **integer number of cents**.
2. Share quantities are **integers ≥ 0**.
3. Because price × quantity is integer × integer, **buying and selling never needs rounding**. Rounding happens only in the three places below.
4. **Rounding rule (`roundHalfUp`)**: round to the nearest integer; exact halves round **up** (toward +∞). It is only ever applied to **non-negative** values.
   - For a ratio of integers `a / b` (with `a ≥ 0`, `b > 0`), compute with integer math: `floor((2·a + b) / (2·b))`. Do not divide in floating point first.
   - **Negative display values** (a negative return %, for example) are formatted by rounding the **magnitude** with `roundHalfUp` and then putting the minus sign back. So −0.005% shows as "−0.01%", the mirror image of +0.005% → "0.01%". A value that rounds to zero shows without a sign ("0.00%").
5. **Where rounding is used:**
   - (a) **Price generation** (§5): each generated price is rounded to whole cents.
   - (b) **Cost basis removed on a partial sell** (§7.3).
   - (c) **Display only**: average entry price and percentage values. Displayed values are never fed back into calculations.
6. Dollar display: `cents / 100` shown with exactly 2 decimals (e.g. 253336 → "$2,533.36"). Percentages shown with 2 decimals.
7. All integers must stay within JavaScript's safe-integer range. With the parameters above, values stay far below that limit; the code should still assert `Number.isSafeInteger` on stored values in development.

---

## 4. Round timeline and order of events

### 4.1 Indexing

There is **one global candle index `i` from 1 to 70**. All code uses this index.

| Indices | Kind | Tradable? |
|---------|------|-----------|
| 1–10 | History candles | **Never.** No order can fill at any price of these candles. |
| 11–70 | Playable candles | Orders fill at their **open**. End-of-round liquidation uses the **close of 70**. |

For display, a playable candle shows its **round number** `r = i − 10` ("Candle 1 of 60" … "Candle 60 of 60"). History candles are labelled "History" and are visually distinct on the chart (e.g. dimmed or behind a "Round starts" divider).

### 4.2 Terms

- **Current index `k`**: the newest candle the player can see (10 to 70).
- **Visible candles**: candles 1..k, all four values (open, high, low, close).
- **Mark price**: close of candle k. Used for unrealized P&L and equity.
- **Pending order**: at most one order waiting to be filled on the next advance.

### 4.3 Round start

1. A seed is chosen (§8). All 70 candles are generated from it (§5).
2. Account is set to: cash = `START_CASH`, shares = 0, cost basis = 0, realized P&L = 0, no trades, no pending order, no notices.
3. **Candles 1–10 (all history) are shown immediately and in full.** k = 10. Mark price = close₁₀. The round counter shows "Round starts next candle".
4. The player may now submit an order. It fills at the **open of candle 11** (the first playable candle) at the earliest.

So: the first decision is made with 10 candles of context, and the first possible fill is the open of the first playable candle — a price the player has not seen.

### 4.4 Each turn (while 10 ≤ k ≤ 69)

The player may, in any order and as many times as they like:

- view candles 1..k and their account;
- submit an order (§6), which becomes the pending order;
- cancel the pending order;
- submit a new order, which **replaces** the pending order (§6.4).

Then the player clicks **Next**. The advance runs these steps **in this exact order**:

1. Check k < 70. (If not, Next is not allowed — see §4.5.)
2. Read candle k+1 from the generated sequence. It is not yet visible.
3. If there is a pending order, process it at **fill price = open₍k+1₎**:
   - re-validate it (§6.3);
   - if valid, fill it and update the account (§7);
   - if invalid, reject it, leave the account unchanged and show the player why.
4. Clear the pending order (it was filled or rejected; it never carries over).
5. Set k = k + 1. Candle k is now visible in full.
6. Recompute mark price, unrealized P&L and equity at closeₖ.

Consequences:
- Because k starts at 10, the first advance reveals candle 11, so **every fill is at an index from 11 to 70**. History candles can never be traded at.
- There are exactly **60 advances** in a round and at most **one player fill per advance** (so at most 60 player trades).
- A fill price is always a price the player had **not** seen when they submitted the order.
- The player's actions can never change any candle (§5.5).

### 4.5 The last candle (k = 70)

1. When k = 70, **order entry is disabled**: no submit, no Next. There is no candle 71 to fill at.
2. There cannot be a pending order at this point (an order submitted at k = 69 was filled or rejected while advancing to 70).
3. The only available action is **Finish round**.

### 4.6 Finish round (end-of-round liquidation)

1. If shares > 0, the engine sells **all** shares at **close₇₀** using the normal sell accounting (§7.3) and records it as a trade of type `liquidation`.
2. If shares = 0, no liquidation trade is recorded.
3. The round state becomes `FINISHED`. No further actions change the account; Finish is idempotent (doing it twice changes nothing).
4. Equity immediately before and after liquidation is identical (shares × close₇₀ becomes cash).
5. The results screen shows: seed, final equity, total return in $ and %, total realized P&L, number of player trades, and the full trade history.

> Liquidating at close₇₀ is the one place a fill uses a price the player has already seen. This is acceptable because it is automatic, not a player decision, and only used to score the round.

### 4.7 Round states

`PLAYING` (k from 10 to 70) → `FINISHED` (after Finish round). Reset (§9) can be used from either state.

An action that is not available in the current state — Next at k = 70, Finish before k = 70, Cancel with no pending order, or any order action after `FINISHED` — **returns the state unchanged** (the UI disables these controls, so no notice is needed). Order submissions that fail validation while `PLAYING` (§6.2) leave the account and pending order unchanged but add a notice explaining why.

### 4.8 Timeline summary

| Player sees up to | Player can | Next reveals | A pending order fills at |
|-------------------|-----------|--------------|--------------------------|
| k = 10 (last history) | submit / cancel / replace | candle 11 (round 1) | open₁₁ |
| k = 11 (round 1) | submit / cancel / replace | candle 12 (round 2) | open₁₂ |
| … | … | … | … |
| k = 69 (round 59) | submit / cancel / replace | candle 70 (round 60) | open₇₀ |
| k = 70 (round 60) | Finish round only | — | liquidation at close₇₀ |

---

## 5. Price engine

### 5.1 Seeded random number generator (RNG)

- Use **mulberry32**, a small, well-known 32-bit PRNG. Input: an unsigned 32-bit integer seed. Output: a stream of numbers `u` with 0 ≤ u < 1.
- **Reference implementation** (this exact code is the definition; the bitwise operators `| ^ >>>` and `Math.imul` are required by it and are allowed here — they are exact 32-bit integer operations and behave identically in every JavaScript engine):

  ```js
  // state starts as the seed (unsigned 32-bit integer)
  function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  ```

- These integer operations are allowed **only inside the RNG**. The candle generator must take every random number from this RNG, in the fixed draw order of §5.3.
- **Why the same seed always gives the same candles:** a PRNG is not truly random. It is a fixed formula that turns an internal state into the next number and then updates the state. The seed is the starting state. Same seed → same starting state → the formula produces the **exact same stream of numbers, in the same order, every time**. If the candle generator (a) uses only that stream, (b) always consumes numbers in the same fixed order, and (c) does the same arithmetic, it must produce the same 70 candles.
- That determinism breaks if any of these happen, so they are **forbidden** in the engine:
  - calling `Math.random()`, `Date.now()` or anything else outside the seeded stream;
  - skipping or adding draws depending on conditions (e.g. "only draw a gap if i > 1", or different draws for history vs playable candles);
  - letting player actions consume random numbers;
  - using `Math.exp`, `Math.log`, `Math.sin`, `Math.cos`, `Math.pow`. These may differ in the last bits between browsers, which would matter for multiplayer later. Only `+ − × ÷`, `Math.floor`, `Math.abs`, `Math.min`, `Math.max` are used.

### 5.2 Normal-ish random numbers without `log`/`cos`

`z = (u₁ + u₂ + … + u₁₂) − 6`

The sum of 12 uniform numbers has mean 6 and standard deviation 1, so `z` is approximately standard-normal and naturally bounded to [−6, +6]. Each `z` consumes exactly **12** draws.

### 5.3 Exact generation sequence (fixed)

History and playable candles are generated by **the same loop and the same formulas**. The only difference between them is how the game treats them (§4.1).

1. Draw **1** `u` → start price: `START_PRICE_MIN + floor(u × (START_PRICE_MAX − START_PRICE_MIN + 1))`.
2. For each candle **i = 1, 2, …, 70**, in order, draw exactly:
   1. `zGap` (12 draws)
   2. `zBody` (12 draws)
   3. `uUp` (1 draw)
   4. `uDown` (1 draw)

Draw positions (1-based):

| What | Draws |
|------|-------|
| Start price | 1 |
| Candle i | `2 + 26·(i−1)` to `1 + 26·i` |
| Candle 1 (history) | 2–27 |
| Candle 10 (last history) | 236–261 |
| Candle 11 (first playable) | 262–287 |
| Candle 70 (last) | 1796–1821 |
| **Total per round** | **1821** |

Candle 1 still consumes its `zGap` even though it is not used.

### 5.4 Candle formulas

Let `clamp(x, lo, hi) = min(max(x, lo), hi)`. For candle i:

- **Open**
  - i = 1: `open₁ = startPrice`
  - i ≥ 2: `gap = clamp(GAP_SIGMA × zGap, −MAX_GAP, +MAX_GAP)`; `openᵢ = max(MIN_PRICE, roundHalfUp(closeᵢ₋₁ × (1 + gap)))`
- **Close**
  - `ret = clamp(DRIFT + BODY_SIGMA × zBody, −MAX_MOVE, +MAX_MOVE)`
  - `closeᵢ = max(MIN_PRICE, roundHalfUp(openᵢ × (1 + ret)))`
- **High**: `highᵢ = roundHalfUp(max(openᵢ, closeᵢ) × (1 + uUp × WICK_MAX))`
- **Low**: `lowᵢ = max(MIN_PRICE, roundHalfUp(min(openᵢ, closeᵢ) × (1 − uDown × WICK_MAX)))`

(Here `roundHalfUp` of a floating-point value is `floor(x + 0.5)`; inputs are positive.)

The gap into candle 11 is generated exactly like every other gap: the first playable open is close₁₀ moved by a small random gap.

**Guaranteed properties of every candle** (checked by tests):
- all four values are integers ≥ `MIN_PRICE`;
- `low ≤ min(open, close)` and `high ≥ max(open, close)`;
- open-to-close move within ±`MAX_MOVE` (before the `MIN_PRICE` floor and rounding);
- gap from previous close within ±`MAX_GAP` (before floor and rounding).

### 5.5 Independence from the player

All 70 candles are generated at round start from the seed alone. Trades, cancels, timing and clicks never touch the RNG. Therefore **the same seed gives the same market no matter how the player trades.**

The UI and any state the UI reads must only expose candles 1..k. (In single-player, a determined user could inspect memory with dev tools; that is acceptable for Milestone 1 and is solved later with server-side rounds.)

### 5.6 Engine version

`ENGINE_VERSION = 1`. Any change to the formulas, draw order, candle counts or tunable parameters changes the candles for a given seed and must bump the version. A round is identified by `(ENGINE_VERSION, seed)`.

**Golden values must be independent.** The expected RNG outputs and the candle snapshot used by the tests are produced by a separate reference implementation (`tools/reference_engine.py`, written in Python directly from this spec), never by running the TypeScript code being tested. Hand-computed candles (ENG-13, HIST-01) are worked out on paper from the formulas. If the TypeScript engine and the reference disagree, one of them is wrong and must be investigated — the fixture must not simply be regenerated to make a test pass. Regenerating the fixture is only allowed together with an `ENGINE_VERSION` bump.

### 5.7 What this model is (and isn't)

A plain random walk with small gaps — no trends, no news, no expectations. That is intentional for Milestone 1: it lets us test trading and accounting on a neutral market. News, expectations and surprises are Milestone 2 and will be added as additional, documented draws (with an engine-version bump).

---

## 6. Orders

### 6.1 Order fields

- `side`: `BUY` or `SELL`
- `quantity`: integer
- `submittedAt`: the index k when submitted

### 6.2 Validation at submission

An order is accepted as pending only if **all** of these hold:

1. Round state is `PLAYING` and k < 70.
2. Quantity is an integer with 1 ≤ quantity ≤ `MAX_ORDER_QTY`. The input text must consist only of the digits 0–9 and must not start with 0 (pattern `^[1-9][0-9]*$`): no decimals, signs, spaces, exponents, leading zeros or empty input.
3. `SELL`: quantity ≤ shares held.
4. `BUY`: estimated cost `quantity × closeₖ` ≤ cash. This is only an **estimate**; the UI labels it "Est. cost at last close".

If any check fails, the order is not accepted and the player sees which rule failed. A failed submission does **not** remove an existing pending order.

### 6.3 Validation at fill (authoritative)

Re-checked during advance step 3 with fill price `P = open₍k+1₎`:

- `BUY`: `quantity × P ≤ cash`. If not, the **whole order is rejected** — no partial fill. Message: "Order rejected: the price opened at $X. This order would cost $Y, but you have $Z."
- `SELL`: `quantity ≤ shares held` (always true in Milestone 1, but checked defensively).

Rejected orders do not appear in trade history; they appear as a notice.

### 6.4 Replacing a pending order

If a valid order is submitted while another is pending, the new order replaces the old one and the player sees a notice, e.g. "Previous order (BUY 5) replaced by BUY 8." Cancelling shows "Order cancelled."

### 6.5 Helper: "Max" button (optional UI)

Fills the quantity box with `floor(cash / closeₖ)` for buys, or shares held for sells. Because buys fill at the next open, a max buy can still be rejected if the price gaps up. This is expected and a good teaching moment.

### 6.6 Showing a pending order's effect on cash (display only)

Cash changes only when an order fills (§4.4). So that the balance does not look unchanged after a buy is placed, the view also reports three display-only numbers:

- `pendingEstimate` = pending quantity × closeₖ (0 when nothing is pending);
- `availableCash` = `cash − pendingEstimate` while a **BUY** is pending, otherwise `cash` (a pending SELL adds nothing until it fills);
- `maxBuyCost` = `maxBuyQuantity × closeₖ`.

These never change the account or any rule above. In particular, a replacement order is still checked against **all** cash (§6.4), so nothing is ever deducted twice. A refused buy tells the player how many shares they can afford (or that they cannot afford even one).

---

## 7. Account accounting

### 7.1 Account state

| Field | Type | Start |
|-------|------|-------|
| `cash` | cents | 100000 |
| `shares` | integer | 0 |
| `costBasis` | cents — total cost of the shares currently held | 0 |
| `realizedPnl` | cents — running total | 0 |
| `trades` | list | empty |

Average entry price is **not stored**; it is derived (§7.4).

### 7.2 Buy fill (quantity q at price P)

- `cost = q × P`
- `cash -= cost`
- `shares += q`
- `costBasis += cost`

### 7.3 Sell fill (quantity q at price P, with q ≤ shares)

- `proceeds = q × P`
- `removedBasis = roundHalfUp(costBasis × q / shares)` (integer formula from §3.4, using values **before** this sell)
- `tradePnl = proceeds − removedBasis`
- `cash += proceeds`
- `shares -= q`
- `costBasis -= removedBasis`
- `realizedPnl += tradePnl`

When q = shares (full close), `removedBasis = costBasis` exactly, so costBasis returns to 0 with no leftover cents.

### 7.4 Derived values

- **Average entry price** (display only): `roundHalfUp(costBasis / shares)` cents; "—" when shares = 0.
- **Position value**: `shares × markPrice`
- **Unrealized P&L**: `shares × markPrice − costBasis`
- **Equity**: `cash + shares × markPrice`
- **Total return**: `equity − START_CASH`; percentage `(equity − START_CASH) / START_CASH × 100` (display only).

### 7.5 Invariants (must always hold)

1. `cash ≥ 0`, `shares ≥ 0`, `costBasis ≥ 0`, all integers.
2. `shares = 0` ⇔ `costBasis = 0`.
3. **`equity = START_CASH + realizedPnl + unrealizedPnl`**, exactly, to the cent.
4. `cash = START_CASH − Σ(buy costs) + Σ(sell proceeds)`.
5. Shares held = Σ(bought) − Σ(sold).
6. Every player trade has `candleIndex` between 11 and 70 and `price = open₍candleIndex₎`; a liquidation trade has `candleIndex = 70` and `price = close₇₀`.

### 7.6 Trade record

Each fill appends one record:

`id` (1, 2, 3…), `type` (`player` | `liquidation`), `side`, `candleIndex` (global index 11–70), `quantity`, `price`, `amount` (cost or proceeds), `tradePnl` (sells only), `cashAfter`, `sharesAfter`. The UI shows the round number (`candleIndex − 10`).

### 7.7 Worked example

Start: cash 100000, k = 10.

| Step | Fill | Cash | Shares | Cost basis | Realized | Notes |
|------|------|------|--------|-----------|----------|-------|
| 1 | BUY 10 @ 2500 (open₁₁, round 1) | 75000 | 10 | 25000 | 0 | submitted while viewing candle 10 |
| 2 | BUY 5 @ 2600 (open₁₂) | 62000 | 15 | 38000 | 0 | avg shown $25.33 |
| — | mark close₁₂ = 2700 | | | | | unrealized = 40500 − 38000 = 2500; equity 102500 ✓ |
| 3 | SELL 4 @ 2650 (open₁₃) | 72600 | 11 | 27867 | 467 | removed = roundHalfUp(38000×4/15 = 10133.33) = 10133 |
| — | mark close₁₃ = 2650 | | | | | unrealized = 29150 − 27867 = 1283; equity 101750 = 100000 + 467 + 1283 ✓ |
| 4 | SELL 11 @ 2400 (open₁₄) | 99000 | 0 | 0 | −1000 | removed 27867, tradePnl −1467 |

Final equity 99000 = 100000 − 1000 ✓.

---

## 8. Seeds

- A new round's seed is a random unsigned 32-bit integer from `crypto.getRandomValues` (the only real randomness; it is outside the engine).
- The seed is shown on the results screen (and may be shown in a small debug area) so a round can be replayed or a bug reported.
- Development builds may allow typing a seed manually.

---

## 9. Reset behaviour

- **New round**: new random seed; everything in §4.3 is reset; candles 1–10 shown, k = 10.
- **Replay this round**: same seed; everything reset; all 70 candles are identical to the previous attempt.
- Both are available while `PLAYING` (with a confirmation prompt) and after `FINISHED` (no prompt).
- Reset discards the pending order, trades and notices from the old round.
- **No persistence in Milestone 1**: refreshing the page loses the round.

---

## 10. Product rules for Milestone 1

- The stock and company are fictional and the UI shows a visible **SIMULATED** label.
- The fictional ticker must be checked against real tickers before use (e.g. NOVA has been used as a real NYSE ticker). Milestone 1 uses **Quellaris Energy (QLRX)**; a web search on 2026-10-14 found no real listing under QLRX. Recheck before any public launch.
- No fees, no shorting, no leverage, no limit/stop orders, no news.

---

## 11. Decisions log and open questions

### Resolved in v0.2
| Question | Decision |
|----------|----------|
| Unaffordable buy at fill | Reject the whole order with a clear message (D8). |
| Pending order replacement | One pending order; new submission replaces it with a notice (D9). |
| News in Milestone 1 | No; plain random walk (D10). |
| History before the round | 10 history candles, not tradable, not counted in the 60 (D6). |

### Still open
1. **Benchmark on the results screen:** show "buy-and-hold" (max affordable shares bought at open₁₁, held to close₇₀) for comparison? Cheap and educational; does not affect the engine.
2. **Tunable values:** the volatility numbers are guesses; expect to change them after the first playtests.

---

## 12. Market mode (engine v2) — ten stocks, one cash balance

Added in Stage 2a. Everything in §3 (integer cents, rounding), §5.1–5.2 (RNG, normal-ish numbers), §6.2 rule 2 (quantity text), §7.2–7.3 (buy/sell arithmetic) and §9 (new round / replay) applies unchanged. This section lists only what market mode adds or changes.

### 12.1 Decisions

| # | Decision |
|---|----------|
| M1 | **Ten fictional stocks** (§12.2). Every stock has the same 70-candle timeline as §4: 10 history candles, then 60 playable. All ten advance together on **Next candle**. |
| M2 | **One shared cash balance**, starting at **$10,000.00** (`MARKET_START_CASH = 1_000_000` cents). The v1 $1,000 start cannot buy a useful number of shares of stocks priced $8–$150. |
| M3 | Each stock has **its own independent random stream** (§12.3), so one stock's candles never depend on another stock's. A stock's candles depend only on the round seed and its position in the §12.2 table (moving a stock in the table changes its candles). |
| M4 | **At most one pending order per stock** (D9 applied per stock). A new order for the same stock replaces it; orders for different stocks coexist. |
| M5 | Pending buys **never deduct cash**. They only *set aside* an estimate (§12.5) so the same dollars cannot be promised to several orders. |
| M6 | Orders fill at the **next candle's open** of their own stock (D5). At a fill, **sells run before buys**, each group in placement order (§12.6). |
| M7 | A buy that does not fit the cash at its fill price is **rejected entirely** (D8). |
| M8 | **Finish round** sells every position at **that stock's candle-70 close** (D7). |
| M9 | Long only, whole shares, no fees, no leverage, no news (D3, D10 still hold). News, chart playback and drawing tools are later stages. |

### 12.2 The ten stocks

Prices in cents. Every stock has drift 0. `start` is the range of its first open (uniform, inclusive).

| Ticker | Company (fictional) | Sector | start | bodySigma | gapSigma | maxMove | maxGap | wickMax |
|--------|---------------------|--------|-------|-----------|----------|---------|--------|---------|
| QLRX | Quellaris Energy | Energy | 2000–5000 | 0.015 | 0.002 | 0.10 | 0.02 | 0.010 |
| NVRA | Novera Systems | Software | 6000–12000 | 0.022 | 0.004 | 0.12 | 0.03 | 0.012 |
| BRLF | Brookleaf Foods | Consumer staples | 800–1500 | 0.006 | 0.001 | 0.05 | 0.01 | 0.006 |
| HLQN | Helioquin Biotech | Biotech | 1200–4000 | 0.035 | 0.010 | 0.15 | 0.04 | 0.020 |
| MRDL | Mardell Rail & Freight | Industrials | 3500–7000 | 0.010 | 0.002 | 0.07 | 0.015 | 0.008 |
| ZYRA | Zyra Airways | Airlines | 1500–3500 | 0.020 | 0.005 | 0.12 | 0.03 | 0.012 |
| TVLM | Tavelum Metals | Materials | 2500–5500 | 0.017 | 0.003 | 0.10 | 0.025 | 0.010 |
| SKVR | Skyvere Aerospace | Aerospace & defense | 8000–15000 | 0.013 | 0.003 | 0.08 | 0.02 | 0.009 |
| PLNB | Pellmont Bancorp | Financials | 4500–9500 | 0.009 | 0.002 | 0.06 | 0.015 | 0.007 |
| VRDW | Verdane Water Utilities | Utilities | 1800–3200 | 0.004 | 0.0008 | 0.03 | 0.008 | 0.005 |

QLRX keeps exactly the v1 parameters. The others are tuned so that utilities and food barely move and biotech swings widely; the numbers are guesses to be tuned after playtests (change them only with a `MARKET_ENGINE_VERSION` bump).

**Ticker check.** The tickers are invented, and some natural-looking ones turned out to be real listings (HLXB, ZPHR, TLMR, SKFG and PLMT were dropped for that reason). Web searches on 2026-10-15 for each of the nine new tickers returned no listing under that exact symbol (only near-misses such as ZYXI, SKRV or KBRLF); QLRX was searched on 2026-10-14. A web search cannot prove a symbol is unused — recheck against an official symbol directory before any public launch.

### 12.3 Candle generation per stock

For the stock at position `i` (0–9) in the table of §12.2, the stream seed is `deriveSeed(roundSeed, i)`:

```
h = (seed + imul(i + 1, 0x9e3779b1)) | 0
h ^= h >>> 16;  h = imul(h, 0x85ebca6b)
h ^= h >>> 13;  h = imul(h, 0xc2b2ae35)
h ^= h >>> 16
return h >>> 0
```

Each stock then runs the exact draw order and formulas of §5.3–5.4 on `Mulberry32(streamSeed)` using its own row of §12.2 instead of the v1 constants. A stock's stream uses exactly **1821 draws**, like v1. `deriveSeed` (with `Math.imul` and bit operators) lives in `rng.ts` only; the static test still forbids them elsewhere in the engine.

### 12.4 State and timeline

Same as §4 and §4.7, with one `k` for the whole market. The market state holds one portfolio (cash plus ten positions), at most one pending order per stock, a trade list and notices. The UI sees only `getMarketView(state)`, which contains candles 1..k of every stock and nothing later.

### 12.5 Portfolio, estimates and set-aside cash

- A **position** is `{ shares, costBasis, realizedPnl }` per stock; cash is shared. Buys and sells use §7.2–7.3 for the stock concerned.
- `mark(stock) = close of candle k`. Equity = cash + Σ shares × mark. Realized and unrealized P&L are sums over the ten stocks. Equity − start cash = realized + unrealized.
- `reserved(except)` = Σ over pending **buys** of other stocks of `quantity × mark`. Pending sells reserve nothing and add nothing.
- `buyingPower(stock) = max(0, cash − reserved(except stock))` and `maxBuy(stock) = floor(buyingPower / mark)`. The view and the submit check use the same function, so **the maximum shown is always accepted and one more is always refused**.
- Reserved cash is for display and validation only. **Cash changes only when an order fills.** Because every pending order is cleared at each advance and marks only change at an advance, `reserved ≤ cash` always holds.

### 12.6 Orders

**Submit** `(ticker, side, quantityText)`, in this order of checks; the first failing check adds an error notice and changes nothing else:
1. Not `PLAYING`: no change at all (§4.7). `k = 70`: refused ("No next candle").
2. Unknown ticker (case-sensitive).
3. Quantity text per §6.2 rule 2 and the maximum order size.
4. SELL: the stock must be held ("You don't hold any shares of T.") and `quantity ≤ shares`.
5. BUY: `quantity × mark ≤ buyingPower(stock)`. The message names the cash available, how much is set aside for other pending buys, and how many shares can be afforded.

On success the stock's pending order is replaced (with a notice naming the old order) or created, and gets the next placement number `seq` (a replaced order moves to the back of the queue).

**Cancel** `(ticker)`: removes that stock's pending order; if there is none, the state is returned unchanged.

**Advance** (from k to k+1, the market is shown candle k+1): pending orders are filled at the **open of candle k+1 of their own stock**, **all sells first, then all buys, each in `seq` order**:
- a SELL fills (it was validated against the shares held, and shares cannot shrink in between);
- a BUY fills if `quantity × open ≤ cash` *at that moment* (so sale proceeds from this same advance count); otherwise it is rejected entirely with an error notice, nothing is spent, and the other orders still fill.
Then all pending orders are cleared and `k` becomes `k + 1`.

**Finish** (only when `k = 70` and `PLAYING`): for each stock in table order with shares > 0, sell all of them at that stock's candle-70 close (trade type `liquidation`), then set `FINISHED`. Anything else returns the state unchanged.

### 12.7 What the UI may see

`getMarketView` returns, per stock: candles 1..k, mark, previous close and change, position (shares, cost basis, average entry, value, unrealized and realized P&L), pending order, `maxBuyQuantity`, `maxSellQuantity`; plus account totals (cash, `reservedForPendingBuys`, `availableCash`, holdings value, P&L, equity, total return), all pending orders, trades and notices. `getMarketResults` is `null` until `FINISHED`, then gives final equity, total return, realized P&L, the player's trade count (liquidations excluded) and a per-stock breakdown.

### 12.8 Trade record

`{ id, type: player | liquidation, ticker, side, candleIndex (11–70), quantity, price, amount, tradePnl (sells only, else null), cashAfter (the one shared balance), sharesAfter (of that stock) }`.

### 12.9 Invariants (property-tested after every action of random play)

1. Cash and every share count are safe integers; none is negative; a stock with zero shares has zero cost basis.
2. Ledger: `cash = start − Σ buys + Σ sells`, and for each stock `shares = Σ bought − Σ sold`.
3. Equity = cash + holdings value; equity − start = realized + unrealized.
4. At most one pending order per stock; `seq` strictly increases in list order; nothing is pending after `FINISHED`.
5. `reserved ≤ cash`; `availableCash = cash − reserved ≥ 0`.
6. Submit and cancel never change cash, positions, trades or `k`; a refused order changes nothing but the notices.
7. Every player trade is at the open of its candle, every liquidation at the candle-70 close.
8. The view never exposes a candle after `k` for any stock.
9. `maxBuyQuantity` is accepted and `maxBuyQuantity + 1` is refused.

### 12.10 Versioning and the independent reference

`MARKET_ENGINE_VERSION = 2`. A market round is identified by `(MARKET_ENGINE_VERSION, seed)`. Any change to the stock table, `deriveSeed`, draw order, start cash, or the order and fill rules changes results and must bump it. The v1 `ENGINE_VERSION` stays 1 because v1 candles are unchanged (the golden fixture `reference-v1.json` still passes).

As in §5.6, golden values come from an independent implementation: `tools/reference_market.py` (Python, written from this section) generates the ten stocks' candles for three seeds and eight randomised trading sessions of 1000 actions each (orders, cancels, advances, finishes, replays, invalid inputs), recording the exact final state and trade list. `tests/market-reference.test.ts` replays the same actions through the TypeScript engine and requires identical results. Regenerate `tests/fixtures/reference-market-v2.json` only together with a `MARKET_ENGINE_VERSION` bump; a mismatch means one side has a bug.

### 12.11 Open points (defaults chosen in Stage 2a)

| Question | Default |
|----------|---------|
| Start cash | $10,000.00. Easy to change (`MARKET_START_CASH`) with a version bump. |
| Several pending orders at once | One per stock (M4). A single global pending order would make multi-stock play slow. |
| Fill order between orders | Sells first, then buys, in placement order (M6). |
| Gap-up on a "Max" buy | Still rejected at the fill (M7); a buffer or partial fill is a possible later change. |

## 13. Live market mode (engine v3) — ticks, 10-tick candles, instant trades

Added in Stage 2 of the master prompt. Everything in §3 (integer cents, rounding), §5.1–5.2 (RNG, normal-ish numbers), §6.2 rule 2 (quantity text), §7.2–7.3 (buy/sell arithmetic) and §12.2–12.3 (the ten stocks, per-stock streams) applies unchanged. This section lists what live mode adds. The turn-based market of §12 is kept as the "Classic rounds" mode and is not changed.

### 13.1 Decisions

| # | Decision |
|---|----------|
| L1 | The market advances by **ticks**. One tick moves all ten prices once. Nothing else moves a price. |
| L2 | A candlestick is **exactly 10 ticks** (`TICKS_PER_CANDLE = 10`). |
| L3 | Start cash is **$1,000.00** (`LIVE_START_CASH = 100_000`), as the product spec says. At the §12.2 price levels this buys only 6–12 shares of SKVR; the price ranges are tunable (needs a `LIVE_ENGINE_VERSION` bump). |
| L4 | Orders **fill immediately at the current tick's price**. There are no pending orders and no set-aside cash. The "Max" amount is exactly the largest quantity the engine accepts. |
| L5 | A price depends only on `(seed, stock, tick)`. Playing, pausing, stepping, skipping, the speed and the order in which prices are looked at cannot change any price. |
| L6 | A session starts at **tick 100**: 10 finished candles of history are already on the chart (context only, nothing can be traded in the past). |
| L7 | A session is open-ended unless a `durationTicks` is given. A timed session becomes `ENDED` when the current tick reaches `endTick`; trading is then closed. (A 3-minute match at 1 tick per second is 180 ticks = 18 candles, used in Stage 5.) |
| L8 | There is **no forced sale** at the end. Final net worth = cash + shares × the price at the final tick. |
| L9 | Playback is **outside the engine** (§13.9). The engine has no clock. |
| L10 | No news yet (Stage 3), so the walk has no built-in direction (drift 0). No trading strategy has an edge by design; see §13.11. |

### 13.2 Tick prices

Per stock, with stream seed `s = deriveSeed(seed, position in the §12.2 table)`. Draws are numbered from 1; draw `k` is the k-th number `Mulberry32(s)` would return (`uniformAt(s, k)`; Mulberry32's state after `k` draws is `s + k·0x6D2B79F5 mod 2³²`, so any draw can be computed directly).

1. **Tick 0 price:** `p0 = startMin + floor(draw1 × (startMax − startMin + 1))`.
2. **Tick n ≥ 1** uses draws `2+12(n−1) … 13+12(n−1)` (twelve draws):
   - `z = (sum of the twelve draws) − 6`
   - `σ = bodySigma × 0.31622776601683794` (≈ 1/√10, so ten ticks together move about as much as one old candle body; written as a constant because the engine may not call a square-root function)
   - `limit = maxMove × 0.5`
   - `move = clamp(drift + σ × z, −limit, +limit)`
   - `p_n = max(100, roundHalfUp(p_{n−1} × (1 + move)))`

   Evaluate exactly in this order with 64-bit floating point: `σ` first, then `σ × z`, then add the drift. `gapSigma`, `maxGap` and `wickMax` are not used in live mode (gaps and wicks come out of the ticks).

### 13.3 Candles

Candle `n` (n ≥ 1) covers ticks `10(n−1)+1 … 10n`.

- **Open** = `p_{10(n−1)}` — the price at the moment the candle begins (candle 1 opens at `p0`; every later candle opens at the previous candle's final close).
- At current tick `t` the candle has `ticks = clamp(t − 10(n−1), 0, 10)` ticks. **High** = highest price among `p_{10(n−1)} … p_{10(n−1)+ticks}`, **low** = lowest of the same, **close** = `p_{10(n−1)+ticks}`.
- A candle is **complete** exactly when `ticks = 10`, and never changes afterwards.
- At tick `t` candles `1 … floor(t/10)` are complete and candle `floor(t/10)+1` is **forming** with `t mod 10` ticks. Right after a candle's 10th tick the next candle exists at once with 0 ticks (open = high = low = close).
- **Colour:** close > open → up (green); close < open → down (red); equal → flat (neutral).

### 13.4 Time

- `advance(count)` moves the current tick forward by `count` (whole number ≥ 1); a timed session stops at `endTick` and becomes `ENDED`; an ended session does not move.
- `skip` = advance to the end of the forming candle: `10 − (t mod 10)` ticks, so a whole new candle (10 ticks) when one has just begun.
- `reset` = same seed, same options: tick 100, all cash, no shares, no trades. The prices are identical.

### 13.5 Trading

Checks in this order; a refused order changes nothing except adding an error notice.

1. Session `ENDED` → refused ("trading is closed").
2. Unknown ticker → refused.
3. Quantity text must pass §6.2 rule 2.
4. **Sell:** needs at least one share, and the quantity ≤ shares held.
5. **Buy:** `quantity × price ≤ cash`.

`price` is the stock's price at the **current tick**, the same number the view shows at that moment. The fill uses §7.2–7.3 and records a trade: id, ticker, side, tick, forming candle number, quantity, price, amount, trade P&L (sells), cash after, shares after.

### 13.6 Net worth

`equity = cash + Σ shares × current price`; `totalReturn = equity − startCash`; `equity − startCash = realized P&L + unrealized P&L` always.

### 13.7 What the UI may see

Only `getLiveView(state)`: for every stock the candles up to the current tick (finished ones plus the forming one) and the current price. No later tick, candle or price is reachable from the view.

### 13.8 Invariants (property-tested after every action of random play)

Cash and shares are whole, non-negative numbers; the trade list explains cash and shares exactly; equity identities hold; every trade's price equals the price at its recorded tick; trades never happen after the end; the current tick only ever rises by exactly the requested amount; refused orders change nothing but the notices; `Max` buy is accepted and `Max + 1` refused; the view reveals nothing after the current tick.

### 13.9 Playback (in the app, not the engine)

- States: paused (the app starts paused) or playing, and a speed of 1×, 2× or 4×. At 1× the app asks the engine for one tick per second; 2× every 500 ms; 4× every 250 ms.
- **Pause** stops the timer; no tick happens while paused. **Step** advances exactly one tick and **Skip** runs to the end of the forming candle; both are available only while paused.
- Changing speed restarts the timer at the new interval and cannot change which prices come next.
- Browsers slow timers in background tabs, and the market only advances while the page is open and playing. There is no catch-up for time away (Career mode, Stage 4, keeps the account, not the clock).

### 13.10 Versioning and the independent reference

`LIVE_ENGINE_VERSION = 3`. Changing the table, the formulas, the draw order, the tick size or the start cash changes the prices for a seed and needs a version bump and a regenerated fixture. `tools/reference_live.py` is a separate Python implementation of §13.2–13.5 written from this section. It draws numbers one after another (no direct access formula), so it checks the engine's `uniformAt` shortcut independently. It writes `tests/fixtures/reference-live-v3.json`.

### 13.11 Open points and known limits

- **Fairness / skill:** with drift 0 and no news, the future price is unrelated to the past, so no strategy has an expected edge. In a 1v1 match the winner would then be decided by luck and risk-taking alone. Stage 3 (news that is announced *before* its price effect plays out) is what lets a player react skilfully.
- Volatility per tick, the 10-tick candle and the $1,000 start are untested guesses to tune after playtests.
- Tickers: still invented and web-checked once (§12.2).
