// The words of the news for memecoins. Same format as newsText.ts: a template is [headline, body] with {slots}; the generator fills
// them from the coin (name, ticker, products, the developer's handle as {ceo}, the other coin as {peer}, numbers). Every coin,
// handle and project named here is invented. The tests fill every template for every coin and fail if a {slot} is left over.

import type { CompanyCategory, TemplateSet, ViralKind } from './newsText';

const product: TemplateSet = {
  positive: [
    ['{co} dev ships {prod}', '{ceo} announced that {prod} is live. Holders of {tk} piled in within minutes, and the community chat has not been this loud in weeks.'],
    ['{prod} goes live for {co} holders', 'After months of teasers, {prod} opened to everyone holding {tk}. Early users call it "surprisingly not broken".'],
    ['{co} unveils {prod} roadmap', 'The roadmap promises {prod} and {prod2} before the end of the month. Traders are treating every item as a buy signal.'],
    ['{co} community votes to launch {prod2}', '{n} thousand wallets voted yes. {ceo} said the launch will start as soon as the memes are ready.'],
  ],
  negative: [
    ['{co} delays {prod} again', '{ceo} said {prod} needs "a little more time". The community noted that the same thing was said last month.'],
    ['Bug found in {co}\'s {prod}', 'Users reported that {prod} swallowed some transactions. {ceo} promised a fix and asked everyone to stay calm and keep holding.'],
    ['{co} quietly drops {prod2} from the roadmap', 'The item disappeared from the project page without a word. Holders of {tk} noticed within the hour.'],
    ['{prod} fails first stress test', 'A test run of {prod} crashed under a few hundred users. {co} called it "a learning experience".'],
  ],
  uncertain: [
    ['{co} teases something "huge" with no details', '{ceo} posted a picture of a closed door and the word soon. Nobody knows if it is {prod}, {prod2} or lunch.'],
    ['{co} previews {prod} to a few wallets', 'Only a handful of early holders can try {prod}. Reactions are mixed, and {ceo} says more access is coming.'],
  ],
};

const partnership: TemplateSet = {
  positive: [
    ['{co} and {peer} announce shared airdrop', 'Holders of {tk} will receive a slice of the {peer} airdrop. Both communities are celebrating, and both charts jumped.'],
    ['{co} joins forces with {peer}', 'The two projects will run joint events and share a liquidity pool. {ceo} called it "the crossover everyone wanted".'],
    ['{peer} community adopts {co} as its mascot partner', 'A vote in the {peer} chat passed by a wide margin. {co} traders are reading it as a green light.'],
  ],
  negative: [
    ['{co} and {peer} fall out in public', 'Developers of both coins traded insults in a livestream. The shared liquidity pool is now in question.'],
    ['{peer} pulls its liquidity from {co}', 'The move cut the depth of the {tk} market overnight. {ceo} said a replacement is "being discussed".'],
    ['{peer} community mocks {co} holders', 'A meme war between the two communities got out of hand and spilled onto the charts.'],
  ],
  uncertain: [
    ['{co} and {peer} hint at joint project', 'Both developers posted the same emoji at the same minute. Neither would say more.'],
    ['{co} in talks with {peer} about a merger', '{ceo} confirmed a conversation, then added that it was "mostly jokes". Traders are unsure what to make of it.'],
  ],
};

const management: TemplateSet = {
  positive: [
    ['{ceo} locks the developer wallet for a year', 'The lock means the team cannot sell its {tk} for twelve months. Holders took it as a sign that the developer is staying.'],
    ['{co} adds three moderators and a lawyer', '{ceo} said the community now has "grown-ups in the room". Holders cheered, a little nervously.'],
    ['{ceo} buys {tk} with his own money', 'On-chain records show the developer of {co} bought on the open market. He posted a picture of a receipt.'],
  ],
  negative: [
    ['{ceo} moves developer coins to an exchange', 'On-chain trackers noticed that a large amount of {tk} left the developer wallet of {co}. Traders feared a sale.'],
    ['{ceo} goes quiet for a week', 'The developer of {co} stopped posting without warning. The community is "definitely not worried" and checking the wallet every minute.'],
    ['{co} moderator resigns with a long post', 'The post named no names and used many dots. Sellers read it as a bad sign.'],
  ],
  uncertain: [
    ['{ceo} changes the name on his profile', 'The developer of {co} swapped his avatar and bio. He has not explained it, and the chat has several theories.'],
    ['{co} team announces a "restructuring"', 'The post said the team would "evolve" and gave no other detail. {ceo} added a rocket emoji.'],
  ],
};

const legal: TemplateSet = {
  positive: [
    ['Regulator drops inquiry into {co}', 'A watchdog that had asked questions about {tk} said it found nothing to act on. {ceo} thanked the community for the patience.'],
    ['Court sides with {co} in mascot dispute', 'A judge ruled that the {co} mascot is different enough from a famous cartoon. Holders are happy and slightly confused.'],
  ],
  negative: [
    ['Regulator opens inquiry into {co}', 'A watchdog asked the developers of {tk} to explain how the coin was marketed. {ceo} said the team is "cooperating, mostly in memes".'],
    ['{co} hit by lawsuit over mascot', 'A cartoon studio claims the {co} mascot is too similar to its own. The team called the claim "unfunny".'],
    ['Exchange warns users about {tk}', 'A trading site added a risk label to {co}, saying the coin "may lose all of its value". Traders sold the news.'],
  ],
  uncertain: [
    ['{co} asks lawyers about its legal position', '{ceo} said a legal review of {tk} has started. No result is expected soon.'],
    ['Lawmakers debate rules for coins like {co}', 'A hearing discussed how coins such as {tk} should be treated. No proposal has been published.'],
  ],
};

const operations: TemplateSet = {
  positive: [
    ['{co} upgrade cuts fees in half', 'The {tk} network moved to a cheaper setup overnight. Traders welcomed lower costs on small trades.'],
    ['{co} burns {pct}% of supply', 'The team destroyed a slice of the {tk} supply, which makes each remaining coin a little scarcer. Holders called it "the good kind of fire".'],
    ['{co} wallet app reaches {n} thousand downloads', 'The wallet that {ceo} built in a weekend is now used by thousands of holders of {tk}.'],
  ],
  negative: [
    ['{co} network clogged by bots', 'Trading bots flooded the {tk} market and slowed trades for everyone. {ceo} apologised and offered "free vibes".'],
    ['Outage hits {co} wallet', 'The {co} wallet app was unavailable for hours. Holders could not move coins and said so loudly.'],
    ['{co} bridge stalls', 'Transfers between networks were held up by a fault. {ceo} said funds are safe and that it should be fixed "soon-ish".'],
  ],
  uncertain: [
    ['{co} schedules network upgrade', 'The team will change how {tk} is processed next week. {ceo} said it should go smoothly, then deleted the post.'],
    ['{co} tests new token rules', 'A trial of different fees on {tk} started on a small scale. Results will be shared "eventually".'],
  ],
};

const financial: TemplateSet = {
  positive: [
    ['Whale buys {n} thousand {tk}', 'A single wallet bought a large pile of {co} in one go. Smaller traders followed the trail and the price jumped.'],
    ['{co} treasury adds liquidity', 'The community treasury added fresh funds to the {tk} pool, making large trades smoother.'],
    ['{co} lists on a bigger exchange', 'A major trading site added {tk} to its list this morning. Volume climbed straight away.'],
  ],
  negative: [
    ['Whale dumps {n} thousand {tk}', 'One wallet sold a large amount of {co} at once. The price slid and several smaller holders followed it down.'],
    ['{co} team unlocks tokens', 'A batch of {tk} that had been locked became tradable today, and holders fear it will be sold.'],
    ['{co} liquidity pool drained by {pct}%', 'A large withdrawal from the {tk} pool left the market thin. Even small orders now move the price.'],
  ],
  uncertain: [
    ['Big wallet moves {co} between accounts', 'On-chain trackers saw a large amount of {tk} change wallets. Nobody knows if it is a sale or a tidy-up.'],
    ['{co} treasury to publish accounts', '{ceo} promised a full list of treasury movements "when it is ready". Traders are waiting.'],
  ],
};

const analyst: TemplateSet = {
  positive: [
    ['{firm} calls {co} "the next big thing"', 'The note, written in all capital letters, says {tk} is "undervalued by a lot". The firm owns some.'],
    ['Chart watchers see breakout in {tk}', 'Technical traders spotted a pattern in {co} and called it a breakout. Their followers bought it.'],
    ['Influencer thread rates {co} "10 out of 10"', 'A long thread listed ten reasons to hold {tk}. Seven were jokes, three were numbers.'],
  ],
  negative: [
    ['{firm} warns that {co} is "pure vibes"', 'The note says {tk} has no product, no plan and a lot of followers. The price slid after it appeared.'],
    ['Chart watchers see {tk} breaking down', 'Technical traders say the {co} chart has lost a key level. Their followers sold it.'],
    ['Influencer thread says {co} holders are "cooked"', 'A thread listing ten reasons to sell {tk} was shared widely. Several of them were fair.'],
  ],
  uncertain: [
    ['Analysts split on {co}', 'Some call {tk} a bargain and others call it a trap. {firm} said it is "watching closely", which means nothing.'],
    ['{firm} puts {tk} under review', 'The firm said it would revisit its view on {co} soon. No date was given.'],
  ],
};

const contract: TemplateSet = {
  positive: [
    ['{co} signs merch deal', 'A clothing brand will make hoodies with the {co} mascot. {ceo} called it "the biggest thing since the logo".'],
    ['{co} mascot appears in a popular game', 'A mobile game added the {co} mascot as a character, sending a wave of new players to {tk}.'],
    ['{co} wins sponsorship of a small esports team', 'The team will wear the {co} logo on its shirts. The announcement video was watched {n} thousand times.'],
  ],
  negative: [
    ['Merch partner cancels {co} deal', 'A planned line of {co} merchandise was dropped after the brand got cold feet. {ceo} said another partner is "almost" found.'],
    ['{co} sponsorship deal falls through', 'The esports team ended its agreement with {co} early, citing "a change of colours".'],
  ],
  uncertain: [
    ['{co} hints at brand deal', '{ceo} posted a photo of a contract with the name blacked out. The caption read "soon".'],
    ['{co} mascot in talks for a cartoon', 'A small studio is said to be interested in making a short series about {co}. Nothing is signed.'],
  ],
};

const incident: TemplateSet = {
  negative: [
    ['Exploit drains part of {co} pool', 'An attacker found a weakness in the {tk} contract and took a share of the pool. {ceo} said a fix is under way and "some funds are safe".'],
    ['Rug rumor hits {co}', 'Posts claiming the developers of {tk} are about to leave with the funds spread quickly. {ceo} denied them with a very long thread.'],
    ['Fake {co} airdrop empties wallets', 'A scam site pretending to give away {tk} stole coins from users who connected their wallets. {co} warned its followers.'],
    ['Social account of {co} hacked', 'Attackers took over the {co} account and posted a link to a fake site. Traders sold before it was removed.'],
  ],
  uncertain: [
    ['{co} investigates "unusual activity"', 'The team said it noticed strange movements around {tk} and is looking into them. No details were shared.'],
    ['Security researcher flags {co} contract', 'A researcher posted a thread about possible weaknesses in the {tk} contract. {ceo} asked for proof.'],
  ],
};

const demand: TemplateSet = {
  positive: [
    ['{co} trading volume surges', 'Volume in {tk} tripled in a few hours as new buyers arrived. {ceo} thanked "every single degen".'],
    ['{co} holder count hits a record', 'More than {n} thousand wallets now hold {tk}. The community called the number "mildly insane".'],
    ['{co} trends on social media', 'A meme about {co} went around the internet today, and traders rushed to buy before the next wave.'],
  ],
  negative: [
    ['{co} trading volume dries up', 'Few people are buying {tk} today, and the market is thin. Holders blame the weather.'],
    ['Holders leave {co}', 'The number of wallets holding {tk} fell for the sixth day in a row.'],
    ['Attention moves away from {co}', 'Social posts about {co} dropped sharply as the crowd moved to newer coins. Buyers are scarce.'],
  ],
  uncertain: [
    ['{co} volume flickers', 'Trading in {tk} came in bursts today, with long quiet spells between. No clear trend yet.'],
    ['{co} chat is oddly quiet', 'The usual flood of messages slowed for a day. Some think it is the calm before something, others that it is Sunday.'],
  ],
};

/** Company items for a memecoin, by category (the same categories stocks use; `research` is never drawn for a coin). */
export const MEME_COMPANY_TEMPLATES: Readonly<Record<CompanyCategory, TemplateSet>> = {
  product,
  partnership,
  management,
  legal,
  operations,
  financial,
  analyst,
  contract,
  research: product,
  incident,
  demand,
};

export const MEME_LISTING_TEMPLATES: TemplateSet = {
  uncertain: [
    ['{co} ({tk}) starts trading', '{co}, the {prod} coin, was added to the market today. {ceo}, its anonymous developer, promised "no plan, only vibes" and a lot of memes.'],
    ['New coin: {co} debuts as {tk}', 'The coin behind {prod} and {prod2} began trading. Early traders are watching how the first hours go, and the price is already jumping.'],
  ],
};

/** The news about the whole memecoin sector (all coins feel it). */
export const MEME_SECTOR_TEMPLATES: TemplateSet = {
  positive: [
    ['Memecoin mania returns', 'Trading in meme coins surged as new buyers piled in. Social feeds are full of rocket emojis and the smaller coins are moving the most.'],
    ['Big exchange adds several meme coins', 'A large trading site listed a handful of meme coins this week, and the whole sector caught a bid.'],
    ['Crypto fans celebrate a green week', 'Coins of every size rose together as a wave of optimism rolled through the community chats.'],
  ],
  negative: [
    ['Memecoin sell-off spreads', 'Meme coins fell together as traders took profit and went looking for safer places. The smallest coins fell the most.'],
    ['Regulators warn about meme coins', 'Officials in several countries said meme coins carry "extreme risk" and asked exchanges to add warnings.'],
    ['Leverage wipe-out rattles crypto', 'A wave of forced sales hit leveraged traders in meme coins, and the sector slid as a result.'],
  ],
  uncertain: [
    ['Meme coin traders wait for a signal', 'The sector moved sideways as everyone waited for news. Volume is low and the chats are impatient.'],
    ['Debate over what counts as a meme coin', 'Developers and traders argued online about whether the biggest coins still count as jokes. The market shrugged.'],
  ],
};

/** Viral and important-person events for a memecoin ({person} is a fictional influencer; {ceo} is the developer's handle). */
export const MEME_VIRAL_TEMPLATES: Readonly<Record<ViralKind, TemplateSet>> = {
  influencer: {
    positive: [['Streamer {person} goes all in on {co}', '{person}, who has {n} million followers, told viewers {tk} is "the one" during a live stream. The clip is everywhere.']],
    negative: [['Streamer {person} mocks {co}', '{person} called {tk} "a joke that stopped being funny" in a video seen by millions. Holders are furious and some are selling.']],
    uncertain: [['{person} posts a {co} meme without comment', '{person} shared a picture of the {co} mascot to {n} million followers and wrote nothing. Traders are guessing.']],
  },
  clip: {
    positive: [['Clip of {co} mascot goes viral', 'A short video starring the {co} mascot has been watched tens of millions of times, and new buyers are arriving for {tk}.']],
    negative: [['Viral clip shows {prod} breaking', 'A video appearing to show {prod} failing spread fast. {co} said it is looking into it.']],
    uncertain: [['Online argument over {co}', 'Users are split over whether the {co} mascot is genius or terrible. Both sides are posting nonstop.']],
  },
  rumor: {
    positive: [['Rumor: big exchange to list {tk}', 'Unconfirmed posts say a major trading site will add {co} soon. Neither the site nor {ceo} would comment.']],
    negative: [['Rumor: {co} developers are leaving', 'Unverified posts claim {ceo} is about to walk away from {tk}. The team called it "fake news, ha ha".']],
    uncertain: [['Rumors swirl around {co}', 'Unconfirmed chatter about {co} grew all day. {ceo} replied with a single emoji.']],
  },
  investor: {
    positive: [['Famous trader {person} reveals {co} bag', '{person}, known for early bets on small coins, said a large share of their portfolio is {tk}.']],
    negative: [['Famous trader {person} dumps {co}', '{person} told followers the {tk} position is closed and "the party is over".']],
    uncertain: [['Trader {person} says {co} is "interesting"', '{person} would not say whether they own any {tk}. The market read that as it liked.']],
  },
  founder: {
    positive: [['{ceo} drops surprise announcement for {co}', 'In a late-night post {ceo} teased "the big one" for {tk}. The post got {n} thousand replies in an hour.']],
    negative: [['{ceo} posts angry thread, {co} holders worry', 'The developer of {co} lashed out at critics and hinted at stepping back. The price reacted at once.']],
    uncertain: [['{ceo} stays cryptic about {co}', 'The developer replied to a question about {tk} with a photo of a sandwich. Traders are studying it.']],
  },
  whistleblower: {
    positive: [['Insider post clears the air around {co}', 'A former team member wrote that {tk} is being run honestly and that the rumours were false.']],
    negative: [['Ex-team member makes claims about {co}', 'A former helper alleges that the {tk} treasury has been used for things other than the project. {ceo} denied it.']],
    uncertain: [['Former helper posts about {co}', 'A long, unverified post about how {tk} is run went around. The team disputes it.']],
  },
  official: {
    positive: [['Minister {person} praises {sector} traders', 'A widely shared speech by {person} signaled that the government may welcome innovation in the {sector} area.']],
    negative: [['Minister {person} threatens crackdown on {sector} coins', '{person} said coins like these may face tougher rules soon, in remarks that spread fast online.']],
    uncertain: [['Minister {person} comments on {sector} coins', 'A short remark by {person} about the {sector} area sent traders rushing to read between the lines.']],
  },
};

