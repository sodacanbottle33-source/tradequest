// The words of the pop-up that appears when the market closes a position by itself (liquidation, stop-loss, take-profit).
// The server decides everything; this only turns its message into a sentence.
import { formatCents } from './format';
import type { PositionNotice } from './types';

export interface ToastText {
  /** How it should look: a loss, a gain, or neutral (a stop or take that came out at about zero). */
  readonly tone: 'bad' | 'good' | 'neutral';
  readonly title: string;
  readonly text: string;
}

function signed(cents: number): string {
  return `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatCents(Math.abs(cents))}`;
}

/** What to tell the player, in words. */
export function describeNotice(n: PositionNotice): ToastText {
  const where = n.account === 'match' ? ' in your 1v1 match' : '';
  const side = n.short ? 'short' : 'long';
  const shares = `${n.shares} ${n.shares === 1 ? 'share' : 'shares'}`;
  const price = `$${(n.priceCents / 100).toFixed(2)}`;
  if (n.reason === 'margin_call') {
    const liq = n.liqPriceCents ? ` The market closes it at ${n.short ? 'or above' : 'or below'} $${(n.liqPriceCents / 100).toFixed(2)}.` : '';
    return {
      tone: 'bad',
      title: 'Margin call',
      text: `Your ${side} position in ${n.ticker} has lost most of the cash you put in (${signed(n.realizedCents)} so far, price ${price}).${liq} Sell some or all of it now to keep what is left.`,
    };
  }
  if (n.reason === 'liquidated') {
    return {
      tone: 'bad',
      title: 'You were liquidated',
      text: `Your ${side} position in ${n.ticker}${where} was closed at ${price}: its margin ran out. You lost ${formatCents(Math.abs(n.realizedCents))}.`,
    };
  }
  const verb = n.short ? 'bought back' : 'sold';
  const what = n.reason === 'stop' ? 'Stop-loss hit' : 'Take-profit hit';
  return {
    tone: n.realizedCents > 0 ? 'good' : n.realizedCents < 0 ? 'bad' : 'neutral',
    title: what,
    text: `Your ${side} position in ${n.ticker}${where} was closed: ${verb} ${shares} at about ${price}. Result ${signed(n.realizedCents)}.`,
  };
}
