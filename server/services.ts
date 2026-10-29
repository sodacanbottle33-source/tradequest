// The pieces of the server, created once and shared by the routes.

import type { Admin } from './admin';
import type { Auth, User } from './auth';
import type { Badges } from './badges';
import type { Bankruptcies } from './bankruptcy';
import type { Calls } from './calls';
import type { Challenges } from './challenges';
import type { Chat } from './chat';
import type { ChatPictures } from './chatPictures';
import type { Config } from './config';
import type { Launches } from './launch';
import type { Learn } from './learn';
import type { FlowService } from './flow';
import type { CircuitBreaker } from './breaker';
import type { LimitOrders } from './limitOrders';
import type { Liquidator } from './liquidation';
import type { Halts } from './halts';
import type { Leases } from './lease';
import type { MatchService } from './lobby/service';
import type { Logger } from './log';
import type { Messages } from './messages';
import type { Renames } from './rename';
import type { Billboard } from './billboard';
import type { Shop } from './cosmetics';
import type { CompanyPictures } from './companyPictures';
import type { Profiles } from './profile';
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
  /** Pictures sent in the chats: rules, limits, expiry and the owner's switch (server/chatPictures.ts). */
  readonly chatPictures: ChatPictures;
  /** Private chats: 1-to-1 and groups (private or public), requests, blocking and reports (server/messages.ts). */
  readonly messages: Messages;
  /** Changing your username (server/rename.ts). */
  readonly renames: Renames;
  /** The Shop: things to wear, bought with Career cash, and what each player wears (server/cosmetics.ts). */
  readonly shop: Shop;
  /** The billboard: three places that show a company its launcher paid for (server/billboard.ts). */
  readonly billboard: Billboard;
  /** Profile pictures and who is online (server/profile.ts). */
  readonly profiles: Profiles;
  /** Pictures for stocks and memecoins (server/companyPictures.ts). */
  readonly companyPictures: CompanyPictures;
  /** Achievement badges: who earned which, given by a sweep every little while (server/badges.ts). */
  readonly badges: Badges;
  /** The tutorial's saved progress and the practice lessons with their optional AI teacher (server/learn.ts). */
  readonly learn: Learn;
  /** Companies that went bankrupt, and the daily check that decides if another one does (server/bankruptcy.ts). */
  readonly bankruptcies: Bankruptcies;
  /** Voice calls between two friends: ringing and passing the connection messages, nothing saved (server/calls.ts). */
  readonly calls: Calls;
  /** Null only when the app was created with news switched off (some tests). */
  readonly news: NewsService | null;
  readonly scheduler: NewsScheduler | null;
  /** Finds the account an order should use ('career' or 'match'); other modules plug in here. */
  resolveAccount(user: User, which: string): AccountRow;
}
