// More wordings for the memecoin news (memeNews.ts has the first batch). Same format: [headline, body] with {slots}; every coin, handle and project
// named here is invented. Joined to the first batch by templateSets.ts; the extra ones go at the end of each list. The sector stories use no {slots}
// and every partnership story names the other coin with {peer}.

import type { CompanyCategory, TemplateSet, ViralKind } from './newsText';

const product: TemplateSet = {
  positive: [
    [`{co} dev drops surprise update for {prod}`, `{ceo} pushed a big update to {prod} without warning. Holders of {tk} are calling it the best day in weeks.`],
    [`{prod} passes {n} thousand users`, `The {co} community cheered as {prod} crossed a new milestone. {ceo} promised free memes for everyone.`],
    [`{co} shows off {prod2} demo`, `A short video of {prod2} working on the first try went around the chats. Traders of {tk} liked what they saw.`],
  ],
  negative: [
    [`{co} update breaks {prod}`, `Users said the newest update left {prod} unusable. {ceo} asked everyone to "please stop screaming" while a fix is made.`],
    [`{co} pushes back {prod2} launch`, `The date for {prod2} moved again with no new one in sight. Holders of {tk} are running out of jokes.`],
    [`Testers call {prod} "a rough draft"`, `Early users of {prod} listed problem after problem. {co} said feedback is welcome and that "rough drafts are a form of art".`],
  ],
  uncertain: [
    [`{co} hints at new {prod2} feature`, `{ceo} posted a blurry screenshot of {prod2} with a question mark. Nobody can say what it shows.`],
    [`{co} asks holders what to build next`, `{ceo} opened a poll on {prod}, {prod2} and "something else". Results are not due until tomorrow.`],
  ],
};

const partnership: TemplateSet = {
  positive: [
    [`{co} and {peer} swap mascots for a day`, `The two communities traded avatars in a stunt that went around the internet. Both charts turned green.`],
    [`{co} joins {peer} in a charity stream`, `Holders of {tk} and {peer} raised money together on a live stream. {ceo} said the crossover "made everyone nicer".`],
    [`{peer} team praises {co} in public thread`, `The developers of {peer} called {co} "the funniest project around". Traders of {tk} took it as a sign of friendship.`],
  ],
  negative: [
    [`{co} and {peer} cancel joint event`, `Both teams blamed the other for pulling out of a planned event. Holders of {tk} are not amused.`],
    [`{peer} fans spam {co} chat`, `A raid from the {peer} community filled the {co} chat with jokes at its expense. Some holders left in protest.`],
    [`{co} accuses {peer} of copying its mascot`, `{ceo} posted side-by-side pictures. The {peer} team said the likeness is "pure coincidence".`],
  ],
  uncertain: [
    [`{co} and {peer} developers seen chatting`, `A screenshot of a private chat between the two teams went around. It shows only a handshake emoji.`],
    [`{co} polls holders about a deal with {peer}`, `{ceo} asked the community whether to work with {peer}. The vote is open for the next day.`],
  ],
};

const management: TemplateSet = {
  positive: [
    [`{ceo} promises to "never sell" {tk}`, `The developer of {co} wrote a long post about staying for the long run. Holders shared it with hearts.`],
    [`{co} names community council`, `Five longtime holders of {tk} will now help decide what {co} does next. {ceo} called it "power to the memes".`],
    [`{ceo} hosts marathon stream for {co} holders`, `The developer answered questions for six hours straight. The mood in the {tk} chat improved a lot.`],
  ],
  negative: [
    [`{ceo} deletes old posts about {co}`, `Several early messages from the developer of {tk} vanished overnight. The community noticed and is not calm.`],
    [`{co} team member quits in a huff`, `A core helper left the project after what looked like a fight in the chat. Holders of {tk} are nervous.`],
    [`{ceo} blames "haters" for {co} slump`, `The developer's angry post did not go down well. Some holders called it the wrong tone and sold.`],
  ],
  uncertain: [
    [`{ceo} goes on vacation, says {co} will "run itself"`, `The developer posted a photo of a beach and the words "back soon". Traders of {tk} are split on what that means.`],
    [`{co} team drops hint of "major changes"`, `A post from {ceo} said everything will be different soon. It did not say how.`],
  ],
};

const legal: TemplateSet = {
  positive: [
    [`Lawyers say {co} is "probably fine"`, `A legal review of {tk} found no obvious problems. {ceo} framed the letter and posted it.`],
    [`Court dismisses claim against {co}`, `A judge threw out a complaint about {tk}. The {co} community called it the funniest verdict of the year.`],
  ],
  negative: [
    [`{co} named in complaint to regulator`, `A complaint filed by a group of traders asks the watchdog to look at how {tk} was sold. {ceo} said the team has "nothing to hide".`],
    [`Exchange delists {co} after review`, `A trading site said {tk} no longer meets its rules and will remove it. Holders were left looking for other places to trade.`],
    [`{co} receives legal letter over name`, `A company says the name {co} is too close to its own. {ceo} called the letter "a compliment".`],
  ],
  uncertain: [
    [`{co} asks court for clarity`, `The team of {tk} filed a request for a ruling on the coin's status. The answer could take months.`],
    [`Regulator publishes questions on coins like {co}`, `A watchdog asked the public for views on coins such as {tk}. No rules have been proposed yet.`],
  ],
};

const operations: TemplateSet = {
  positive: [
    [`{co} slashes transaction times`, `A quiet upgrade made {tk} transfers confirm in seconds. Traders spent the morning testing it.`],
    [`{co} adds new wallet features`, `The {co} wallet now supports easier sending and a dark mode. {ceo} said "we did what you asked".`],
    [`{co} partners with a wallet maker for easier buying`, `Holders can now buy {tk} directly in a popular wallet app. New buyers started arriving the same hour.`],
  ],
  negative: [
    [`{co} site goes down for hours`, `The {co} website and wallet link were unavailable during a busy trading spell. {ceo} blamed "a cat on the server".`],
    [`Transfers of {tk} delayed by fault`, `A fault slowed down sending {co} between wallets. {ceo} said funds are safe and a fix is on the way.`],
    [`Fees on {co} spike during rush`, `Heavy trading made fees for {tk} jump. Small holders said they were priced out for the day.`],
  ],
  uncertain: [
    [`{co} plans maintenance window`, `The team will pause some features of {tk} for a few hours. {ceo} said trading should not be affected, "probably".`],
    [`{co} tests new wallet design`, `A small group of holders can try a redesigned wallet. Reactions in the {tk} chat are mixed.`],
  ],
};

const financial: TemplateSet = {
  positive: [
    [`Wallet tracker shows {co} whales accumulating`, `On-chain data suggests several big wallets have been adding {tk} for days. Smaller traders noticed and followed.`],
    [`{co} treasury buys back {tk}`, `The community treasury used some of its funds to buy {co} off the market. Holders called it "a cozy floor".`],
    [`{co} adds second trading pair`, `A new pair makes {tk} easier to buy with more coins. Volume rose within the hour.`],
  ],
  negative: [
    [`Large holder moves {n} thousand {tk} to exchange`, `A big transfer of {co} landed at a trading site and traders feared a sale. The price slid before anything was sold.`],
    [`{co} treasury sells part of its stash`, `The community treasury sold some {tk} to pay for "things". Holders asked what those things were.`],
    [`Funding rate turns negative on {tk}`, `Traders betting against {co} outnumber those betting for it. The price is feeling the pressure.`],
  ],
  uncertain: [
    [`Unknown wallet buys and sells {co} in the same hour`, `Trackers cannot decide if the wallet is a bot or a bored human. {tk} swung both ways.`],
    [`{co} considers a token split`, `{ceo} floated the idea of changing how many {tk} exist. Holders cannot agree on whether it helps.`],
  ],
};

const analyst: TemplateSet = {
  positive: [
    [`{firm} adds {co} to its "wild ride" list`, `The note says {tk} could do well if the mood in the market stays good. It also says the chart "looks like a heart rate".`],
    [`Chart watchers see {tk} holding a key level`, `Technical traders say the {co} chart is staying above an important line. Their followers bought more.`],
    [`Influencer calls {co} "the cutest coin of the year"`, `A post praising the {co} mascot drew thousands of replies. Some of them were about the price.`],
  ],
  negative: [
    [`{firm} sees "limited upside" for {co}`, `The note says the story behind {tk} is already priced in. Traders took it as a sell signal.`],
    [`Chart watchers warn of a lower low in {tk}`, `Technical traders see the {co} chart heading for a drop. Their followers sold first and asked questions later.`],
    [`Influencer says {co} is "past its peak"`, `A video about the best days of {tk} being over was watched {n} thousand times. Holders argued in the replies.`],
  ],
  uncertain: [
    [`{firm} takes no view on {co}`, `The firm said it is not ready to rate {tk} either way. Traders found this unhelpful.`],
    [`Chart watchers cannot read {tk}`, `The {co} chart is moving in a way that fits every pattern at once. Analysts agreed to disagree.`],
  ],
};

const contract: TemplateSet = {
  positive: [
    [`{co} mascot lands cameo in a music video`, `A pop video showed the {co} mascot for a few seconds, and {tk} traders noticed at once.`],
    [`{co} signs deal with a snack brand`, `A snack company will put the {co} mascot on its packets. {ceo} said "we are officially food".`],
    [`{co} partners with a popular podcast`, `A podcast with a large audience will talk about {tk} every week. Listeners started buying within hours.`],
  ],
  negative: [
    [`Brand ends {co} partnership`, `A company that planned to use the {co} mascot pulled out. {ceo} said there are "plenty of other mascots in the sea".`],
    [`{co} billboard plan falls through`, `A planned advert for {tk} was canceled after a payment dispute. Holders were hoping for a big sign in the city.`],
    [`Streamer drops {co} sponsorship`, `A streamer ended their deal with {co} after a bad week for the coin. {ceo} thanked them "for the memories".`],
  ],
  uncertain: [
    [`{co} teases deal with a game studio`, `{ceo} posted a screenshot that includes the {co} mascot in a game menu. It may be a joke.`],
    [`Brand asks about licensing the {co} mascot`, `A company approached {co} about using its mascot. {ceo} said "talks are talks" and left it there.`],
  ],
};

const incident: TemplateSet = {
  negative: [
    [`Fake {co} website steals from holders`, `Scammers built a copy of the {co} site and took coins from people who connected their wallets. {ceo} warned everyone to check the address.`],
    [`Developer wallet of {co} flagged by tracker`, `A tracking account claimed the {tk} developer wallet sent coins somewhere strange. {ceo} said it was "just a test".`],
    [`Bot attack hits {co} sale`, `Bots bought most of a limited {tk} drop in a few seconds. Real holders were left angry and empty-handed.`],
    [`Phishing links flood {co} chat`, `Scam messages pretending to be from {ceo} spread across the {co} community. Moderators are cleaning up.`],
  ],
  uncertain: [
    [`{co} warns of suspicious accounts`, `The team said fake {tk} accounts are circulating and asked holders to be careful. No losses were reported.`],
    [`Odd transfers spotted on {co} contract`, `Trackers saw a string of small, strange transfers on the {tk} contract. {ceo} said it is being checked.`],
    [`{co} pauses trading while it checks a bug`, `The team briefly paused {tk} trading to look at what it called "a weird number". It resumed after a short while.`],
  ],
};

const demand: TemplateSet = {
  positive: [
    [`{co} chat hits record activity`, `The {tk} community chat had more messages today than ever before. {ceo} said the mods "need a nap".`],
    [`New wave of buyers discovers {co}`, `A video about {tk} reached a new audience and trading picked up quickly.`],
    [`{co} jumps up the trending list`, `Traders searching for the next hot coin found {tk} near the top. Volume followed.`],
  ],
  negative: [
    [`{co} chat goes quiet`, `Messages in the {tk} community fell to a trickle. Traders say the mood is "flat".`],
    [`Sellers outnumber buyers in {co}`, `More traders want out of {tk} than want in. The price has been drifting for hours.`],
    [`{co} falls off the trending list`, `The coin dropped out of the top charts after a week at the top. Holders are watching the clock.`],
  ],
  uncertain: [
    [`{co} volume swings wildly`, `Trading in {tk} spiked and sank several times in one day. Nobody can say who was buying.`],
    [`Poll asks if {co} is "still cool"`, `The vote is close. {ceo} promised to accept the result "with grace and memes".`],
  ],
};

/** More coin stories by category (research is never drawn for a coin, so it has none here). */
export const MORE_MEME_COMPANY_TEMPLATES: Readonly<Record<CompanyCategory, TemplateSet>> = {
  product,
  partnership,
  management,
  legal,
  operations,
  financial,
  analyst,
  contract,
  research: {},
  incident,
  demand,
};

export const MORE_MEME_LISTING_TEMPLATES: TemplateSet = {
  uncertain: [
    [`{co} ({tk}) joins the market`, `The coin built around {prod} began trading this morning. Its developer {ceo} welcomed new holders with a very long emoji.`],
    [`New listing: {co} arrives as {tk}`, `{co} started trading today with {prod} as its big idea. Early traders are testing the market and prices are bouncing.`],
    [`{tk} opens for trading`, `The {co} coin, the project behind {prod}, was listed today. {ceo} said the plan is "to have fun and see what happens".`],
    [`{co} makes its debut`, `A new coin called {co} is now on the market. The first hour was busy, and nobody knows what comes next.`],
  ],
};

/** More stories about the whole memecoin sector (no slots). */
export const MORE_MEME_SECTOR_TEMPLATES: TemplateSet = {
  positive: [
    [`Meme coins rally as social feeds heat up`, `Posts about coins are everywhere, and prices climbed across the board. Traders say the mood is the best in weeks.`],
    [`New wave of buyers enters meme coins`, `Fresh money arrived in the sector this week, with the smaller coins gaining the most.`],
    [`Crypto influencers turn bullish on meme coins`, `A string of well-known accounts said they like the sector right now, and followers rushed to join in.`],
    [`Trading volume in meme coins hits a monthly high`, `Busy markets lifted most coins together as traders jumped from one story to the next.`],
    [`Meme coin traders celebrate a quiet, steady climb`, `After weeks of wild swings, prices moved up gently. The chats are happy, and a little suspicious.`],
  ],
  negative: [
    [`Meme coins slide as the crowd takes profits`, `Prices fell across the sector after a strong run. The smallest coins dropped the most.`],
    [`Fear spreads through meme coin chats`, `A bad day for some coins turned into a bad day for most. Traders traded sad memes.`],
    [`Big exchange warns about meme coin risk`, `A large trading site posted a notice about the dangers of coins with no product, and the sector wobbled.`],
    [`Meme coin volume drops as traders look elsewhere`, `Interest moved to other markets this week, and thin trading made the price swings bigger.`],
    [`Scam story shakes trust in meme coins`, `A fraud case involving a different coin made the news, and buyers pulled back across the sector.`],
  ],
  uncertain: [
    [`Meme coin traders divided on what comes next`, `Half the chats say a rally is coming and the other half say a drop. The market stayed in a narrow range.`],
    [`Sector rests after a wild week`, `Prices stayed roughly where they were as traders took a breather. No one is sure how long it will last.`],
    [`Rumors of rule changes unsettle meme coin traders`, `Posts claim officials may look at the sector soon, but nothing has been confirmed.`],
    [`Meme coin prices move in opposite directions`, `Some coins rose and others fell today, which left the sector looking confused.`],
  ],
};

/** More viral and important-person stories for a memecoin. */
export const MORE_MEME_VIRAL_TEMPLATES: Readonly<Record<ViralKind, TemplateSet>> = {
  influencer: {
    positive: [
      [`{person} wears a {co} shirt on stream`, `{person}, who has {n} million followers, wore a {co} shirt for a whole broadcast. Viewers went looking for {tk}.`],
      [`{person} calls {co} "my favorite coin"`, `In a post shared thousands of times, {person} said the {tk} community is the nicest online. New buyers arrived.`],
    ],
    negative: [
      [`{person} says {co} mascot is "overrated"`, `A video from {person} making fun of the {co} mascot got {n} million views. Some holders took it personally and sold.`],
      [`{person} warns fans to be careful with {co}`, `{person} told viewers that coins like {tk} can fall fast. The comments section turned into a debate.`],
    ],
    uncertain: [
      [`{person} follows the {co} account`, `{person} started following {co} and nothing else happened. Traders are reading into it anyway.`],
      [`{person} asks fans if {co} is worth a look`, `A poll from {person} about {tk} drew thousands of votes. The result is still too close to call.`],
    ],
  },
  clip: {
    positive: [
      [`{co} meme becomes a sound on social video`, `A short clip about {co} became a popular sound, and thousands of people made their own versions.`],
      [`Video of {prod} working goes viral`, `A clip showing {prod} doing something clever drew millions of views. {tk} saw new buyers.`],
    ],
    negative: [
      [`Clip mocking {co} holders goes viral`, `A parody video about {tk} holders spread fast and the comments were not kind. Some holders got out.`],
      [`Video shows {co} chat in chaos`, `A screen recording of the {co} community arguing went around the internet. The price dipped.`],
    ],
    uncertain: [
      [`Strange {co} clip puzzles viewers`, `A short video with the {co} mascot and no explanation was watched millions of times. People are guessing what it means.`],
      [`Meme war breaks out over {co}`, `Users are sharing jokes for and against {tk} at once. Nobody knows which side is winning.`],
    ],
  },
  rumor: {
    positive: [
      [`Rumor: celebrity holds {co}`, `Unverified posts say a famous person bought {tk}. {ceo} replied with a winking face.`],
      [`Rumor: {co} to appear in a major game`, `Posts claim the {co} mascot will be added to a popular title. The studio has not said anything.`],
    ],
    negative: [
      [`Rumor: exchange to delist {co}`, `Unconfirmed posts say a trading site will stop trading {tk}. The site did not respond to questions.`],
      [`Rumor: big wallet plans to sell all {tk}`, `A post claims a major holder is about to leave {co}. {ceo} called it "fear, uncertainty and doubt".`],
    ],
    uncertain: [
      [`Rumor: {co} to announce something on Friday`, `A post said the team has a big surprise ready. {ceo} did not deny or confirm it.`],
      [`Rumor: {co} developers are working on a secret project`, `Posts claim the team is building something it has not told anyone about. {ceo} said only "maybe".`],
    ],
  },
  investor: {
    positive: [
      [`Veteran trader {person} calls {co} "undervalued"`, `{person} said the {tk} chart looks ready for more in an interview that spread across social media.`],
      [`{person} posts a screenshot showing {tk} holdings`, `The picture shows a large stack of {co}. Followers rushed to copy the trade.`],
    ],
    negative: [
      [`{person} says {co} is "too risky" for now`, `{person} told followers they are sitting out {tk} until it calms down. Many followed that example.`],
      [`Trader {person} closes {co} position`, `{person} posted that they sold all their {tk} and moved on. Holders replied with worried emojis.`],
    ],
    uncertain: [
      [`{person} asks "is {tk} the next big one?"`, `The post, written with no answer attached, got {n} thousand replies. Traders argued for hours.`],
      [`{person} hints at a new bet on {co}`, `{person} said they are "looking closely" at {tk}. They would not say if they have bought any.`],
    ],
  },
  founder: {
    positive: [
      [`{ceo} announces {co} "season two"`, `The developer of {tk} posted a roadmap for a new chapter. The community chat filled with fireworks.`],
      [`{ceo} says {co} will give back to holders`, `A post from {ceo} promised rewards for long-term holders of {tk}. Details are to come.`],
    ],
    negative: [
      [`{ceo} says {co} is "just a joke" after all`, `A late-night post from the developer of {tk} downplayed the project, and holders were stunned.`],
      [`{ceo} picks a fight with other coin developers`, `A heated thread between {ceo} and others turned ugly. Holders of {co} wish it had stayed quiet.`],
    ],
    uncertain: [
      [`{ceo} posts "big news soon" about {co}`, `The developer of {tk} gave no hint of the subject. The post got {n} thousand replies in minutes.`],
      [`{ceo} changes the {co} logo`, `The developer swapped the logo without comment. Some holders love it and some hate it.`],
    ],
  },
  whistleblower: {
    positive: [
      [`Former team member defends {co}`, `A former helper wrote a long thread saying the claims about {tk} were wrong. The mood in the {co} chat lifted.`],
      [`Audit by volunteer finds {co} treasury in order`, `A community member went through the {tk} treasury and found nothing wrong, and shared the results.`],
    ],
    negative: [
      [`Former moderator claims {co} team is "not what it seems"`, `A thread by a former moderator makes serious claims about {tk}. {ceo} denied all of it.`],
      [`Leaked chat suggests {co} team plans to sell`, `A screenshot said to come from the {co} developer chat went around. The team called it fake.`],
    ],
    uncertain: [
      [`Anonymous account makes claims about {co}`, `A new account posted a long thread about how {tk} is run. There is no proof, and the team will not comment.`],
      [`Former helper asks hard questions about {co}`, `A post asks where some {tk} funds went. {ceo} promised to reply "properly" soon.`],
    ],
  },
  official: {
    positive: [
      [`Minister {person} calls {sector} coins "a harmless hobby"`, `A widely shared remark from {person} suggested the government is not planning a crackdown. Traders breathed out.`],
      [`Official {person} meets {sector} coin developers`, `{person} said the talks were friendly, in a clip that spread online. The sector perked up.`],
    ],
    negative: [
      [`Official {person} wants warnings on {sector} coins`, `{person} said buyers should be told clearly about the risks, in remarks that were widely shared. Prices slipped.`],
      [`Minister {person} says {sector} coins "need rules"`, `A speech by {person} hinted that tougher rules are on the way for the whole area. Traders sold first.`],
    ],
    uncertain: [
      [`Minister {person} says "we are watching" {sector} coins`, `The short remark by {person} did not say what, if anything, will change. Traders are reading it both ways.`],
      [`Official {person} asks for a report on {sector} coins`, `{person} asked advisers for a study of the area. It is due in a few months.`],
    ],
  },
};
