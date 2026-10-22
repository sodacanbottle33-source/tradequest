import { formatCents, formatSignedCents, formatSignedPercent, type MarketResults, type MarketView } from '../engine';
import { CandleChart } from './CandleChart';
import { tone } from './labels';
import { StockList } from './StockList';
import { TradeHistory } from './TradeHistory';

interface Props {
  view: MarketView;
  results: MarketResults;
  selected: string;
  onSelect: (ticker: string) => void;
  onNewRound: () => void;
  onReplay: () => void;
}

export function ResultsScreen({ view, results, selected, onSelect, onNewRound, onReplay }: Props) {
  const t = tone(results.totalReturn);
  const stock = view.stocks.find((s) => s.ticker === selected) ?? view.stocks[0];
  return (
    <main className="results">
      <section className="card results-summary">
        <p className="eyebrow">
          Round complete · <span className="badge-simulated small">SIMULATED</span>
        </p>
        <h1>{formatCents(results.finalEquity)}</h1>
        <p className={`results-return ${t}`}>
          {formatSignedCents(results.totalReturn)} ({formatSignedPercent(results.totalReturn, results.startCash)}) vs.{' '}
          {formatCents(results.startCash)} start
        </p>
        <dl className="stats results-stats">
          <div className="stat">
            <dt>Realized P&amp;L</dt>
            <dd className={t}>{formatSignedCents(results.realizedPnl)}</dd>
          </div>
          <div className="stat">
            <dt>Your trades</dt>
            <dd>{results.playerTradeCount}</dd>
          </div>
          <div className="stat">
            <dt>Seed</dt>
            <dd className="mono">{results.seed}</dd>
          </div>
          <div className="stat">
            <dt>Market engine</dt>
            <dd>v{results.engineVersion}</dd>
          </div>
        </dl>
        <p className="muted small-print">
          Any shares still held at the end were sold automatically at each stock's final candle close. Replay uses the
          same seed, so you get exactly the same candles for all ten stocks.
        </p>
        <div className="results-actions">
          <button type="button" className="btn btn-primary" onClick={onReplay}>
            Replay this round
          </button>
          <button type="button" className="btn btn-ghost" onClick={onNewRound}>
            New round
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Result by stock</h2>
        <div className="table-wrap">
          <table className="trades">
            <thead>
              <tr>
                <th>Stock</th>
                <th>Company</th>
                <th className="num">Your trades</th>
                <th className="num">Realized P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {results.perStock.map((s) => (
                <tr key={s.ticker}>
                  <td className="mono">{s.ticker}</td>
                  <td>{s.name}</td>
                  <td className="num">{s.tradeCount}</td>
                  <td className={`num ${tone(s.realizedPnl)}`}>{s.tradeCount === 0 && s.realizedPnl === 0 ? '—' : formatSignedCents(s.realizedPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <StockList stocks={view.stocks} selected={selected} onSelect={onSelect} />
      {stock && (
        <section className="card chart-card">
          <CandleChart
            candles={stock.candles}
            markPrice={stock.markPrice}
            roundNumber={view.roundNumber}
            roundLength={view.roundLength}
            ticker={stock.ticker}
            name={stock.name}
          />
        </section>
      )}
      <section className="card history-card">
        <h2>Trade history</h2>
        <TradeHistory trades={results.trades} />
      </section>
    </main>
  );
}
