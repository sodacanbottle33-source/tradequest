// More wordings for the stories about a whole sector, the economy, quarterly reports and viral posts of stocks (newsText.ts has the first batch).
// Same format: [headline, body]. Every company, person and place named here is invented. Joined to the first batch by templateSets.ts; the extra
// ones go at the end of each list. Sector and economy stories use no {slots}. A viral story from an official is about a whole sector, so it uses
// only {person} and {sector}.

import type { SectorId } from './params';
import type { TemplateSet, ViralKind } from './newsText';

/** Extra sector stories (the memecoin sector has its own in memeNewsMore.ts). */
export const MORE_SECTOR_TEMPLATES: Readonly<Partial<Record<SectorId, TemplateSet>>> = {
  tech: {
    positive: [
      [`Cloud providers raise capital spending plans`, `Several large providers said they will spend more on data centers, a boost for companies that supply hardware and software.`],
      [`Cybersecurity budgets climb across industries`, `Companies said they are setting aside more money to protect their systems, supporting demand for security software and services.`],
    ],
    negative: [
      [`Tech buyers push back on rising software prices`, `Customers at several large firms said they are cutting the number of licenses they pay for, which could slow revenue growth for software makers.`],
      [`Chip supply chain faces new delays`, `Shipping problems and a shortage of materials are slowing deliveries of components, leaving some technology makers waiting.`],
    ],
    uncertain: [
      [`Industry group calls for common standards`, `A group of technology leaders asked for shared standards on how devices connect. Analysts said it could help or hinder, depending on who sets the rules.`],
      [`Technology conference ends without major launches`, `The week's big event produced mostly small updates. Observers were split on whether that points to a pause or the calm before a bigger wave.`],
    ],
  },
  ai: {
    positive: [
      [`Hospitals and banks sign up for AI assistants`, `Large employers in healthcare and finance said they will roll out AI tools to thousands of staff, widening the market for AI suppliers.`],
      [`Cost of running AI systems keeps falling`, `New chips and software tricks are making AI workloads cheaper to run, which could open the technology to many more customers.`],
    ],
    negative: [
      [`Power shortages limit growth of AI data centers`, `Several projects were delayed because local grids cannot supply enough electricity, slowing the spread of AI computing.`],
      [`Study finds many AI pilots never reach production`, `A survey said a large share of AI trials were dropped before launch, raising doubts about how quickly spending will pay off.`],
    ],
    uncertain: [
      [`Researchers debate how fast AI is improving`, `Experts disagreed in public about whether recent gains will continue or level off. Companies said they are planning for both outcomes.`],
      [`Governments compare notes on AI oversight`, `Officials from several countries met to discuss common guidelines. No agreement was reached, and the details will be debated for months.`],
    ],
  },
  robotics: {
    positive: [
      [`Factories order record number of industrial robots`, `Manufacturers said labor shortages are pushing them to automate faster, lifting orders for robot makers.`],
      [`Warehouse automation spreads to smaller firms`, `Cheaper machines are letting mid-sized businesses automate picking and packing for the first time.`],
    ],
    negative: [
      [`Robot makers face shortage of key motors`, `A shortage of precision motors and sensors is slowing assembly lines across the robotics industry.`],
      [`Unions press for limits on workplace robots`, `Labor groups in several countries asked for rules on how robots may replace staff, adding uncertainty for the sector.`],
    ],
    uncertain: [
      [`Safety standard for service robots under review`, `Regulators are reviewing safety rules for robots that work near people. Industry groups said the outcome could raise or lower costs.`],
      [`Robotics showcase draws crowds but few orders`, `Visitors packed a trade fair this week, though several exhibitors said buyers remain cautious about spending.`],
    ],
  },
  energy: {
    positive: [
      [`Cold snap lifts demand for heating fuel`, `Colder weather boosted use of gas and heating oil, supporting prices and producers.`],
      [`Refiners report strong margins`, `Refining profits widened as fuel demand held up, which could help companies in the energy industry.`],
    ],
    negative: [
      [`Mild weather cuts demand for heating fuel`, `Warmer than usual temperatures reduced fuel use and weighed on energy prices.`],
      [`Pipeline outage disrupts supply routes`, `A fault on a major pipeline forced producers to reroute shipments, raising costs for some energy firms.`],
    ],
    uncertain: [
      [`Energy firms weigh spending as prices swing`, `Executives said they are unsure how much to invest while prices move up and down from week to week.`],
      [`New export rules proposed for fuels`, `Officials floated limits on fuel exports. Analysts said the effect on energy companies depends on the final details.`],
    ],
  },
  health: {
    positive: [
      [`Hospital admissions rise, boosting care providers`, `More patients are seeking treatment, which analysts said is lifting revenue for healthcare providers.`],
      [`Health regulators speed up review of new treatments`, `A faster approval process could bring new products to market sooner, supporting the healthcare industry.`],
    ],
    negative: [
      [`Insurers push back on treatment prices`, `Large insurers said they will negotiate harder over what they pay for treatments, which could squeeze healthcare margins.`],
      [`Shortage of nurses strains hospitals`, `Staff shortages are forcing some hospitals to cut services, raising costs for healthcare providers.`],
    ],
    uncertain: [
      [`Government launches review of drug pricing`, `Officials said they will study how drugs are priced. Healthcare companies said it is too early to know what changes may follow.`],
      [`Health data sharing rules under discussion`, `Lawmakers are weighing new rules on patient data. Industry groups said the effects could be positive or negative for innovation.`],
    ],
  },
  finance: {
    positive: [
      [`Lending picks up as borrowers return`, `Banks reported more demand for loans from households and firms, which is good for financial companies.`],
      [`Trading volumes climb across markets`, `Busy markets are boosting fee income for exchanges and brokers, according to industry data.`],
    ],
    negative: [
      [`Loan defaults edge higher`, `More borrowers fell behind on payments last quarter, raising concerns for banks and lenders.`],
      [`Regulators propose higher capital buffers`, `Banks may have to hold more money in reserve under new proposals, which could limit lending and profits.`],
    ],
    uncertain: [
      [`Banks wait on central bank for guidance`, `Financial firms said they are holding off on big decisions until policymakers signal their next move.`],
      [`Online lenders test traditional banks`, `New online lenders are winning customers in some areas. Analysts disagree on how much damage this will do to older firms.`],
    ],
  },
  transport: {
    positive: [
      [`Freight volumes grow as shipments pick up`, `Carriers reported busier trucks, trains and ships, which analysts said is good for transportation companies.`],
      [`Travel demand surges ahead of holiday season`, `Bookings for flights and trains are rising quickly, lifting hopes for transport operators.`],
    ],
    negative: [
      [`Fuel costs squeeze transport operators`, `Rising fuel prices are cutting into the margins of airlines, shippers and trucking firms.`],
      [`Port congestion delays cargo`, `Ships are waiting days to unload at several major ports, raising costs and slowing deliveries across the transportation industry.`],
    ],
    uncertain: [
      [`Transport ministers discuss new emission rules`, `Officials are considering tougher limits on emissions. The cost to operators will depend on how long they have to comply.`],
      [`Shipping rates swing wildly this week`, `Rates for moving cargo rose and fell sharply, leaving transport companies unsure how to plan.`],
    ],
  },
  consumer: {
    positive: [
      [`Shoppers spend more than expected`, `Retail data showed households buying more than forecast, supporting makers and sellers of consumer goods.`],
      [`Consumer confidence improves for third month`, `A survey found people feeling better about their finances, which tends to help spending on everyday goods.`],
    ],
    negative: [
      [`Households cut back on non-essential spending`, `Surveys show shoppers delaying larger purchases, a worry for consumer goods companies.`],
      [`Raw material costs rise for packaged goods makers`, `Higher prices for ingredients and packaging are squeezing margins at consumer goods firms.`],
    ],
    uncertain: [
      [`Retailers split on holiday outlook`, `Some chains expect busy stores while others are cautious. Analysts said the picture should become clearer within weeks.`],
      [`New labelling rules proposed for packaged foods`, `Officials want clearer labels on food and drink. The cost to consumer goods companies will depend on the final rules.`],
    ],
  },
  media: {
    positive: [
      [`Streaming subscriptions grow faster than forecast`, `More households signed up for streaming services last quarter, a boost for media and entertainment firms.`],
      [`Advertising spending rebounds`, `Brands are putting more money into advertising, which supports media companies that depend on it.`],
    ],
    negative: [
      [`Audiences drift away from traditional channels`, `Viewing figures fell again, adding pressure on media companies that rely on older formats.`],
      [`Content costs climb as studios compete`, `The price of making and buying shows and games is rising, which is squeezing profits across media and entertainment.`],
    ],
    uncertain: [
      [`Media firms explore mergers`, `Several media companies are reported to be exploring deals. Analysts said it is unclear whether they will go ahead.`],
      [`Copyright rules for digital content under review`, `Officials opened a review of how digital content is protected. The effect on media and entertainment firms is uncertain.`],
    ],
  },
  industrial: {
    positive: [
      [`Construction activity strengthens`, `Building projects are ramping up, which is lifting demand for steel, cement and machinery.`],
      [`Factory orders beat forecasts`, `New orders at industrial plants were higher than expected, supporting industrial and materials companies.`],
    ],
    negative: [
      [`Metal prices slide as demand cools`, `Lower prices for steel and other metals are weighing on producers in the industrial and materials industry.`],
      [`Equipment makers report weaker orders`, `Customers are delaying purchases of heavy equipment, a sign of caution in industry.`],
    ],
    uncertain: [
      [`Tariff talks cloud outlook for materials`, `Trade officials are discussing changes to duties. Industrial firms said they cannot plan until the talks end.`],
      [`Industrial survey shows mixed picture`, `Some factories report stronger orders while others report weaker ones, leaving the overall direction unclear.`],
    ],
  },
  aero: {
    positive: [
      [`Airlines place big orders for new planes`, `Fleet expansion plans are boosting orders for planes and parts, helping the aerospace and defense industry.`],
      [`Defense budgets set to rise`, `Governments signaled bigger spending on equipment and technology, which analysts said could benefit defense suppliers.`],
    ],
    negative: [
      [`Delivery delays hit aircraft makers`, `Shortages of parts are slowing deliveries of new aircraft, a drag on aerospace and defense companies.`],
      [`Government delays defense programs`, `Several programs were pushed back amid budget disputes, which could cost suppliers revenue.`],
    ],
    uncertain: [
      [`Space launch schedule faces weather and review delays`, `Several launches may slip, though companies said it is too early to say how much it will affect their plans.`],
      [`Defense procurement rules under review`, `Officials are examining how contracts are awarded. The impact on aerospace and defense firms is not yet clear.`],
    ],
  },
  utilities: {
    positive: [
      [`Regulators approve rate increases for utilities`, `Approved increases should lift revenue for utilities that asked for them.`],
      [`Demand for electricity grows on new data centers`, `Power use is rising as large computing sites connect to the grid, a boost for utilities.`],
    ],
    negative: [
      [`Storm season raises repair costs for utilities`, `Companies expect higher bills for fixing lines and plants after a spell of severe weather.`],
      [`Regulators deny part of utility rate requests`, `Officials approved smaller increases than companies asked for, which may limit utility profits.`],
    ],
    uncertain: [
      [`Utilities weigh costs of grid upgrades`, `Companies are discussing how to pay for a big upgrade of power lines. The details of who pays are still unsettled.`],
      [`Water use rules under discussion`, `Authorities are reviewing how water is priced and shared. Utilities said the result will take months.`],
    ],
  },
  emerging: {
    positive: [
      [`Venture funding for early-stage technology rebounds`, `Investors are putting more money into young technology companies, a positive sign for the emerging-technology industry.`],
      [`Pilot projects turn into full contracts`, `Several customers moved from trials to larger orders for new technology, giving the sector a lift.`],
    ],
    negative: [
      [`Funding dries up for young technology firms`, `Investors pulled back from early-stage companies, making it harder for emerging-technology firms to raise money.`],
      [`Prototype recalls shake confidence in new technology`, `Several early products were pulled after problems, which made some buyers more careful.`],
    ],
    uncertain: [
      [`Emerging-technology firms await rules on new products`, `Regulators are working on guidelines, and companies said the final rules will shape which products can launch.`],
      [`Analysts disagree on how fast new technology will spread`, `Some forecast rapid adoption while others expect slow progress, leaving the sector hard to read.`],
    ],
  },
};

/** Extra stories about the economy. */
export const MORE_MACRO_TEMPLATES: TemplateSet = {
  positive: [
    [`Unemployment falls to multi-year low`, `More people found jobs last month than expected, raising hopes for stronger consumer spending.`],
    [`Growth beats forecasts as business investment picks up`, `Output rose more quickly than analysts predicted, led by strong business investment.`],
    [`Consumer prices ease for a second month`, `Slower price increases give households some relief and raise hopes for lower interest rates.`],
    [`Trade deficit narrows as exports rise`, `Sales of goods abroad climbed, which economists said is a healthy sign for growth.`],
    [`Government announces tax relief for businesses`, `A package of tax cuts aims to encourage investment and hiring, which analysts said could lift profits.`],
    [`Factory activity expands for the first time in months`, `A closely watched survey of manufacturers showed growth, a sign that the slowdown may be easing.`],
  ],
  negative: [
    [`Unemployment rises more than expected`, `Job losses were larger than economists forecast, raising worries about spending and growth.`],
    [`Economy shrinks in latest quarter`, `Output fell, dragged down by weak investment and slower consumer spending, officials said.`],
    [`Consumer confidence falls sharply`, `A survey showed households feeling worse about the future, which could mean weaker spending ahead.`],
    [`Oil price jump raises worries about growth`, `A sudden rise in fuel costs may hurt businesses and households, economists warned.`],
    [`Government warns of larger budget gap`, `Higher spending and weaker tax receipts will mean more borrowing, officials said, which may push up interest rates.`],
    [`Trade dispute escalates between major economies`, `New duties on imports were announced, raising fears for global trade and company profits.`],
  ],
  uncertain: [
    [`Central bank minutes show divided views`, `Policymakers disagreed about whether rates should change soon, leaving investors unsure.`],
    [`Currency swings complicate outlook for exporters`, `A sharp move in the exchange rate helps some companies and hurts others, economists said.`],
    [`Budget talks continue with no deal in sight`, `Lawmakers said talks are making slow progress, and markets are waiting to see what will be agreed.`],
    [`Housing data points both ways`, `Sales rose in some regions and fell in others, which makes it hard to read the overall trend.`],
    [`Economists revise forecasts after mixed data`, `Several banks changed their predictions for growth, but not all in the same direction.`],
  ],
};

/**
 * Extra quarterly-report stories. Only good and bad ones: a report that is "in line" or "mixed" must say which of the two it is, so those keep their
 * own fixed wordings (UNCERTAIN_KIND in newsgen.ts).
 */
export const MORE_EARNINGS_TEMPLATES: TemplateSet = {
  positive: [
    [`{co} raises outlook after strong {q} results`, `Earnings per share of {eps} beat the {epscons} analysts expected, a surprise of {surp}. Revenue of {rev} was {revcmp} the {revcons} forecast. {cfo} said the company now expects a stronger year than it did three months ago.`],
    [`{co} {q} profit tops forecasts on {prod} sales`, `{co} earned {eps} a share in the {qn}, against {epscons} expected, and per-share profit is {yoy} from a year earlier. Revenue came in at {rev}. {ceo} said sales of {prod} drove the result.`],
    [`Strong quarter lifts {co}`, `Per-share profit of {eps} compared with {epscons} expected, beating forecasts by {epsdiff}. Revenue was {rev}, {revcmp} the {revcons} forecast. {ceo} thanked staff for a good {qn}.`],
    [`{co} delivers upbeat {q} results`, `{co} reported earnings per share of {eps}, {surp} more than analysts predicted. Revenue of {rev} was {revcmp} the {revcons} expected, and {cfo} said cash flow was healthy.`],
  ],
  negative: [
    [`{co} cuts outlook after weak {q} results`, `Earnings per share of {eps} fell short of the {epscons} analysts expected, a miss of {surp}. Revenue of {rev} was {revcmp} the {revcons} forecast. {cfo} said the company now expects a tougher year.`],
    [`{co} {q} profit lags forecasts as costs bite`, `{co} earned {eps} a share in the {qn}, against {epscons} expected, and per-share profit is {yoy} from a year earlier. Revenue came in at {rev}. {ceo} said costs rose faster than sales of {prod}.`],
    [`Weak quarter hurts {co}`, `Per-share profit of {eps} compared with {epscons} expected, missing forecasts by {epsdiff}. Revenue was {rev}, {revcmp} the {revcons} forecast. {ceo} said the {qn} was harder than planned.`],
    [`{co} reports subdued {q} results`, `{co} reported earnings per share of {eps}, {surp} less than analysts predicted. Revenue of {rev} was {revcmp} the {revcons} expected, and {cfo} said spending on {prod} weighed on profit.`],
  ],
};

/** Extra "the claim fades" follow-ups (they work for stocks and coins alike). */
export const MORE_FADE_TEMPLATES: TemplateSet = {
  positive: [
    [`{co} clears the air after online claims`, `{co} published records that answer the earlier claims, and the mood around {co} improved.`],
    [`Fears over {co} ease as details emerge`, `New information suggests the earlier worries were overdone. {ceo} said the team is relieved and back to work.`],
    [`Fact-check backs {co} against viral claims`, `An independent check found the claims about {co} to be misleading, and the mood recovered.`],
  ],
  negative: [
    [`Excitement over {co} cools as details disappoint`, `Closer reading showed less than the first reports suggested, and the enthusiasm about {co} faded.`],
    [`{co} says viral reports overstate the news`, `{co} said the earlier reports went further than the facts, and traders took some profit.`],
    [`Hype around {co} fades without confirmation`, `No confirmation came for the earlier claims about {co}, and attention moved on.`],
  ],
};

/** Extra viral stories (a viral post from an official is about a whole sector, so it names no company). */
export const MORE_VIRAL_TEMPLATES: Readonly<Record<ViralKind, TemplateSet>> = {
  influencer: {
    positive: [
      [`{person} shows off {co} gadget to {n} million fans`, `A video from {person} praising {prod} spread fast on social media. {co} said it did not pay for the post.`],
      [`Online personality {person} tells fans to watch {co}`, `In a post shared widely, {person} called {co} one to follow. The company thanked {person} for the attention but said it had no part in it.`],
    ],
    negative: [
      [`{person} warns followers about {co} after bad experience`, `A video by {person} describes problems with {prod}. {co} said it has contacted {person} to look into it.`],
      [`Influencer {person} calls {co} overpriced in viral rant`, `A clip of {person} criticizing prices at {co} has gone around the internet. {co} said its prices reflect the cost of quality.`],
    ],
    uncertain: [
      [`{person} teases big news about {co}`, `{person} told {n} million followers to expect something about {co} soon, without saying what. {co} declined to comment.`],
      [`{person} and {co} spotted together at event`, `Photos of {person} chatting with {ceo} are spreading. Neither side has said what the meeting was about.`],
    ],
  },
  clip: {
    positive: [
      [`Fans share clips of {prod} saving the day`, `A string of videos shows customers using {prod} in surprising ways. {co} said it has seen a jump in visits to its site.`],
      [`Clip of {co} staff surprising customers goes viral`, `A short video of {co} employees delivering {prod} personally has charmed viewers. The company said it was not planned.`],
    ],
    negative: [
      [`Video shows long queues and angry customers at {co}`, `A clip filmed at a {co} location in {region} shows long waits and shouting. {co} apologized and said it is adding staff.`],
      [`Clip appears to show {prod} breaking in use`, `A video spread by social media users shows {prod} failing. {co} said the footage may be of a faulty unit and it is checking.`],
    ],
    uncertain: [
      [`Viral clip of {co} sparks guessing game`, `A short, unclear video involving {co} drew millions of views. Viewers cannot agree on what it shows, and the company has not commented.`],
      [`Joke picture of {co} spreads across social media`, `A funny image of {co} and {prod} is everywhere. Analysts said it is unclear whether it helps or hurts the brand.`],
    ],
  },
  rumor: {
    positive: [
      [`Report says {co} close to landing big customer`, `People familiar with the matter said {co} is in advanced talks, according to a post circulating online. {co} declined to comment.`],
      [`Chatter grows that {co} will beat forecasts`, `Unconfirmed posts say orders for {prod} have been strong. {co} said it does not comment on rumors.`],
    ],
    negative: [
      [`Unverified post says {co} will miss targets`, `A widely shared post claimed {co} has been struggling to deliver {prod}. The company said the claim is false.`],
      [`Rumor of executive exit at {co} spreads online`, `Posts claim {ceo} is on the verge of leaving. {co} said {ceo} is not going anywhere.`],
    ],
    uncertain: [
      [`Talk of a merger involving {co} stirs speculation`, `A post mentioned a possible combination of {co} and {peer}. Neither company would confirm or deny it.`],
      [`Anonymous post claims big announcement coming at {co}`, `A post from an unknown account said {co} will announce news soon. There is no proof, and {co} said it has nothing to add.`],
    ],
  },
  investor: {
    positive: [
      [`Veteran investor {person} calls {co} a bargain`, `{person}, known for patient bets, said the market is too gloomy on {co} in an interview that spread widely.`],
      [`{person} adds to {co} stake, filing shows`, `A filing showed that {person} raised an existing position in {co}. {co} said it welcomes long-term investors.`],
    ],
    negative: [
      [`Well-known fund manager {person} bets against {co}`, `{person} told an audience that {co} is overvalued and said a short position has been opened.`],
      [`{person} says {co} has serious problems`, `In a widely shared interview, {person} listed concerns about {prod}. {co} said it disagrees.`],
    ],
    uncertain: [
      [`{person} says {co} is worth watching`, `{person} gave no detail about whether the investor holds any shares. The remark was shared thousands of times.`],
      [`Investor {person} meets {ceo} of {co}`, `A photo of the two at a dinner went around online. Neither side said what was discussed.`],
    ],
  },
  founder: {
    positive: [
      [`{ceo} promises biggest year ever for {co}`, `In a talk that went viral, {ceo} told the audience that {prod} is just the start. The remarks lit up social media.`],
      [`{ceo} gives emotional thank-you speech to {co} staff`, `A recording of {ceo} praising employees spread online and won widespread praise.`],
    ],
    negative: [
      [`{ceo} trades barbs with critics on social media`, `A heated exchange between {ceo} and critics of {co} drew millions of views. Some investors said it looked unwise.`],
      [`Leaked message shows {ceo} doubting {prod} timeline`, `A message attributed to {ceo} appeared online suggesting {prod} is behind schedule. {co} said it is being taken out of context.`],
    ],
    uncertain: [
      [`{ceo} says {co} will surprise everyone`, `{ceo} gave no details in a short interview that went viral. Analysts said it could mean anything.`],
      [`{ceo} deletes posts about {co}, fueling speculation`, `A series of messages disappeared from {ceo}'s account. {co} said it was a routine clean-up.`],
    ],
  },
  whistleblower: {
    positive: [
      [`Former rival employee says {co} plays fair`, `A former employee of a competitor wrote that {co} was a model of fair dealing, in a post that spread quickly.`],
      [`Safety claims against {co} rejected by inspector`, `A former staff member's claims were not supported by an inspection, {co} said, and the claims lost steam online.`],
    ],
    negative: [
      [`Ex-staff member alleges corners cut on {prod}`, `A former employee posted claims about quality checks at {co}. The company said it takes the claims seriously and denies wrongdoing.`],
      [`Anonymous account claims {co} hid problems from investors`, `A post by someone who said they work at {co} alleges bad news was kept quiet. {co} said the claims are false.`],
    ],
    uncertain: [
      [`Former employee questions {co} accounting in thread`, `A long thread asks about some of {co}'s figures. {co} said its books are audited and offered to answer questions.`],
      [`Letter to regulators about {co} circulates online`, `A copy of a letter that is said to have been sent to a regulator went around. {co} said it had not received any inquiry.`],
    ],
  },
  official: {
    positive: [
      [`Minister {person} praises the {sector} industry as a model`, `{person} spoke at an event and told reporters that the {sector} industry shows what the country can achieve.`],
      [`{person} says government will back {sector} firms`, `In a speech widely shared online, {person} promised help for companies in the {sector} industry.`],
    ],
    negative: [
      [`Official {person} calls for probe into {sector} pricing`, `{person} said prices in the {sector} industry deserve a close look, in remarks that moved quickly through social media.`],
      [`{person} says {sector} firms must explain their records`, `In a widely shared statement, {person} said companies in the {sector} industry would be asked to answer questions in parliament.`],
    ],
    uncertain: [
      [`{person} hints at change in rules for {sector} firms`, `In remarks that spread online, {person} said changes may be coming without saying what they will be.`],
      [`Official {person} meets leaders of the {sector} industry`, `A closed-door meeting was held but no statement was given. Observers disagreed over what it means.`],
    ],
  },
};
