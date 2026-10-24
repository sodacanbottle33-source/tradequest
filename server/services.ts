// The pieces of the server, created once and shared by the routes.

import type { Admin } from './admin';
import type { Auth, User } from './auth';
import type { Challenges } from './challenges';
import type { Chat } from './chat';
import type { Config } from './config';
import type { Launches } from './launch';
import type { FlowService } from './flow';
import type { CircuitBreaker } from './breaker';
import type { LimitOrders } from './limitOrders';
import type { Liquidator } from './liquidation';
import type { Halts } from './halts';
import type { Leases } from './lease';
import type { MatchService } from './lobby/service';
import type { Logger } from './log';
import type { Messages } from './messages';
import type { NewsScheduler } from './news/scheduler';
import type { NewsService } from './news/service';
import type { SseHub } from './sse';
import type { Social } from './social';
import type { Db } from './sqlite';
import type { AccountRow, Trading } from './trading';
import type { MarketViews } from './world/views';
import type { WorldRuntime } from './world/runtime';

export interface Services {
  readonly config: Config;
  readonly db: Db;
  readonly log: Logger;
  readonly now: () => number;
  readonly world: WorldRuntime;
  readonly auth: Auth;
  readonly trading: Trading;
  readonly views: MarketViews;
  readonly hub: SseHub;
  readonly leases: Leases;
  readonly halts: Halts;
  /** Null when automatic trading pauses are switched off (tests). */
  readonly breaker: CircuitBreaker | null;
  readonly liquidator: Liquidator;
  /** Orders that wait for the price to reach their limit (server/limitOrders.ts). */
  readonly limits: LimitOrders;
  /** Null when news is off or replaced (then trades never move prices). */
  readonly flow: FlowService | null;
  readonly admin: Admin;
  /** Stocks and memecoins any player can launch, and the rug pull (server/launch.ts). */
  readonly launches: Launches;
  readonly matches: MatchService;
  /** Friends, the player list and the richest-players leaderboard (server/social.ts). */
  readonly social: Social;
  /** Friend 1v1 challenges (server/challenges.ts). */
  readonly challenges: Challenges;
  /** The public chat room (server/chat.ts). */
  readonly chat: Chat;
  /** Private chats: 1-to-1 and small groups, requests, blocking and reports (server/messages.ts). */
  readonly messages: Messages;
  /** Null only when the app was created with news switched off (some tests). */
  readonly news: NewsService | null;
  readonly scheduler: NewsScheduler | null;
  /** Finds the account an order should use ('career' or 'match'); other modules plug in here. */
  resolveAccount(user: User, which: string): AccountRow;
}
