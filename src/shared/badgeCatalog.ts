// The achievement badges (docs/world.md §22): what each one is called, what it takes to get it, and how rare it is meant to be. This file is only
// data: the server decides who has earned which badge (server/badges.ts has one rule for each id here), and the screens only show what the server says.
// A badge is for fun. It gives no money and changes no price.

export type BadgeGroup = 'trading' | 'launching' | 'social' | 'learning' | 'daily';

/** 1 = bronze, 2 = silver, 3 = gold, 4 = diamond. A higher tier is harder to get, and is shown first next to a player's name. */
export type BadgeTier = 1 | 2 | 3 | 4;

export interface BadgeDef {
  readonly id: string;
  readonly group: BadgeGroup;
  readonly tier: BadgeTier;
  /** One character (an emoji) that is drawn inside the badge. */
  readonly icon: string;
  readonly name: string;
  /** The sentence that says how to get it. */
  readonly how: string;
  /**
   * A secret badge is hidden on the Badges page until a player earns it: it shows as a "?" medal with only the hint. (It is hidden from the page,
   * not locked away: the name is still in the page's code. It is a game, not a safe.)
   */
  readonly secret?: boolean;
  /** For a secret badge: the one-line nudge shown while it is still hidden. */
  readonly hint?: string;
}

export const BADGE_GROUPS: readonly { readonly id: BadgeGroup; readonly label: string }[] = [
  { id: 'trading', label: 'Trading and money' },
  { id: 'launching', label: 'Launching' },
  { id: 'social', label: 'Friends and chat' },
  { id: 'learning', label: 'Learn and matches' },
  { id: 'daily', label: 'Daily goals and ranked' },
];

export const TIER_NAMES: readonly string[] = ['', 'Bronze', 'Silver', 'Gold', 'Diamond'];

/** How many badges are shown next to a player's name in the Players list. */
export const BADGES_SHOWN = 3;

export const BADGES: readonly BadgeDef[] = [
  // ---- trading and money
  { id: 'first_trade', group: 'trading', tier: 1, icon: '🛒', name: 'First Trade', how: 'Make your first trade in your Career account.' },
  { id: 'trades_10', group: 'trading', tier: 1, icon: '📈', name: 'Getting Busy', how: 'Make 10 trades in your Career account.' },
  { id: 'trades_100', group: 'trading', tier: 2, icon: '🔥', name: 'Market Regular', how: 'Make 100 trades in your Career account.' },
  { id: 'first_profit', group: 'trading', tier: 1, icon: '💵', name: 'In the Green', how: 'Sell something for more than you paid for it.' },
  { id: 'limit_filled', group: 'trading', tier: 1, icon: '⏱️', name: 'Patient Trader', how: 'Have a limit order fill.' },
  { id: 'profit_1k', group: 'trading', tier: 2, icon: '💰', name: 'Doubled Up', how: 'Grow your Career account by $1,000, which doubles the starting money.' },
  { id: 'profit_10k', group: 'trading', tier: 3, icon: '🐋', name: 'Big Fish', how: 'Grow your Career account by $10,000.' },
  { id: 'profit_100k', group: 'trading', tier: 4, icon: '💎', name: 'Whale', how: 'Grow your Career account by $100,000.' },
  { id: 'profit_1m', group: 'trading', tier: 4, icon: '👑', name: 'Tycoon', how: 'Grow your Career account by $1,000,000.' },
  { id: 'trades_1000', group: 'trading', tier: 3, icon: '🏛️', name: 'Market Legend', how: 'Make 1,000 trades in your Career account.' },
  { id: 'winners_10', group: 'trading', tier: 2, icon: '🎯', name: 'Ten Winners', how: 'Close 10 trades at a profit.' },
  { id: 'hold_7d', group: 'trading', tier: 2, icon: '🙌', name: 'Diamond Hands', how: 'Hold a stock or a coin for 7 days without selling any of it.' },
  { id: 'sectors_5', group: 'trading', tier: 2, icon: '🧺', name: 'Spread Out', how: 'Buy companies from 5 different sectors (memecoins do not count).' },
  { id: 'home_run', group: 'trading', tier: 3, icon: '⚾', name: 'Home Run', how: 'Close one trade with a profit of $500 or more.' },
  { id: 'all_sectors', group: 'trading', tier: 3, icon: '🗺️', name: 'Collector', how: 'Buy companies from all 13 sectors (memecoins do not count).', secret: true, hint: 'Spread your money across the whole market.' },
  { id: 'trade_days_7', group: 'trading', tier: 2, icon: '🔁', name: 'Regular', how: 'Trade on 7 different days.', secret: true, hint: 'Come back to the market again and again.' },
  { id: 'lesson_learned', group: 'trading', tier: 1, icon: '📉', name: 'Lesson Learned', how: 'Buy a company that later goes bankrupt.', secret: true, hint: 'Even careful traders get surprised once.' },
  // ---- launching
  { id: 'launch_stock', group: 'launching', tier: 2, icon: '🏢', name: 'Founder', how: 'Launch a stock of your own.' },
  { id: 'launch_coin', group: 'launching', tier: 2, icon: '🪙', name: 'Coin Minter', how: 'Launch a memecoin of your own.' },
  { id: 'company_logo', group: 'launching', tier: 1, icon: '🎨', name: 'Brand Builder', how: 'Give a stock or memecoin you launched a picture.' },
  { id: 'first_investor', group: 'launching', tier: 2, icon: '🤝', name: 'First Investor', how: 'Another player buys a company you launched.' },
  { id: 'ten_investors', group: 'launching', tier: 3, icon: '🌟', name: 'Crowd Favourite', how: 'Ten different players buy the same company you launched.' },
  { id: 'launch_3', group: 'launching', tier: 3, icon: '🏭', name: 'Serial Founder', how: 'Launch 3 companies (stocks or memecoins).' },
  { id: 'fan_club', group: 'launching', tier: 4, icon: '📣', name: 'Fan Club', how: '25 different players buy the same company you launched.' },
  // ---- friends and chat
  { id: 'welcome', group: 'social', tier: 1, icon: '👋', name: 'Welcome!', how: 'Create your TradeQuest account.' },
  { id: 'first_friend', group: 'social', tier: 1, icon: '🧑‍🤝‍🧑', name: 'Friendly', how: 'Make your first friend.' },
  { id: 'five_friends', group: 'social', tier: 2, icon: '🎉', name: 'Popular', how: 'Have 5 friends.' },
  { id: 'friends_25', group: 'social', tier: 3, icon: '🦋', name: 'Social Butterfly', how: 'Have 25 friends.' },
  { id: 'first_group', group: 'social', tier: 1, icon: '💬', name: 'Group Chat', how: 'Join a private group chat.' },
  { id: 'first_chat', group: 'social', tier: 1, icon: '🗣️', name: 'Say Hi', how: 'Write a message in the public chat.' },
  { id: 'chatterbox', group: 'social', tier: 2, icon: '🦜', name: 'Chatterbox', how: 'Write 100 messages in the public chat.', secret: true, hint: 'Talk. A lot.' },
  { id: 'profile_pic', group: 'social', tier: 1, icon: '📸', name: 'Say Cheese', how: 'Choose a profile picture.' },
  { id: 'week_one', group: 'social', tier: 1, icon: '📅', name: 'One Week In', how: 'Have your account for 7 days.' },
  { id: 'month_one', group: 'social', tier: 2, icon: '🗓️', name: 'One Month In', how: 'Have your account for 30 days.' },
  // ---- learn and matches
  { id: 'first_lesson', group: 'learning', tier: 1, icon: '📚', name: 'Student', how: 'Finish a lesson in Learn.' },
  { id: 'lessons_10', group: 'learning', tier: 2, icon: '🎓', name: 'Quick Learner', how: 'Finish 10 lessons in Learn.' },
  { id: 'lessons_50', group: 'learning', tier: 3, icon: '🧠', name: 'Scholar', how: 'Finish 50 lessons in Learn.' },
  { id: 'lessons_100', group: 'learning', tier: 4, icon: '🧙', name: 'Learning Master', how: 'Finish 100 lessons in Learn.' },
  { id: 'streak_5', group: 'learning', tier: 2, icon: '⚡', name: 'On a Roll', how: 'Get 5 lessons right in a row in Learn.' },
  { id: 'tutorial_done', group: 'learning', tier: 2, icon: '🧭', name: 'Tutorial Graduate', how: 'Finish every step of the tutorial.' },
  { id: 'first_match', group: 'learning', tier: 1, icon: '⚔️', name: 'Challenger', how: 'Play a 1v1 match to the end.' },
  { id: 'first_win', group: 'learning', tier: 2, icon: '🏅', name: 'Victory!', how: 'Win a 1v1 match.' },
  { id: 'wins_5', group: 'learning', tier: 3, icon: '🥇', name: 'Champion', how: 'Win 5 1v1 matches.' },
  { id: 'wins_25', group: 'learning', tier: 4, icon: '🏆', name: 'Unbeatable', how: 'Win 25 1v1 matches.' },
  // ---- daily goals and ranked
  { id: 'streak_3', group: 'daily', tier: 1, icon: '🕯️', name: 'Warming Up', how: 'Finish a daily goal 3 days in a row.' },
  { id: 'streak_7', group: 'daily', tier: 2, icon: '🔥', name: 'On Fire', how: 'Keep a daily-goal streak of 7 days.' },
  { id: 'streak_14', group: 'daily', tier: 3, icon: '☄️', name: 'Blazing', how: 'Keep a daily-goal streak of 14 days.' },
  { id: 'streak_30', group: 'daily', tier: 4, icon: '🌋', name: 'Unstoppable', how: 'Keep a daily-goal streak of 30 days.' },
  { id: 'perfect_day', group: 'daily', tier: 1, icon: '✅', name: 'Perfect Day', how: 'Finish all 3 daily goals in one day.' },
  { id: 'goals_50', group: 'daily', tier: 3, icon: '🎯', name: 'Goal Getter', how: 'Finish 50 daily goals.' },
  { id: 'rank_silver', group: 'daily', tier: 2, icon: '🥈', name: 'Silver League', how: 'Reach Silver in ranked 1v1.' },
  { id: 'rank_gold', group: 'daily', tier: 3, icon: '🥇', name: 'Gold League', how: 'Reach Gold in ranked 1v1.' },
  { id: 'rank_platinum', group: 'daily', tier: 3, icon: '💠', name: 'Platinum League', how: 'Reach Platinum in ranked 1v1.' },
  { id: 'rank_diamond', group: 'daily', tier: 4, icon: '💎', name: 'Diamond League', how: 'Reach Diamond in ranked 1v1.' },
  { id: 'season_podium', group: 'daily', tier: 3, icon: '🎖️', name: 'Podium Finish', how: 'Finish a ranked season in the top 3 (at least 5 ranked matches).' },
  { id: 'season_champion', group: 'daily', tier: 4, icon: '🌟', name: 'Season Champion', how: 'Finish a ranked season in 1st place (at least 5 ranked matches).' },
];

const BY_ID = new Map(BADGES.map((b) => [b.id, b]));

export function badgeById(id: string): BadgeDef | undefined {
  return BY_ID.get(id);
}

/** The best of the badges a player has: highest tier first, then in the order of this list; at most `limit`. Ids this version does not know are left out. */
export function bestBadges(ids: readonly string[], limit: number = BADGES_SHOWN): string[] {
  const have = new Set(ids);
  return BADGES.filter((b) => have.has(b.id))
    .map((b, order) => ({ b, order }))
    .sort((x, y) => y.b.tier - x.b.tier || x.order - y.order)
    .slice(0, limit)
    .map((x) => x.b.id);
}
