// The Shop (docs/world.md §29, §30): things to wear, bought with Career cash. A name colour, a glow around the name, a ring around the profile picture and a title
// under the name (everybody sees these); and things for your own screen only: candle colours and shapes, a chart background and effect, and a style for the party after a
// win. The server decides everything (what a thing costs, who may buy it, what is worn); this page shows the catalog (src/shared/cosmeticCatalog.ts)
// and the server's answer about the player, and asks the server to buy and to wear. Buying always asks twice ("Buy" then "Confirm"), because the money is gone for good.
import { useEffect, useState, type CSSProperties } from 'react';
import { api } from './api';
import { AuthPanel } from './AuthPanel';
import { Avatar, colourOf, initialOf } from './Avatar';
import { COSMETICS, GEAR_SLOTS, LEAGUE_LOOKS, PROFILE_SLOTS, RARITY_NAMES, SEASON_CHAMPION_LOOKS, SEASON_PODIUM_LOOKS, SLOTS, TEAM_CHAMPION_LOOKS, isGearSlot, priceOf, priceText, type AnySlot, type CosmeticDef } from './cosmeticCatalog';
import { formatCents } from './format';
import { ChartSample, WinSample } from './GearSamples';
import { PET_EGG, petById, petLabel } from './petCatalog';
import { PlayerName } from './PlayerName';
import { problemText } from './playersUtil';
import { profileStore } from './profileStore';
import { RoleBadge } from './RoleBadge';
import { boughtText, lockReason } from './shopUtil';
import { Skeleton } from './Skeleton';
import { sharedStore, useShared } from './store';
import type { ShopView } from './types';

/** What a thing looks like, drawn with the same classes the real thing uses (the Goals page shows its free looks the same way). */
export function Sample({ def, name }: { def: CosmeticDef; name: string }) {
  if (isGearSlot(def.slot)) return def.slot === 'win' ? <WinSample id={def.id} /> : <ChartSample id={def.id} />;
  if (def.slot === 'frame') {
    return (
      <span className={`pfp-frame cos-${def.id}`} style={{ '--s': '44px' } as CSSProperties} aria-hidden="true">
        <span className="pfp pfp-letter" style={{ width: 44, height: 44, fontSize: 20, background: colourOf(name) }}>
          {initialOf(name)}
        </span>
      </span>
    );
  }
  if (def.slot === 'title') {
    return (
      <span className="pname-wrap" aria-hidden="true">
        <strong className="pname">{name}</strong>
        <span className="ptitle">{def.name}</span>
      </span>
    );
  }
  if (def.slot === 'banner') {
    return (
      <span className={`pbanner shop-banner cos-${def.id}`} aria-hidden="true">
        <strong className="pname">{name}</strong>
      </span>
    );
  }
  if (def.slot === 'pet') {
    // The egg and the four forms it grows into, in order.
    const forms = petById(def.id)?.forms ?? [];
    return (
      <span className="pet-sample" aria-hidden="true">
        {[PET_EGG, ...forms].map((form, i) => (
          <span className={`pet-form pet-stage-${i}`} key={i}>
            {form}
          </span>
        ))}
      </span>
    );
  }
  return (
    <strong className={`pname shop-sample cos-${def.id}`} aria-hidden="true">
      {name}
    </strong>
  );
}

export function ShopScreen() {
  const { user, badgesVersion } = useShared();
  const [view, setView] = useState<ShopView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const userId = user?.id ?? 0;

  useEffect(() => {
    if (userId === 0) return undefined;
    let alive = true;
    api
      .shop()
      .then((v) => {
        if (!alive) return;
        setView(v);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(problemText(e));
      });
    return () => {
      alive = false;
    };
  }, [userId, badgesVersion]);

  if (!user) return <AuthPanel />;

  const buy = async (def: CosmeticDef) => {
    if (busy) return;
    setBusy(def.id);
    setError(null);
    setNote(null);
    try {
      const out = await api.buyItem(def.id);
      setView({ cashCents: out.cashCents, owned: out.owned, equipped: out.equipped, gear: out.gear, badges: out.badges });
      profileStore.setGear(out.gear);
      setNote(boughtText(def.name, out.priceCents));
      void sharedStore.refreshAccount();
    } catch (e) {
      setError(problemText(e));
    } finally {
      setConfirming(null);
      setBusy(null);
    }
  };

  const wear = async (slot: AnySlot, item: string | null, def: CosmeticDef) => {
    if (busy) return;
    setBusy(def.id);
    setError(null);
    setNote(null);
    try {
      const out = await api.equipItem(slot, item);
      setView((v) => (v ? { ...v, equipped: out.equipped, gear: out.gear } : v));
      profileStore.setGear(out.gear);
      setNote(item === null ? `${def.name} is off. You still own it.` : `${def.name} is on.`);
    } catch (e) {
      setError(problemText(e));
    } finally {
      setBusy(null);
    }
  };

  /** One card: what it looks like, its name and rarity, and what can be done with it (buy, wear, take off, or how to earn it). */
  const renderItem = (def: CosmeticDef, v: ShopView) => {
    const owned = v.owned.includes(def.id);
    const worn = (isGearSlot(def.slot) ? v.gear[def.slot] : v.equipped[def.slot]) === def.id;
    const lock = owned ? null : lockReason(def, v);
    const asking = confirming === def.id;
    const earnedOnly = def.earn !== undefined;
    return (
      <li className={`shop-item rar-${def.rarity}${worn ? ' worn' : ''}`} key={def.id} data-testid={`shop-item-${def.id}`} data-owned={owned} data-worn={worn}>
        <div className="shop-sample-box">
          <Sample def={def} name={user.displayName} />
        </div>
        <div className="shop-item-info">
          <strong>{def.name}</strong>
          <span className={`rar-chip rar-${def.rarity}`}>{RARITY_NAMES[def.rarity]}</span>
          {def.slot === 'pet' && worn && (
            <span className="pet-now muted" data-testid={`pet-now-${def.id}`}>
              Now: {petLabel(def.id, v.equipped.petStage ?? 0)}
            </span>
          )}
        </div>
        <div className="shop-item-act">
          {owned ? (
            worn ? (
              <>
                <span className="shop-wearing">{isGearSlot(def.slot) ? 'On' : 'Wearing'}</span>
                <button type="button" className="btn btn-small btn-ghost" disabled={busy !== null} onClick={() => void wear(def.slot, null, def)} data-testid={`shop-off-${def.id}`}>
                  Take off
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-small" disabled={busy !== null} onClick={() => void wear(def.slot, def.id, def)} data-testid={`shop-wear-${def.id}`}>
                {isGearSlot(def.slot) ? 'Use' : 'Wear'}
              </button>
            )
          ) : earnedOnly ? (
            <span className="shop-lock muted" data-testid={`shop-earn-${def.id}`}>
              {def.how}
            </span>
          ) : asking ? (
            <>
              <button type="button" className="btn btn-small btn-buy" disabled={busy !== null} onClick={() => void buy(def)} data-testid={`shop-confirm-${def.id}`}>
                Confirm {priceText(priceOf(def))}
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy !== null} onClick={() => setConfirming(null)} data-testid={`shop-cancel-${def.id}`}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn btn-small" disabled={lock !== null || busy !== null} onClick={() => setConfirming(def.id)} data-testid={`shop-buy-${def.id}`}>
                Buy {priceText(priceOf(def))}
              </button>
              {lock && (
                <span className="shop-lock muted" data-testid={`shop-lock-${def.id}`}>
                  {lock}
                </span>
              )}
            </>
          )}
        </div>
      </li>
    );
  };

  const renderSlot = (slotId: AnySlot, label: string, hint: string, v: ShopView) => {
    const items = COSMETICS.filter((c) => c.slot === slotId)
      .filter((c) => c.earn === undefined) // looks that are earned are not for sale: they have their own sections below
      .sort((a, b) => a.rarity - b.rarity);
    return (
      <section className={`card shop-section shop-slot-${slotId}`} key={slotId} aria-label={label} data-testid={`shop-slot-${slotId}`}>
        <h3>
          {label} <span className="h2-note">{hint}</span>
        </h3>
        <ul className="shop-grid">{items.map((def) => renderItem(def, v))}</ul>
      </section>
    );
  };

  /** The looks that can not be bought: given for reaching a ranked tier, finishing a season high, or winning the weekly team race. They are shown tier by tier (the ring, the title and the banner of a tier together). */
  const earnedItems = (kind: 'ranked' | 'team', order: readonly string[]): CosmeticDef[] => {
    const all = COSMETICS.filter((c) => c.earn === kind);
    const first = order.map((id) => all.find((c) => c.id === id)).filter((c): c is CosmeticDef => c !== undefined);
    return [...first, ...all.filter((c) => !order.includes(c.id))];
  };
  const renderEarned = (v: ShopView) => {
    const groups: { key: string; label: string; hint: string; items: CosmeticDef[] }[] = [
      { key: 'ranked', label: 'Earned in ranked 1v1', hint: 'Reach a tier, or finish a season on the podium. Given at the end of the season.', items: earnedItems('ranked', [...LEAGUE_LOOKS.flatMap((l) => l.items), ...SEASON_PODIUM_LOOKS, ...SEASON_CHAMPION_LOOKS]) },
      { key: 'team', label: 'Earned with your team', hint: 'Be in the team that wins the weekly team race.', items: earnedItems('team', TEAM_CHAMPION_LOOKS) },
    ];
    return groups.map((g) => (
      <section className={`card shop-section shop-earned shop-earned-${g.key}`} key={g.key} aria-label={g.label} data-testid={`shop-earned-${g.key}`}>
        <h3>
          {g.label} <span className="h2-note">{g.hint}</span>
        </h3>
        <ul className="shop-grid">{g.items.map((def) => renderItem(def, v))}</ul>
      </section>
    ));
  };

  return (
    <div className="shop-layout" data-testid="shop-screen">
      <section className="card shop-head" aria-label="Your look">
        <h2>
          Shop <span className="h2-note">things to wear</span>
        </h2>
        <p className="hint">
          These are only for looks: they give no money and no help in trading. The money you spend is gone for good, so your net worth, your place on the leaderboard and your growth this week all go down by the price.
        </p>
        <div className="shop-me">
          <Avatar username={user.username} displayName={user.displayName} size={56} />
          <div className="shop-me-who">
            <PlayerName username={user.username} name={user.displayName} link={false} className="shop-me-name" />
            <RoleBadge role={user.role} />
          </div>
          <div className="shop-cash">
            <span className="muted">Your Career cash</span>
            <strong className="mono" data-testid="shop-cash">
              {view ? formatCents(view.cashCents) : '…'}
            </strong>
          </div>
        </div>
        {note && (
          <p className="notice success" role="status" data-testid="shop-note">
            {note}
          </p>
        )}
        {error && (
          <p className="notice error" role="alert" data-testid="shop-error">
            {error}
          </p>
        )}
      </section>

      {view === null && !error && (
        <section className="card" data-testid="shop-loading">
          <p className="muted">Loading the Shop…</p>
          <Skeleton rows={4} />
        </section>
      )}

      {view && SLOTS.map((slot) => renderSlot(slot.id, slot.label, slot.hint, view))}
      {view && PROFILE_SLOTS.map((slot) => renderSlot(slot.id, slot.label, slot.hint, view))}
      {view && renderEarned(view)}

      {view && (
        <section className="card shop-head shop-screen-only" aria-label="For your screen only" data-testid="shop-gear-head">
          <h2>
            For your screen only <span className="h2-note">nobody else sees these</span>
          </h2>
          <p className="hint">
            Colours and shapes for your candles, a background and an effect for your price chart, and a style for the party after a win. Other players cannot see them and they change no number: they only change how <em>your</em> screen looks.
          </p>
        </section>
      )}
      {view && GEAR_SLOTS.map((slot) => renderSlot(slot.id, slot.label, slot.hint, view))}
    </div>
  );
}
