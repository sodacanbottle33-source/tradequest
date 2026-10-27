// The admin log: everything the owner did with the admin panel, newest first.
import { whenText } from './adminUtil';
import { formatBps, formatCents } from './format';
import type { AdminState } from './types';

type Entry = AdminState['log'][number];

function describe(e: Entry): string {
  const d = e.detail;
  const num = (k: string): number => (typeof d[k] === 'number' ? (d[k] as number) : 0);
  switch (e.action) {
    case 'shock':
      return `${String(d.style)} ${formatBps(Math.round(num('percent') * 100))} on ${e.target} (${String(d.speed)}): “${String(d.headline)}”`;
    case 'halt':
      return `halted trading in ${e.target}${d.reason ? ` (${String(d.reason)})` : ''}`;
    case 'resume':
      return `resumed trading in ${e.target}`;
    case 'cash':
      return `${num('amountCents') >= 0 ? 'gave' : 'took'} ${formatCents(Math.abs(num('amountCents')))} Career cash ${num('amountCents') >= 0 ? 'to' : 'from'} ${e.target}${d.note ? ` (${String(d.note)})` : ''}`;
    case 'coins':
      return `${num('amountCents') >= 0 ? 'gave' : 'took'} ${formatCents(Math.abs(num('amountCents')))} coins ${num('amountCents') >= 0 ? 'to' : 'from'} ${e.target}${d.note ? ` (${String(d.note)})` : ''}`;
    case 'flow': // older entries: the price-impact dial no longer exists
      return `set the price impact of player trades from ${String(d.from)} to ${String(d.to)}`;
    case 'ban':
      return `banned ${e.target}${typeof d.hours === 'number' ? ` for ${d.hours} hour${d.hours === 1 ? '' : 's'}` : ' until lifted'}${d.reason ? ` (${String(d.reason)})` : ''}`;
    case 'unban':
      return `lifted the ban on ${e.target}`;
    case 'kick':
      return `kicked ${e.target} for ${num('minutes') >= 60 ? (num('minutes') >= 1440 ? `${Math.round(num('minutes') / 1440)} day${num('minutes') === 1440 ? '' : 's'}` : `${Math.round(num('minutes') / 60)} hour${num('minutes') === 60 ? '' : 's'}`) : `${num('minutes')} minutes`}${d.reason ? ` (${String(d.reason)})` : ''}`;
    case 'mod_appoint':
      return `made ${e.target} a moderator`;
    case 'mod_remove':
      return `took the moderator job from ${e.target}`;
    case 'shares':
      return `${num('qty') >= 0 ? 'gave' : 'took'} ${Math.abs(num('qty')).toLocaleString('en-US')} shares of ${String(d.ticker)} ${num('qty') >= 0 ? 'to' : 'from'} ${e.target}${d.note ? ` (${String(d.note)})` : ''}`;
    case 'reset':
      return `reset the Career account of ${e.target} (it had ${formatCents(num('netWorthBeforeCents'))} net worth and ${num('positions')} holding${num('positions') === 1 ? '' : 's'})${d.note ? ` (${String(d.note)})` : ''}`;
    case 'announce':
      return d.text ? `posted the announcement “${String(d.text)}”` : 'took the announcement down';
    case 'pause':
      return `paused ALL trading${d.reason ? ` (${String(d.reason)})` : ''}`;
    case 'unpause':
      return 'opened trading again after the pause';
    case 'stock':
      return `made the stock ${e.target} (${String(d.name)}, ${String(d.tier)} ${String(d.sector)}, ${String(d.personality)}) starting at ${formatCents(num('priceCents'))}`;
    case 'coin':
      return `made the memecoin ${e.target} (${String(d.name)}, ${String(d.size)} size) starting at ${formatCents(num('priceCents'))}, putting in ${formatCents(num('spentCents'))} for ${num('stakeShares').toLocaleString('en-US')} coins`;
    case 'chat_delete':
      return `removed a chat message by ${String(d.author)}`;
    case 'chat_mute':
      return `muted ${e.target} in the chat for ${num('minutes')} minute${num('minutes') === 1 ? '' : 's'}${d.reason ? ` (${String(d.reason)})` : ''}`;
    case 'chat_ban':
      return `banned ${e.target} from the chat until lifted${d.reason ? ` (${String(d.reason)})` : ''}`;
    case 'chat_lift':
      return `let ${e.target} write in the chat again`;
    case 'chat_dismiss':
      return `closed the reports about a chat message (${e.target})`;
    case 'pm_dismiss':
      return `closed the reports about a private message (${e.target})`;
    case 'chat_pictures':
      return d.on === false ? 'switched pictures in chats off' : 'switched pictures in chats on';
    case 'avatar_remove':
      return `removed the profile picture of ${e.target}`;
    case 'company_pic_set':
      return `set the picture of ${e.target}`;
    case 'company_pic_remove':
      return `removed the picture of ${e.target}`;
    case 'sens': // older entries: the per-stock setting no longer exists
      return `changed how strongly trades move ${e.target}: ${String(d.from)} → ${String(d.to)}`;
    default:
      return `${e.action} ${e.target}`;
  }
}

export function AdminLog({ state }: { state: AdminState | null }) {
  return (
    <section className="card" aria-label="Admin log">
      <h2>
        Admin log <span className="h2-note">last {state?.log.length ?? 0} actions</span>
      </h2>
      {state && state.log.length === 0 && <p className="hint">Nothing has been done yet.</p>}
      {state && state.log.length > 0 && (
        <div className="table-wrap">
          <table className="trades" data-testid="admin-log">
            <thead>
              <tr>
                <th>Time</th>
                <th>Who</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {state.log.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{whenText(e.createdMs)}</td>
                  <td>{e.admin}</td>
                  <td>{describe(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
