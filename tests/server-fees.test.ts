// Stocks pay no trading fee in this version of TradeQuest. Only memecoin orders do (0.5 %): see tests/server-memefees.test.ts, server/fees.ts
// and docs/world.md §6.6. The old 0.1 % fee on every order (the version before the fee was put back on request) is saved in
// wip-backup\tradequest-with-fees-2026-10-18.zip.
import { describe, it } from 'vitest';

describe('trading fee on stocks (none)', () => {
  it('has no stock fee tests: stocks pay nothing (FEE-15 in server-memefees.test.ts checks it), memecoins pay 0.5 % (FEE-1 to FEE-19)', () => {});
});
