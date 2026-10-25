// A third batch of wordings for the memecoin news (memeNews.ts is the first, memeNewsMore.ts the second). Same format: [headline, body] with {slots};
// every coin, handle, project and person named here is invented. Joined to the others by memeNews.ts (templateSets.ts `plus`); the new ones sit at the END
// of each list, so the draws that decide a story's direction, size and timing never change (tests/news-more.test.ts). The sector stories use no {slots},
// every partnership story names the other coin with {peer}, the stories of an official name no coin, and nothing here talks like a stock (no earnings,
// dividends, patents, quarters...).

import type { CompanyCategory, TemplateSet, ViralKind } from './newsText';

const product: TemplateSet = {
  positive: [
    [`{co} dev ships {prod} beta to all holders`, `{ceo} opened the beta of {prod} to everyone holding {tk}. The first reviews called it "better than expected, which is a low bar".`],
    [`{prod} gets a glow-up from the {co} team`, `A fresh look and faster loading made {prod} the talk of the {tk} chat. {ceo} thanked the interns, who do not exist.`],
    [`{co} fans build their own tools for {prod}`, `Volunteers released three add-ons for {prod} in one weekend. Traders of {tk} read it as a sign of a living community.`],
  ],
  negative: [
    [`{prod} loses saved settings after update`, `An update to {prod} wiped the saved choices of many users. {ceo} said the data is "in a better place" and promised a fix.`],
    [`{co} swears {prod2} lands "by Friday"`, `The date slipped yet again, and the countdown joke in the {tk} chat has stopped being funny.`],
    [`Users report odd fees in {prod}`, `Several holders of {tk} noticed charges they did not expect. {ceo} called it "a feature we forgot to announce".`],
  ],
  uncertain: [
    [`{co} teases a secret feature for {prod}`, `{ceo} posted a clip of {prod} with half the screen blacked out. The {tk} chat has {n} theories and no facts.`],
    [`{co} puts {prod2} to a holder vote`, `Holders of {tk} can decide whether {prod2} comes next or whether the team builds "something weirder". The vote closes tomorrow.`],
  ],
};

const partnership: TemplateSet = {
  positive: [
    [`{co} and {peer} launch a shared meme contest`, `Holders of both coins are posting entries for a prize pool. The two charts rose together as the posts spread.`],
    [`{peer} team adds {co} to its wallet list`, `Users of the {peer} wallet can now hold {tk} with one tap. {ceo} thanked "our friends next door".`],
    [`{co} and {peer} agree to a "friendship pact"`, `The two developers signed a joke contract promising never to dump on each other. Traders took the joke seriously and bought.`],
  ],
  negative: [
    [`{co} and {peer} argue over who copied whom`, `Both communities posted old screenshots as proof. The shared chat was closed after an hour of insults.`],
    [`{peer} whales sell {tk} in protest`, `Large holders from the {peer} community dumped {co} after a spat between the two teams. The price took the hit.`],
    [`{co} loses its spot on a {peer} list`, `The {peer} team removed {co} from a list of friendly coins without explanation. {ceo} said he "does not care" in four separate posts.`],
  ],
  uncertain: [
    [`{co} and {peer} change to matching avatars`, `The two projects now use almost the same picture. Neither team would say whether it is a joke or a merger.`],
    [`{ceo} meets the {peer} developer for "a coffee"`, `A photo of the two at a cafe went around the chats. Both coins wobbled while traders guessed what was discussed.`],
  ],
};

const management: TemplateSet = {
  positive: [
    [`{ceo} publishes a plan for {co} with dates`, `The plan has real dates and real names, which is rare. Holders of {tk} printed it out and pinned it to their walls.`],
    [`{co} team burns some of its own coins`, `The developers destroyed part of their own {tk} to show they are not leaving. The community called it "skin in the game, literally".`],
    [`New moderators calm the {co} chat`, `{ceo} added helpers who actually answer questions. The {tk} chat is quiet for the first time in months.`],
  ],
  negative: [
    [`{ceo} sells a little {tk} "for rent"`, `On-chain records show the developer of {co} cashed out a small amount. The explanation was a broken laptop and a high rent, and nobody found it funny.`],
    [`{co} developers argue in public`, `Two core members of the {co} team traded blame in the chat. Holders of {tk} took sides, then took profits.`],
    [`{ceo} changes the {co} plan again`, `The new plan has nothing in common with the last one. Holders asked whether the old one was ever real.`],
  ],
  uncertain: [
    [`{ceo} says a "big reveal" is coming for {co}`, `The developer would only say that it will happen "at a time". Traders of {tk} are checking the clock.`],
    [`{co} looks for a new lead moderator`, `The current one is stepping back to "touch grass". Nobody knows who will take over.`],
  ],
};

const legal: TemplateSet = {
  positive: [
    [`Regulator closes its file on {co}`, `A watchdog said it has no more questions about {tk}. {ceo} posted a thumbs-up and a very long cheer.`],
    [`Lawyer reads {co} and finds "mostly jokes"`, `A legal expert went through the {tk} materials and said the worst thing in them is the humor. Holders took that as good news.`],
    [`{co} wins a dispute over its name`, `A group that claimed the {co} name gave up after a short exchange of letters. {ceo} celebrated with a meme of a trophy.`],
  ],
  negative: [
    [`Watchdog asks {co} to remove "guaranteed gains" posts`, `A regulator said some posts about {tk} promised results nobody can promise. {ceo} deleted them and blamed an intern.`],
    [`{co} hit with a "cease and desist" letter`, `A company wants the {co} team to stop using its logo style. {ceo} replied with a drawing of a cat.`],
    [`Exchange pauses new {tk} deposits for review`, `A trading site stopped taking new {co} deposits while it checks the coin. Holders were told the review "takes a few days".`],
  ],
  uncertain: [
    [`Lawmaker mentions {co} in a speech`, `A politician used {tk} as an example of "a strange new market". Traders could not tell if it was praise or a warning.`],
    [`{co} team hires a lawyer "just in case"`, `{ceo} said the hire is routine. The {tk} chat is checking every word for hidden meaning.`],
  ],
};

const operations: TemplateSet = {
  positive: [
    [`{co} network handles a record trading day`, `The {tk} network processed more trades than ever and did not slow down. {ceo} called it "boring, which is the point".`],
    [`{co} adds a one-tap buy button`, `New buyers can now get {tk} without a long setup. The first hour brought a rush of beginners.`],
    [`{co} fixes the bug that annoyed everyone`, `A long-standing glitch in the {co} wallet is gone. Holders threw a small party in the chat.`],
  ],
  negative: [
    [`{co} wallet shows wrong balances`, `Some holders saw odd numbers in the {co} wallet for an hour. {ceo} said the money is fine and only the screen was wrong.`],
    [`Failed upgrade slows the {tk} network`, `A rushed change left the {co} network crawling. Trades took minutes to go through.`],
    [`{co} support chat floods with complaints`, `Hundreds of holders wrote at once about stuck transfers. The team answered with a single sticker.`],
  ],
  uncertain: [
    [`{co} moves to a new server provider`, `The team said the switch would be invisible. Holders of {tk} are watching for hiccups.`],
    [`{co} announces a surprise "test day"`, `{ceo} said some features will break on purpose for a day. Nobody is sure which ones.`],
  ],
};

const financial: TemplateSet = {
  positive: [
    [`Big wallet locks {n} thousand {tk} for a year`, `A large holder of {co} put coins in a lock that cannot be opened for twelve months. Fewer coins on the market made the price firmer.`],
    [`{co} liquidity gets a new backer`, `A group of traders added money to the {tk} pool in exchange for a share of the fees. Big orders now move the price less.`],
    [`Trading bots start quoting {co}`, `Market-making bots began posting prices for {tk} around the clock. Spreads got tighter and volume rose.`],
  ],
  negative: [
    [`Early buyers cash out of {co}`, `Wallets that bought {tk} on the first day sold most of their coins. Newer holders watched the price slide.`],
    [`Sudden fee change hurts {co} liquidity`, `Providers pulled money from the {tk} pool after the fees were cut. Spreads widened and the price jumped around.`],
    [`{co} loses a trading pair`, `A trading site removed one of the pairs for {tk}. Buying and selling got harder at once.`],
  ],
  uncertain: [
    [`Large {tk} order sits unfilled for hours`, `Someone placed a huge order for {co} below the market and left it. Traders cannot decide if it is a floor or a trap.`],
    [`Wallet tied to {co} team makes a test transfer`, `A tiny amount of {tk} moved between two wallets linked to the team. Trackers are asking what comes next.`],
  ],
};

const analyst: TemplateSet = {
  positive: [
    [`{firm} puts {co} on its "to watch" shelf`, `The firm wrote that {tk} has "a stronger crowd than most". It did not mention the price.`],
    [`Chart watchers draw a rising line under {tk}`, `Technical traders say the {co} chart keeps making higher lows. Their followers started buying dips.`],
    [`Podcast host calls {co} "underrated"`, `A popular host spent ten minutes praising the {co} mascot and two on the price. Listeners bought {tk} anyway.`],
  ],
  negative: [
    [`{firm} sees "no reason" to own {co}`, `The note says {tk} has nothing but a mascot and a mood. Sellers took the hint.`],
    [`Chart watchers draw a falling line over {tk}`, `Technical traders point to lower highs on the {co} chart. Their followers stopped buying dips.`],
    [`Video essay calls {co} "a very expensive joke"`, `A long video about {tk} spread fast in the trading chats. Some holders agreed and sold.`],
  ],
  uncertain: [
    [`Analysts argue over what {co} is worth`, `One camp says {tk} is a joke and the other says it is art. Neither could name a number.`],
    [`{firm} promises a report on {co} "soon"`, `The firm said it will weigh in on {tk} after more research. Traders are waiting for it.`],
  ],
};

const contract: TemplateSet = {
  positive: [
    [`{co} mascot gets its own sticker pack`, `A messaging app added a pack of {co} stickers, and it climbed the charts. {tk} followed it.`],
    [`Cafe chain names a drink after {co}`, `A small chain launched a "{co} latte" for a week. {ceo} drank three on camera.`],
    [`{co} joins a streamer's sponsor list`, `A streamer with a loyal crowd will show the {tk} logo during every broadcast. New buyers appeared in the first hour.`],
  ],
  negative: [
    [`Sponsor pulls {co} ad after complaints`, `A brand removed its {co} promotion after viewers called it "a bit much". {ceo} said the ad was "ahead of its time".`],
    [`{co} sticker deal ends early`, `The app that carried the {co} stickers dropped the pack. Holders of {tk} noticed fewer new faces.`],
    [`Merch maker delays {co} orders`, `Fans who ordered {co} hoodies were told to wait another month. {ceo} blamed "the weather".`],
  ],
  uncertain: [
    [`{co} mascot spotted on a billboard`, `A photo of a billboard with the {co} mascot spread online. Nobody has claimed it, including {ceo}.`],
    [`{co} asks fans to vote on a brand deal`, `{ceo} listed three offers for {tk} and asked holders to pick one. Two of them are food.`],
  ],
};

const incident: TemplateSet = {
  negative: [
    [`Phishing site copies the {co} page`, `A look-alike site stole coins from holders who clicked a fake link. The {co} team posted warnings in every channel.`],
    [`Bots flood the {co} chat with scam links`, `Thousands of fake accounts posted links to false {tk} giveaways. Moderators banned them as fast as they could.`],
    [`{co} contract bug locks some coins`, `A fault in the {tk} contract froze a number of wallets for hours. {ceo} said a fix is coming and "funds are not lost".`],
    [`Developer wallet of {co} is hacked`, `Attackers got into a wallet tied to the {co} team and moved some {tk}. Holders feared a sale of the stolen coins.`],
    [`Fake {ceo} account promises refunds`, `A copycat account pretending to be the developer of {co} asked holders to send coins to "get them back". Several fell for it.`],
  ],
  uncertain: [
    [`{co} team reports a "small scare"`, `{ceo} said something odd happened around {tk} but gave no details. Traders sold first and asked later.`],
    [`Researchers find odd transfers around {tk}`, `A group of trackers noticed a pattern of small moves in the {co} market. The team asked them for proof.`],
    [`{co} pauses its bridge "to be safe"`, `The team stopped transfers to other networks for a check. {ceo} said it is only a precaution.`],
  ],
};

const demand: TemplateSet = {
  positive: [
    [`{co} gets a flood of new buyers`, `A wave of newcomers found {tk} through a popular video. The order book filled up with small buys.`],
    [`{co} hits a new daily high in trading`, `More {co} changed hands today than on any day this month. {ceo} posted a chart with a lot of green.`],
    [`Fans paint a mural of the {co} mascot`, `A street artist added a huge {co} mascot to a wall, and the photo went around. New buyers followed the buzz.`],
  ],
  negative: [
    [`{co} chat loses thousands of members`, `The {tk} community shrank by {n} thousand in a week. Many left after a quiet stretch with no news.`],
    [`Few bids left for {tk}`, `The {co} order book is thin and sellers are waiting for any bid. A single sale moves the price.`],
    [`{co} fades from social feeds`, `Posts about {co} fell sharply as users chased a new craze. Holders of {tk} wait for the next wave.`],
  ],
  uncertain: [
    [`{co} gets attention for the wrong reasons`, `A meme about the {co} mascot went around, but not everyone was laughing. Traders of {tk} cannot tell if it helps.`],
    [`Weekend traders keep {co} busy`, `Volume in {tk} stayed steady while the rest of the market slept. Nobody knows who is on the other side.`],
  ],
};

export const MORE2_MEME_COMPANY_TEMPLATES: Readonly<Partial<Record<CompanyCategory, TemplateSet>>> = {
  product,
  partnership,
  management,
  legal,
  operations,
  financial,
  analyst,
  contract,
  incident,
  demand,
};

export const MORE2_MEME_LISTING_TEMPLATES: TemplateSet = {
  uncertain: [
    [`{tk} joins the market with {co}`, `The new coin {co}, built around {prod}, opened for trading today. {ceo} promised "good vibes, bad ideas".`],
    [`Welcome {co}: a new coin appears`, `{co} began trading as {tk}. The team says {prod} comes first and {prod2} comes "when it comes".`],
    [`{co} opens its doors to traders`, `The {tk} market is open. Early buyers are testing how deep the first prices go.`],
    [`{co} debut draws a curious crowd`, `Traders who like new coins flocked to {tk} in its first minutes. {ceo} said the launch was "a happy accident".`],
    [`New listing: {tk}, the {prod} coin`, `A fresh coin named {co} joined the list. Its developer, {ceo}, wrote that the plan is to have no plan.`],
    [`{co} arrives with a big smile and a small chart`, `{tk} traded for the first time today. With so little history, every move looks huge.`],
  ],
};

/** Follow-ups when a low-credibility viral story about a coin fades (the same shape as MEME_FADE_TEMPLATES in memeNews.ts). */
export const MORE2_MEME_FADE_TEMPLATES: TemplateSet = {
  negative: [
    [`Excitement over {co} cools within a day`, `The rush into {tk} slowed once the jokes ran out. Late buyers are staring at a flat chart.`],
    [`{co} chat moves on to the next craze`, `The crowd that cheered {tk} yesterday is busy with something new. Volume is draining away.`],
    [`Hype post about {co} gets no follow-up`, `Nothing came after the viral post about {tk}, and buyers lost interest.`],
    [`{co} buyers sell into the noise`, `Traders used the viral moment to get out of {tk}. The price is easing back to where it was.`],
  ],
  positive: [
    [`Scare around {co} fades by the evening`, `The alarming posts about {tk} turned out to be a misunderstanding. Buyers came back.`],
    [`Team answers every question about {co}`, `{ceo} spent hours replying to worried holders of {tk}, and the mood improved.`],
    [`Claim about {co} fails a basic check`, `Trackers could not find any trace of what the viral post said about {tk}. The sellers went quiet.`],
    [`Dip buyers return to {co}`, `After the panic passed, traders picked up {tk} at the lower price. The chart is healing.`],
  ],
};

export const MORE2_MEME_SECTOR_TEMPLATES: TemplateSet = {
  positive: [
    [`Small traders pile back into meme coins`, `Small buyers returned to the sector in large numbers, and trading apps reported record sign-ups. The smaller coins led the way.`],
    [`A big streamer talks up meme coins`, `A well-known streamer told viewers that meme coins are "the funniest part of the market". Prices across the sector rose.`],
    [`Meme coins shrug off a weak week for crypto`, `While bigger coins slid, the jokes held up. Traders called it a rotation into fun.`],
    [`New wallet app makes buying meme coins easier`, `A popular app added a one-tap buy for small coins, and beginners arrived in waves. The sector got a lift.`],
  ],
  negative: [
    [`Bad day for crypto drags meme coins down`, `A sharp drop in bigger coins pulled the jokes down with them. The smallest coins fell the most.`],
    [`Exchanges raise fees on small coins`, `Several trading sites made it more costly to trade small meme coins. Volume across the sector dropped.`],
    [`Scam wave makes buyers wary of meme coins`, `A string of fake giveaways and copycat sites scared newcomers away. Buyers across the sector stepped back.`],
    [`Influencers turn on meme coins`, `A group of well-known accounts called the sector "over" in the same week. The sell-off was quick.`],
  ],
  uncertain: [
    [`Meme coin traders wait for the weekend`, `The sector drifted as everyone waited to see what the weekend would bring. Volume is low and tempers are short.`],
    [`Meme coin craze: over, or just resting`, `Posts about the end of the craze and posts about a new one appeared on the same day. The sector moved sideways.`],
    [`Meme coins swing between hope and doubt`, `The sector flipped from green to red three times in a day. Traders could not agree on what to believe.`],
  ],
};

export const MORE2_MEME_VIRAL_TEMPLATES: Readonly<Partial<Record<ViralKind, TemplateSet>>> = {
  influencer: {
    positive: [[`{person} shows off a {co} tattoo`, `{person} told {n} million followers that the {co} mascot is now on their arm. Fans rushed into {tk}.`]],
    negative: [[`{person} says {co} "gave me a headache"`, `{person} told {n} million followers that watching the {tk} chart is not good for anyone's health. Holders of {co} winced.`]],
    uncertain: [[`{person} quietly follows {co} online`, `{person} quietly followed {co} on social media, and {tk} traders are wondering whether it means anything.`]],
  },
  clip: {
    positive: [[`Fan video of {co} gets millions of views`, `A homemade video about {co} made people laugh around the world. New buyers of {tk} are arriving.`]],
    negative: [[`Viral clip mocks the {co} chat`, `A short video making fun of how {tk} holders talk spread fast. The mood around {co} soured.`]],
    uncertain: [[`Mixed reactions to a new {co} clip`, `A video about {co} got a lot of laughs and a lot of groans. Traders of {tk} wait to see which side wins.`]],
  },
  rumor: {
    positive: [[`Rumor says {co} has a secret backer`, `Unconfirmed posts claim a rich supporter is quietly buying {tk}. {ceo} would neither confirm nor deny.`]],
    negative: [[`Rumor says a big {tk} unlock is near`, `Unverified posts claim a large batch of {co} will be released soon. The team called it "old news".`]],
    uncertain: [[`Strange rumor about {co} makes the rounds`, `Nobody can say where the claim about {tk} came from. {ceo} replied with a shrug emoji.`]],
  },
  investor: {
    positive: [[`Trader {person} says {co} is "fun and fair"`, `{person} said {tk} has "good bones for a joke coin". Followers rushed to buy.`]],
    negative: [[`Trader {person} bets against {co}`, `{person} told followers they are betting against {tk}. The price fell as copycats followed.`]],
    uncertain: [[`Trader {person} refuses to talk about {co}`, `{person} closed a livestream when asked about {tk}. Traders took it as a clue, in both directions.`]],
  },
  founder: {
    positive: [[`{ceo} shares a surprise gift for {co} holders`, `The developer posted that something nice is coming for everyone holding {tk}. The post got {n} thousand likes.`]],
    negative: [[`{ceo} says "I might quit" in a late-night post`, `The developer of {co} wrote that the job is "a lot". Holders of {tk} did not sleep well.`]],
    uncertain: [[`{ceo} posts a poem about {co}`, `The developer shared a long poem with no explanation. The {tk} chat is analyzing it line by line.`]],
  },
  whistleblower: {
    positive: [[`Former mod defends {co} in a long thread`, `A former moderator wrote that the team of {tk} always acted fairly. The thread was widely shared.`]],
    negative: [[`Former mod says {co} hid a problem`, `A former moderator claims the {tk} team kept a problem from holders. {ceo} denied it.`]],
    uncertain: [[`Anonymous post about {co} spreads`, `An unsigned post about how {tk} is run went around. The team asked for names and got none.`]],
  },
  official: {
    positive: [[`Minister {person} praises online communities`, `{person} said in a speech that internet communities are "a source of energy" for the economy. Traders of {sector} coins took heart.`]],
    negative: [[`Minister {person} calls {sector} coins "a casino"`, `{person} told reporters that these coins look like gambling to them. Prices in the {sector} area dropped.`]],
    uncertain: [[`Minister {person} orders a study of {sector} coins`, `{person} announced a review of the {sector} area with no deadline. Traders are not sure what to expect.`]],
  },
};
