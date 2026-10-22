# TradeQuest — Milestone 1 Test Cases (`docs/test-cases.md`)

Status: **v0.3** — companion to `docs/rules.md` v0.3. Section references (§) point to rules.md.

Types: **U** = automated unit test, **P** = automated property test (many random seeds/action sequences), **M** = manual UI check.

All money values are in cents unless shown with "$". Candle indices are **global** (1–10 history, 11–70 playable) unless marked "round".

### General rules for the test suite

- **Independent expected values.** Golden values (RNG-05, ENG-04, HIST-01's snapshot check) come from `tools/reference_engine.py`, a separate Python implementation written from the spec, and are stored in `tests/fixtures/`. Hand-computed cases (ENG-13, ENG-14, HIST-01) are worked out from the formulas and written into the test as literal numbers. **No expected value is ever produced by the TypeScript code under test.**
- **Reproducible property tests.** Every P test runs from a fixed base seed. When a case fails, the error message must include the market seed and the full action sequence (as JSON) so the failure can be replayed exactly with `replayActions(seed, actions)`.
- If a test exposes a bug, fix the code — do not weaken the test.

### Changes since v0.2
RNG-05, ENG-04 and the property-test reporting rules clarified (above). FLOW-02 strengthened. PNL-09 and R-09 now follow the negative-display rule of rules.md §3.4. Added PNL-12, ORD-21, PROP-01.

### Changes since v0.1
History candles added: candle counts (70), draw counts (1821), start index (k = 10), first fill (open₁₁), last index (70) and liquidation (close₇₀) updated. New tests: HIST-01 to HIST-07, FLOW-16 to FLOW-19, ORD-18 to ORD-20.

---

## 1. Rounding helper (§3)

| ID | Type | Case | Expected |
|----|------|------|----------|
| R-01 | U | `roundHalfUp(7, 2)` (3.5) | 4 |
| R-02 | U | `roundHalfUp(5, 2)` (2.5) | 3 |
| R-03 | U | `roundHalfUp(10, 3)` (3.33) | 3 |
| R-04 | U | `roundHalfUp(20, 3)` (6.67) | 7 |
| R-05 | U | `roundHalfUp(0, 5)` | 0 |
| R-06 | U | `roundHalfUp(380000, 15)` (25333.33) | 25333 |
| R-07 | U | Exact division `roundHalfUp(38000, 1)` | 38000 |
| R-08 | U | Large values near the documented maximum stay exact (compare against a BigInt calculation) | Equal |
| R-09 | U | Dollar formatting: 253336 → "$2,533.36"; 5 → "$0.05"; 0 → "$0.00"; −1467 → "−$14.67" | As stated |

## 2. Seeded RNG (§5.1–5.2)

| ID | Type | Case | Expected |
|----|------|------|----------|
| RNG-01 | U | Same seed, two generators, first 10,000 outputs | Identical |
| RNG-02 | U | Every output satisfies 0 ≤ u < 1 (10,000 outputs, several seeds) | True |
| RNG-03 | U | Seeds 1 and 2 | Sequences differ |
| RNG-04 | U | Seeds 0 and 4294967295 (edge values) | Work, no NaN |
| RNG-05 | U | First 5 outputs for seed 12345, and outputs for seeds 0 and 4294967295 | Equal to the values produced by `tools/reference_engine.py` (independent implementation), stored as literals in the fixture; never regenerated unless ENGINE_VERSION bumps |
| RNG-06 | U | Mean of 100,000 outputs | ≈ 0.5 (within 0.01) |
| RNG-07 | U | `z` helper uses exactly 12 draws and returns values in [−6, 6] | True |
| RNG-08 | U | Mean ≈ 0 and std. dev. ≈ 1 for 100,000 `z` values | Within 0.02 |

## 3. Candle generation (§5.3–5.6)

| ID | Type | Case | Expected |
|----|------|------|----------|
| ENG-01 | U | Generate a round | Exactly 70 candles, indexed 1..70 |
| ENG-02 | U | Same seed twice | Identical 70 candles (deep equality) |
| ENG-03 | U | Different seeds | Different candles |
| ENG-04 | U | Golden snapshot: seeds 12345, 1 and 4294967295, ENGINE_VERSION 1 | All 70 candles equal the snapshot produced by `tools/reference_engine.py` (independent implementation) |
| ENG-05 | U | Draw count for one round | Exactly 1821 RNG draws |
| ENG-06 | P | 1,000 random seeds: open₁ | Integer in [2000, 5000] |
| ENG-07 | P | 1,000 seeds, every candle (history and playable) | All four values are integers ≥ 100 |
| ENG-08 | P | Every candle | `low ≤ min(open, close)` and `high ≥ max(open, close)` |
| ENG-09 | P | Every candle | Open→close return within ±10% (allowing ±1 cent rounding, and floor at MIN_PRICE) |
| ENG-10 | P | Every candle i ≥ 2 (including the gap into candle 11) | Gap from closeᵢ₋₁ to openᵢ within ±2% (allowing ±1 cent rounding and floor) |
| ENG-11 | U | Force extreme negative draws (stubbed RNG returning near-0 values) | Prices floor at 100, never below; low ≥ 100 |
| ENG-12 | U | Force extreme positive draws | Moves capped at +10% / +2%; no crash, integers |
| ENG-13 | U | Stubbed RNG with known values → hand-computed candles 1 and 2 | Exact match (verifies formulas and draw order) |
| ENG-14 | U | Candle 1 consumes its gap draw even though unused | Candle 2 matches hand-computed value from draws 28–53 |
| ENG-15 | U | Engine source does not call `Math.random`, `Date.now`, `Math.exp/log/sin/cos/pow` | Static check / lint rule passes |

## 4. History candles (§4.1, §4.3, §5.3)

| ID | Type | Case | Expected |
|----|------|------|----------|
| HIST-01 | U | History and playable candles use the same generator | Candle 11 matches hand-computed value from draws 262–287 using close₁₀ |
| HIST-02 | U | Generator has no history/playable branch | Generating 70 candles equals generating candles 1–10 then continuing 11–70 from the same RNG state |
| HIST-03 | U | At round start | Candles 1–10 visible; k = 10; mark price = close₁₀ |
| HIST-04 | U | Classifier: indices 1–10 | `isHistory = true`, not tradable |
| HIST-05 | U | Classifier: indices 11–70 | Playable; round number = index − 10 (11 → 1, 70 → 60) |
| HIST-06 | P | Across many seeds and random action sequences | No trade ever has candleIndex ≤ 10 |
| HIST-07 | M | Chart at round start | History candles visually distinct; "Round starts next candle" shown |

## 5. Round flow and timing (§4)

| ID | Type | Case | Expected |
|----|------|------|----------|
| FLOW-01 | U | New round | k = 10, state PLAYING, cash 100000, shares 0, no trades, no pending order |
| FLOW-02 | U | UI-facing data never contains future candles. At start and after every advance, deep-scan the whole object returned by `getView(state)` (the only thing React components receive) | No candle object with index > k; none of the future candle objects appears anywhere in the view (checked by identity); the candle list has exactly k entries; the view has no field holding the full 70-candle list |
| FLOW-03 | U | Advance once with no order | k = 11 (round 1); account unchanged except marks |
| FLOW-04 | U | Advance 60 times | k = 70 (round 60) |
| FLOW-05 | U | Advance at k = 70 | Not allowed; state unchanged |
| FLOW-06 | U | Submit BUY at k = 10, advance | Fills at open₁₁; trade.candleIndex = 11 |
| FLOW-07 | U | Submit at any k in 10–69, advance | Fill price = open₍k+1₎ (test with a seed where open₍k+1₎ ≠ closeₖ) |
| FLOW-08 | U | Order filled **before** candle k+1's close is used for marks | After advance: trade price = open₍k+1₎ and mark = close₍k+1₎ |
| FLOW-09 | U | Submit at k = 69, advance | Fills at open₇₀ |
| FLOW-10 | U | Submit at k = 70 | Rejected: "no next candle"; no pending order |
| FLOW-11 | U | Pending order after any advance | Always cleared (filled or rejected) |
| FLOW-12 | U | Submit, cancel, advance | No fill; account unchanged; "Order cancelled" notice |
| FLOW-13 | U | Submit BUY 5, then BUY 8, advance | Only BUY 8 fills |
| FLOW-14 | U | At most one player fill per advance | True; at most 60 player trades per round |
| FLOW-15 | U | Mark price equals closeₖ | True at start (close₁₀) and after every advance |
| FLOW-16 | U | Exactly 60 advances are possible per round | 61st advance rejected |
| FLOW-17 | U | Round counter | Shows "Candle r of 60" with r = k − 10 for k ≥ 11 |
| FLOW-18 | M | UI at k = 70 | Buy/Sell/Next disabled; only Finish round enabled |
| FLOW-19 | M | UI at k = 10 | Order entry enabled; Next reveals round candle 1 |

## 6. Order validation (§6)

| ID | Type | Case | Expected |
|----|------|------|----------|
| ORD-01 | U | Quantity "0" | Rejected at submission |
| ORD-02 | U | Quantity "−3" | Rejected |
| ORD-03 | U | Quantity "1.5" | Rejected |
| ORD-04 | U | Quantity "" / " " / "abc" / "1e3" / "+5" / " 5" | All rejected |
| ORD-05 | U | Quantity "1000001" (above MAX_ORDER_QTY) | Rejected |
| ORD-06 | U | BUY 1 with enough cash | Accepted as pending |
| ORD-07 | U | SELL with 0 shares held | Rejected at submission |
| ORD-08 | U | SELL quantity > shares held | Rejected at submission |
| ORD-09 | U | SELL quantity = shares held | Accepted |
| ORD-10 | U | BUY where `qty × closeₖ > cash` | Rejected at submission (estimate check) |
| ORD-11 | U | BUY where `qty × closeₖ = cash` exactly | Accepted at submission |
| ORD-12 | U | BUY accepted, but `qty × open₍k+1₎ > cash` at fill (gap up) | Whole order rejected; account unchanged; notice with $X/$Y/$Z; no trade record |
| ORD-13 | U | BUY where `qty × open₍k+1₎ = cash` exactly | Fills; cash becomes 0 |
| ORD-14 | U | BUY where the price gapped **down** | Fills at the lower open; cost uses open, not the estimate |
| ORD-15 | U | Rejected order | Not in trade history; shown as a notice |
| ORD-16 | U | Submit while FINISHED | Rejected |
| ORD-17 | U | "Max" buy helper | Sets `floor(cash / closeₖ)`; 0 when cash < closeₖ |
| ORD-18 | U | First order at k = 10 uses close₁₀ for the estimate | Estimate = qty × close₁₀ |
| ORD-19 | U | Replace pending order | Notice "Previous order (BUY 5) replaced by BUY 8" |
| ORD-20 | U | Invalid submission while an order is pending | Rejected; the existing pending order is kept |
| ORD-21 | U | Quantity "05" (leading zero) | Rejected (rules.md §6.2) |

## 7. Cash, shares and cost basis (§7.2–7.3)

| ID | Type | Case | Expected |
|----|------|------|----------|
| ACC-01 | U | BUY 10 @ 2500 | cash 75000, shares 10, costBasis 25000 |
| ACC-02 | U | Then BUY 5 @ 2600 | cash 62000, shares 15, costBasis 38000 |
| ACC-03 | U | Then SELL 4 @ 2650 | proceeds 10600, removedBasis 10133, tradePnl 467, cash 72600, shares 11, costBasis 27867, realized 467 |
| ACC-04 | U | Then SELL 11 @ 2400 | removedBasis 27867, tradePnl −1467, cash 99000, shares 0, costBasis 0, realized −1000 |
| ACC-05 | U | Half-cent case: costBasis 1001, shares 2, SELL 1 | removedBasis 501 (500.5 rounds up), costBasis 500 |
| ACC-06 | U | Continue ACC-05: SELL 1 | removedBasis 500, costBasis 0 — total removed 1001, no leftover |
| ACC-07 | U | Full close always zeroes costBasis exactly | True for many random positions |
| ACC-08 | U | Buy then sell at the same price | tradePnl 0; cash back to start |
| ACC-09 | U | Sell at a loss | tradePnl negative; realized decreases |
| ACC-10 | U | Buy 7 @ 3333, sell 1 seven times | Σ removedBasis = 23331 exactly; costBasis ends at 0 |
| ACC-11 | U | Trade record fields | id sequential from 1; type, side, candleIndex (11–70), qty, price, amount, tradePnl (sell only), cashAfter, sharesAfter all correct |
| ACC-12 | U | Spend all cash, then try BUY 1 | Rejected; cash stays 0 |

## 8. P&L, average entry and equity (§7.4)

| ID | Type | Case | Expected |
|----|------|------|----------|
| PNL-01 | U | No position | unrealized 0; average entry "—"; equity = cash |
| PNL-02 | U | 15 shares, costBasis 38000, mark 2700 | unrealized 2500; position value 40500 |
| PNL-03 | U | Average entry display, 38000 / 15 | 2533 → "$25.33" |
| PNL-04 | U | Average entry after partial sell, 27867 / 11 | 2533 → "$25.33" |
| PNL-05 | U | Average entry never used in calculations | Changing display rounding changes no account value |
| PNL-06 | U | Equity at start (k = 10) | 100000; return $0.00 / 0.00% |
| PNL-07 | U | Equity after worked example step 3, mark 2650 | 101750 |
| PNL-08 | U | Return % for equity 101750 | "1.75%" |
| PNL-09 | U | Return % for equity 99000 | "−1.00%" |
| PNL-10 | U | Unrealized P&L on advance with no trade | Changes only via mark price |
| PNL-11 | U | Mark price at the MIN_PRICE floor | Values remain valid integers ≥ 0 |
| PNL-12 | U | Negative display rounding: return −5 cents on 100000 (−0.005%) and +5 cents (+0.005%) | "−0.01%" and "0.01%"; −4 cents shows "0.00%" (no sign) |

## 9. End of round (§4.5–4.6)

| ID | Type | Case | Expected |
|----|------|------|----------|
| END-01 | U | Finish with shares > 0 | One `liquidation` trade: SELL all at close₇₀; shares 0; costBasis 0 |
| END-02 | U | Finish with shares = 0 | No liquidation trade |
| END-03 | U | Equity immediately before vs after liquidation | Identical |
| END-04 | U | After liquidation | unrealized 0; equity = cash = START_CASH + realized |
| END-05 | U | Finish twice | Second call changes nothing |
| END-06 | U | Finish when k < 70 | Not allowed |
| END-07 | U | After FINISHED: submit, cancel, advance | All rejected; state unchanged |
| END-08 | U | Results data | seed, final equity, return $ and %, realized P&L, player trade count (excludes liquidation), full history |
| END-09 | U | Liquidation trade record | type `liquidation`, candleIndex 70, price close₇₀ |

## 10. Reset and replay (§8–9)

| ID | Type | Case | Expected |
|----|------|------|----------|
| RST-01 | U | New round after trading | Account back to start; k = 10; no trades, pending order or notices |
| RST-02 | U | New round | Uses a new seed (stubbed seed source) |
| RST-03 | U | Replay this round | Same seed; all 70 candles identical to the previous attempt |
| RST-04 | U | Replay with different trades | Candles still identical |
| RST-05 | U | Reset with a pending order | Pending order discarded |
| RST-06 | U | Reset from FINISHED | State PLAYING, k = 10 |
| RST-07 | M | Reset while PLAYING | Confirmation prompt; cancelling keeps the round |
| RST-08 | M | Reset after FINISHED | No prompt |
| RST-09 | U | Seed source for new rounds | `crypto.getRandomValues`, outside the engine |

## 11. Determinism and fairness (§5.5)

| ID | Type | Case | Expected |
|----|------|------|----------|
| DET-01 | P | 200 seeds: candles with no trades vs with a random action sequence | Identical |
| DET-02 | U | Timing between clicks | Does not affect candles or fills |
| DET-03 | U | Two playthroughs with the same seed and same actions | Identical final account and trade history |
| DET-04 | U | ENGINE_VERSION | Recorded with the round; golden snapshot fails if formulas change without a bump |

## 12. Invariants (§7.5) — property tests

Run each for many random seeds × random sequences of valid **and** invalid actions (submit buy/sell with random quantities, cancel, replace, advance, finish, reset).

| ID | Type | Invariant (checked after every action) |
|----|------|------|
| INV-01 | P | `cash ≥ 0`, `shares ≥ 0`, `costBasis ≥ 0`, all safe integers |
| INV-02 | P | `shares = 0` ⇔ `costBasis = 0` |
| INV-03 | P | `equity = START_CASH + realizedPnl + unrealizedPnl` exactly |
| INV-04 | P | `cash = START_CASH − Σ buy costs + Σ sell proceeds` |
| INV-05 | P | `shares = Σ bought − Σ sold` |
| INV-06 | P | `realizedPnl = Σ tradePnl` over all sell records |
| INV-07 | P | Player trades: 11 ≤ candleIndex ≤ 70 and price = open₍candleIndex₎; liquidation: candleIndex 70, price close₇₀ |
| INV-08 | P | 10 ≤ k ≤ 70 at all times |
| INV-09 | P | Rejected actions leave the account exactly unchanged |
| PROP-01 | U | Force a property check to fail on purpose | Error message contains the market seed and the JSON action sequence, and `replayActions(seed, actions)` reproduces the same final state |

## 13. Manual UI checklist (Milestone 1)

| ID | Check |
|----|-------|
| UI-01 | SIMULATED label visible on the trading screen and results screen |
| UI-02 | Chart shows only candles 1..k; no future candle appears early |
| UI-03 | History candles look different from playable candles |
| UI-04 | Est. cost labelled as an estimate at the last close |
| UI-05 | Pending order clearly shown, with a Cancel button |
| UI-06 | Replacement, cancellation and rejection notices are clear |
| UI-07 | All money shows 2 decimals; negatives clearly marked |
| UI-08 | Layout usable at phone width (≈375px) and desktop |
| UI-09 | Results screen shows the seed |


## 14. Stage 1 regression tests (`tests/stage1-cash.test.ts`)

Bug A — "my balance does not decrease when I buy":

| ID | Check |
|----|-------|
| S1-A1 | A filled buy deducts exactly quantity × fill price; equity is unchanged at a flat price |
| S1-A2 | After placing a buy, `pendingEstimate` / `availableCash` show the money set aside; settled cash changes only at the fill |
| S1-A3 / A3b | A pending order is never deducted twice; a replacement is checked against all cash |
| S1-A4 | A filled sell adds proceeds at once and books realized P&L |
| S1-A5 | Average entry, unrealized/realized P&L and equity after buys at two prices |
| S1-A6 | Refused, cancelled and gap-rejected orders leave the account unchanged |
| S1-A7 | A pending sell reserves no cash and adds none until it fills |
| S1-A8 | Across whole rounds (several seeds, all-in/partial/sell/cancel mixes) the cash/share ledger balances after every step |
| S1-A9 | Several purchases at different prices share the one cash balance (Milestone 1 has a single instrument) |
| S1-A10 | Finish + replay: clean reset, and the same moves give identical money to the cent |

Bug B — "I can only buy around $20 worth":

| ID | Check |
|----|-------|
| S1-B1 / B3 | A 1-share order and a 50-share order (the whole $1,000) both fill |
| S1-B2 | For many prices, Max = `floor(cash / price)`, fills, and leaves less than one share's worth of cash |
| S1-B4 / B5 | A refused buy states the cost, the cash held, and the most the player can afford |
| S1-B6 | Max is recalculated from the cash left after a purchase |
| S1-B7 | Buys on different candles add up |
| S1-B8 | Two orders in the SAME candle replace each other (D9) and the player is told |
| S1-B9 / B10 | Max ignores a pending order (it would be replaced); a gap-down open fills for less |

Manual UI checks added:

| ID | Check |
|----|-------|
| UI-10 | After placing a buy, the Account panel shows "Set aside for pending buy" and a lower "Available cash"; Cash drops at the next candle |
| UI-11 | Typing more shares than affordable shows the reason under the box before clicking, and "You can buy up to N shares" is always visible |

---

## 15. Market mode — engine v2 (`tests/market-*.test.ts`)

Companion to rules.md §12. **U** = unit, **P** = property, **R** = differential against the independent Python reference (`tools/reference_market.py`).

| IDs | File | Type | What is checked |
|-----|------|------|-----------------|
| MKT-01 – MKT-05 | market-stocks | U | Exactly ten stocks; unique tickers/names; valid parameters; `stockByTicker`; the stocks differ in price level and volatility; engine version 2 and $10,000 start |
| MKT-06 – MKT-09 | market-stocks | U | `deriveSeed`: deterministic, uint32, ten distinct streams per seed, rejects bad input |
| MKT-10 – MKT-20 | market-stocks | U / P | 70 indexed candles per stock; same seed → same market; each stock comes from its own stream; 1821 draws per stock; valid candles over 200 seeds; start prices and gap/body limits per stock; volatility order follows the settings; no drift; v1 candles unchanged |
| MKT-21 – MKT-32 | market-portfolio | U | $10,000 start; buys/sells on one shared cash balance; average cost; proportional basis removal with half-up rounding; other stocks untouched; pure functions; errors on programming mistakes; equity and P&L sums |
| MKT-33 – MKT-41 | market-orders | U | Order validation (unknown ticker, bad text, too large, not enough cash with a helpful message, not held, selling too many); placing an order never deducts cash |
| MKT-42 – MKT-47 | market-orders | U | One pending order per stock; replacement notice; cancel; refused replacement keeps the old order |
| MKT-48 – MKT-51 | market-orders | U | Cash set aside across stocks: no double promising, own order freed on replace, cancel frees cash, pending sells reserve nothing |
| MKT-52 – MKT-59 | market-orders | U | Fills at each stock's own next open; sells before buys; buys in placement order; re-placing moves to the back; gap-up rejection spends nothing; one rejection does not stop other orders |
| MKT-60 – MKT-62 | market-orders | U | Final candle refuses orders; finished round returns the same state for every action; no mutation |
| MKT-63 – MKT-74 | market-flow | U | Start state and first view; candle validation; 60 advances; no future candles for any stock at any k; view equals candles 1..k; mark/previous close/change; fill at open not close; cash stays exact across stocks (Stage 1 regressions); max-buy accepted / +1 refused; display-only set-aside |
| MKT-75 – MKT-80 | market-flow | U | Finish: no-op before candle 70; liquidation at each stock's own final close in table order; cash = start + realized P&L; no shares; results null until finished; results add up |
| MKT-81 – MKT-86 | market-flow | U | Replay (mid-round and after finish); determinism; different seeds differ; notice cap of 20; cancel before advance trades nothing |
| MKT-87 – MKT-96 | market-invariants | P | Rules.md §12.9 after every action of 60 random sessions × 400 actions: integers and non-negative; ledger; equity; one pending per stock; set-aside ≤ cash; submit/cancel leave cash alone; refused orders change nothing; fill prices; no future candles and max-buy agreement |
| MKT-97 – MKT-101 | market-reference | R | Fixture matches version/start/tickers; derived seeds; ten stocks' candles for seeds 12345, 1 and 4294967295; eight random sessions of 1000 actions end in exactly the Python simulator's cash, positions, pending orders and trade list, with identical cash after every advance and at every finish; the sessions contain enough trades, finishes and replays to mean something |

Regenerate the fixture with `python tools/reference_market.py > tests/fixtures/reference-market-v2.json` **only** together with a `MARKET_ENGINE_VERSION` bump (rules.md §12.10).

### Manual UI checks for market mode

| ID | Check |
|----|-------|
| UI-12 | Ten stock chips show ticker, price and change; clicking one switches the chart title, the order panel title and the candles (every stock shows exactly 10 candles at the start) |
| UI-13 | A chip shows `B20` / `S5` while that stock has a pending order and "N held" once you own shares |
| UI-14 | Place buy orders for two stocks: Cash stays unchanged, the Account panel shows "Set aside for pending buys (est.)" and a lower "Available cash", and Max for the second stock is smaller than before |
| UI-15 | Typing more shares than affordable (or than held) shows the reason under the box before clicking |
| UI-16 | Next candle: both orders appear in Trade history with the right stock; Cash drops; "Your holdings" lists both stocks with average entry and P&L; clicking a ticker there selects it |
| UI-17 | Pending orders list shows every pending order with its own Cancel button |
| UI-18 | At candle 60, "Finish round" sells everything; the results screen shows the final equity, a per-stock table and a chart you can switch between stocks; Replay gives identical candles |
| UI-19 | On a phone-width screen nothing scrolls sideways; the stock chips wrap into two columns |

UI-10 and UI-11 from §14 still apply, now per stock, with the label "Set aside for pending buys (est.)".

## 16. Live market mode — engine v3 (`tests/live-*.test.ts`, `tests/playback.test.ts`, `tests/chart-scale.test.ts`)

Types: **U** unit, **P** property (random play), **R** differential test against the independent Python reference (`tools/reference_live.py`). Rules: docs/rules.md §13.

| IDs | File | Type | What it proves |
|-----|------|------|----------------|
| LIV-01 – LIV-02 | live-prices | U | 10 ticks per candle, 10 history candles, $1,000 start, engine version 3; the 1/√10 constant |
| LIV-03 – LIV-05 | live-prices | U | `uniformAt(seed, k)` equals the k-th output of the sequential generator (14 seeds, k up to 3000); any read order gives the same numbers; bad arguments refused |
| LIV-06 – LIV-12 | live-prices | U / P | Tick prices equal a plain sequential implementation of the formulas; same seed → same prices; asking for tick 900 first changes nothing; whole cents, ≥ $1.00, tick 0 inside the start range; no tick moves more than half the candle limit; each stock has its own stream; helper formulas |
| LIV-13 – LIV-15 | live-prices | P | No built-in direction (mean tick return ≈ 0); calmer stocks move less per tick, in settings order; ten ticks move a price about as much as the old one-candle body |
| LIV-16 – LIV-18 | live-prices | U | Scripted markets return exactly the prices given and refuse ticks they do not have; unknown tickers and bad ticks refused |
| LIC-01 | live-candles | P | At every tick of four seeds × ten stocks the candles equal those of an independent tick-by-tick **recorder** (open when a candle begins; high/low/close updated every tick; finalised after 10 ticks; next candle started) |
| LIC-02 – LIC-04 | live-candles | P | Every finished candle has exactly 10 ticks; the forming one has tick-mod-10; a candle opens at the previous close; high/low are the extremes of its ticks |
| LIC-05 – LIC-07 | live-candles | U | Hand-worked candle (open 1000, high 1040, low 980, close 1015); partial candle; colours up / down / flat (a flat candle that moved in between); colour stored on every candle |
| LIC-08 – LIC-11 | live-candles | U | A new candle exists at once after the 10th tick (0 ticks, open = high = low = close); finished candles never change; the forming candle changes every tick; advancing 10 ticks adds exactly one candle |
| LIC-12 – LIC-16 | live-candles | U | Candle helpers; a session opens with 10 history candles + an empty forming one; the newest candle always closes at the current price; the view reveals nothing after the current tick; invalid candle requests refused |
| LTR-01 – LTR-07 | live-trading | U | A buy fills at the current price and updates cash/shares/trade list; **during an unfinished candle the fill is at that tick's price, not the candle's later close**; the price in the view equals the trade price for every stock and many ticks; sells realise profit against average cost; one cash balance for all stocks; trading does not move prices |
| LTR-08 – LTR-13 | live-trading | U | Refusals change nothing but the message: no cash, cannot afford one share, not held / too many, bad quantity text, unknown ticker, ended session |
| LTR-14 – LTR-20 | live-trading | U / P | Max buy accepted and Max+1 refused (all stocks, many ticks); Max sell; net worth, return and P&L follow every tick; equity − start = realised + unrealised; tick/session change; start-cash option; trade ids, ticks and candle numbers |
| LFL-01 – LFL-03 | live-flow | U | New session: tick 100, $1,000, nothing held, running; its view; same seed → same prices |
| LFL-04 – LFL-10 | live-flow | U | **Advancing one tick produces exactly one tick**; n ticks = n single steps; the route (steps, skips, jumps) does not change prices or candles; skip to candle end (and a whole candle at a boundary); bad counts refused; time never changes cash/shares; the engine is pure |
| LFL-11 – LFL-16 | live-flow | U | Timed sessions: end tick, ticks remaining, end exactly at the end tick and never move afterwards, jump past the end stops at it, skip cut short, final net worth (no forced sale), duration validation |
| LFL-17 – LFL-20 | live-flow | U | Reset: same prices, clean account; reset of timed/ended sessions; custom start cash kept; nothing after the current tick is reachable from the view |
| LIN-01 – LIN-12 | live-invariants | P | After every action of 40 random sessions × 400 actions (a third open-ended, the rest timed): integers and non-negative; ledger balances; equity identities; every trade at its own tick's price; ordering and nothing after the end; time moves only by advance/skip/reset and by exactly the requested amount; time never changes cash; refused orders change nothing; Max accepted / Max+1 refused; no future information; newest candle closes at the current price; replay reproduces the final state |
| LIN-13 – LIN-15 | live-invariants | P | Sanity of the generator: many fills and refusals, sessions end, resets, actions after the end; all ten stocks traded |
| LRF-01 – LRF-07 | live-reference | R | Fixture matches version/start cash/candle size; **all ten stocks' prices at ticks 0–400 for four seeds**; candles (index, ticks, O, H, L, C) at twelve ticks including mid-candle ones; eight random sessions of 1000 actions (open-ended, timed, custom cash, resets) end in exactly the Python simulator's cash, positions and trade list; tick/cash/trade-count equal after **every** action; tick/cash/net worth equal after every advance and skip; the sessions are rich enough (≥ 1000 trades, resets, ended-session actions) |
| PLB-01 – PLB-07 | playback | U | 1000/500/250 ms per tick at 1×/2×/4×; starts paused and nothing moves; 1× gives exactly one tick per second, 2× and 4× two and four; **pausing stops updates** and resuming continues; Play twice does not double the speed |
| PLB-08 – PLB-11 | playback | U | **Step moves exactly one tick**; Step/Skip do nothing while playing; Skip to the candle end; stepped prices equal the engine's |
| PLB-12 – PLB-15 | playback | U | **Speed changes do not change prices**: every price shown over a script of play/pause/4×/2×/step/skip equals the engine's for that tick; the same number of ticks gives the identical view at 1×, 2×, 4× and by hand; a speed change loses or repeats no tick; invalid speeds refused |
| PLB-16 – PLB-20 | playback | U | New candles form automatically (counts at 10, 20, 30 ticks; forming candle 1…9, 0, 1, 2 ticks); a buy while playing fills at the price on screen; trading while paused; chart, cash and holdings stay in step after every tick and trade; every trade price equals the engine's price for its tick |
| PLB-21 – PLB-24 | playback | U | A timed session ends while playing: playback pauses itself, trading closes; Reset and New session pause and start over; subscribers/snapshots; dispose stops the timer |
| CHS-01 – CHS-09 | chart-scale | U | Grid steps are 1/2/5 × 10^k; the price range always contains the visible candles, has round edges, does not re-scale when a new candle stays inside it, grows when it leaves it; candle caption text |

Regenerate the fixture with `python tools/reference_live.py > tests/fixtures/reference-live-v3.json` **only** together with a `LIVE_ENGINE_VERSION` bump (rules.md §13.10).

### Real-browser checks for live mode

These were run by driving the built page in headless Chromium with **real timers** (not part of `npm test`; see "Not automated" in the README):

- start screen: paused at tick 100; ten prices equal the engine's; $1,000.00; 10 history candles + 1 empty forming candle
- Step: exactly one tick; the forming candle gets 1, 2 … 9 ticks; the 10th tick finalises it and starts the next one; Skip to candle end; Skip at a boundary
- for every drawn candle: tick count, colour class, **body and wick geometry against the engine's open/high/low/close** (mapped through the on-screen grid lines)
- Play at 1× for 3.3 s = exactly 3 ticks; Pause for 2.6 s = no change at all; 4× for 2.1 s = 8 ticks (±1)
- **animation is real**: during 6 ticks the forming candle's body was drawn in 96 different positions/sizes; during scrolling the chart layer was drawn in 66 different positions
- trades at paused and running ticks (Max buy at 4×): the trade row's price equals the engine's price for the row's own tick; cash, holdings, net worth, chart and chips all agree
- history: Older / Newer / Back to live, the scroll bar, arrow keys, hover shows that candle's own O/H/L/C; the window does not jump while the market keeps running
- mode switch pauses the live market and keeps its state; phone width: no sideways scrolling and the chart fits
- no console errors or warnings

### Manual UI checks for live mode

| ID | Check |
|----|-------|
| UI-20 | Start: "Paused — press Play to start the market"; Play starts one tick per second; the forming candle grows and shrinks with each tick and its outline is amber |
| UI-21 | Pause really stops it (prices, candle, tick counter); Step and Skip are greyed out while playing |
| UI-22 | 2× and 4× visibly speed things up; switching speed while playing does not skip or repeat a tick |
| UI-23 | After the 10th tick the candle turns solid and a new empty candle appears at its right; once the chart is full it slides smoothly to the left |
| UI-24 | Buy and Sell fill immediately; the green ▲ / red ▼ marker appears on the chart; Cash, Net worth, Holdings and Trade history change together |
| UI-25 | "Older" shows earlier candles and the market keeps running off-screen; "Back to live" returns; hovering or tapping a candle shows its open/high/low/close |
| UI-26 | "Classic rounds" shows the old turn-based game; going back to "Live market" finds it paused and unchanged |
