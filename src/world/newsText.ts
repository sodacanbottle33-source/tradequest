// The words of the news. Every headline and story is a template with {slots}; the generator (newsgen.ts) fills them with the
// company's own name, products, executives and numbers. All people, companies and organisations named here are invented.
// A template is [headline, body]. The tests fill every template for every company and fail if a {slot} is left over.

import { MEME_SECTOR_TEMPLATES } from './memeNews';
import type { SectorId } from './params';
import type { Direction } from './types';

export type Template = readonly [headline: string, body: string];
export type TemplateSet = Partial<Record<Direction, readonly Template[]>>;

export type CompanyCategory =
  | 'product'
  | 'partnership'
  | 'management'
  | 'legal'
  | 'operations'
  | 'financial'
  | 'analyst'
  | 'contract'
  | 'research'
  | 'incident'
  | 'demand';

export type Category = CompanyCategory | 'earnings' | 'listing' | 'sector' | 'macro' | 'viral' | 'admin';

export const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  product: 'Products',
  partnership: 'Partnerships',
  management: 'Management',
  legal: 'Legal & regulation',
  operations: 'Operations',
  financial: 'Finance',
  analyst: 'Analysts',
  contract: 'Contracts',
  research: 'Research',
  incident: 'Incidents',
  demand: 'Demand',
  earnings: 'Earnings',
  listing: 'New listing',
  sector: 'Sector',
  macro: 'Economy',
  viral: 'Viral',
  admin: 'Special event',
};

export const COMPANY_CATEGORIES: readonly CompanyCategory[] = ['product', 'partnership', 'management', 'legal', 'operations', 'financial', 'analyst', 'contract', 'research', 'incident', 'demand'];

export const COMPANY_TEMPLATES: Readonly<Record<CompanyCategory, TemplateSet>> = {
  product: {
    positive: [
      ['{co} unveils {prod} to strong early demand', '{co} said pre-orders for {prod} passed internal targets within the first days, and {ceo} told staff the launch is running ahead of schedule.'],
      ['{co} rolls out upgraded {prod}', 'The update brings faster performance and new features to existing customers. {co} said adoption among its largest accounts has been quick.'],
      ["Reviewers praise {co}'s new {prod}", 'Early reviews highlighted reliability and value, giving {co} a welcome lift ahead of a wider release in {region}.'],
      ['{co} expands {prod} to {region}', 'The company is opening {prod} to customers in {region}, a market it has targeted for some time, and expects the rollout to take several weeks.'],
      ['{co} wins industry award for {prod}', '{prod} was named product of the year at a trade event in {region}, which {co} says is already generating new customer inquiries.'],
      ['{co} reports record usage of {prod}', 'Usage climbed {pct}% over the past quarter, according to figures {co} shared with investors.'],
      ['{co} ships first units of {prod}', 'Deliveries began this week, and {co} said early customers have given positive feedback.'],
      ['{prod} gets major update from {co}', 'The release adds features customers have asked for, and {co} said it will be free for existing subscribers.'],
    ],
    negative: [
      ['{co} delays launch of {prod}', '{co} said the release of {prod} will slip by several weeks while engineers resolve late-stage issues found in testing.'],
      ['{co} recalls batch of {prod}', 'A quality check found a fault in part of the supply. {co} is offering replacements and said the cost is still being estimated.'],
      ["Customers report problems with {co}'s {prod}", 'Complaints spread online this week. {co} acknowledged the reports and said a fix is being prepared.'],
      ['{co} pauses {prod} rollout in {region}', 'The company halted the rollout after weaker-than-expected uptake and said it will reassess pricing.'],
      ['Rival undercuts {co} on pricing', 'A competitor announced sharply lower prices for products that compete with {prod}, raising questions about margins at {co}.'],
      ['{co} discontinues part of {prod} line', '{co} will wind down some versions by the end of the year, saying demand no longer justifies the cost of supporting them.'],
      ['Bug forces {co} to pull {prod} update', '{co} withdrew a software update after users reported crashes and said a corrected version would follow.'],
      ['{co} raises prices on {prod}', 'Customers will pay more from next month, and some analysts questioned whether demand will hold.'],
    ],
    uncertain: [
      ['{co} previews {prod} but gives no release date', 'At a closed-door event, {co} showed an early version. {ceo} declined to say when it will go on sale or what it will cost.'],
      ["Mixed first impressions for {co}'s {prod}", 'Early testers praised the design but questioned the price, leaving analysts split on how well it will sell.'],
      ['{co} changes pricing model for {prod}', '{co} is moving to a new pricing structure. It said some customers will pay less and others more, and gave no estimate of the net effect.'],
      ['{co} opens {prod} to limited beta testing', 'A select group of customers will try the product over the coming weeks. {co} said their feedback will decide how widely it is released.'],
      ['{co} hints at major revision of {prod}', 'In an interview, {ceo} said engineers are working on a significant update but cautioned that plans could change.'],
      ['{co} shows redesigned {prod} to select partners', 'Details were kept private, but {ceo} said the redesign is intended to widen the product\'s appeal.'],
    ],
  },
  partnership: {
    positive: [
      ['{co} and {peer} sign multi-year partnership', 'The two companies will work together on {prod} and share distribution channels in {region}. Financial terms were not disclosed.'],
      ['{co} teams up with {peer} on joint venture', '{co} and {peer} will form a joint venture to develop new products, with each contributing engineers and funding.'],
      ['{peer} chooses {co} as preferred supplier', '{peer} named {co} its preferred supplier, a deal {co} expects to be worth {amt} over three years.'],
      ['{co} and {peer} agree to share technology', 'A licensing agreement will give each company access to the other\'s patents, which {ceo} said will cut development costs.'],
      ['{co} signs distribution deal with {peer}', 'A network of resellers across {region} will begin carrying {prod}, widening {co}\'s reach considerably.'],
      ['{co} joins {peer} in industry alliance', 'The two companies and others in the {sector} industry agreed to common standards, which {co} said should lower costs.'],
    ],
    negative: [
      ['{peer} ends partnership with {co}', '{peer} said it will not renew its agreement with {co} when it expires, citing a change in strategy. {co} said it was disappointed.'],
      ['{co} and {peer} in dispute over joint project', 'The two companies disagree about costs and timing of their shared work on {prod}, people familiar with the matter said.'],
      ['{peer} scales back cooperation with {co}', '{peer} will reduce the scope of its work with {co}, moving some of the business in-house.'],
      ['{peer} drops {co} as distribution partner', '{peer} has switched to a competing product line in {region}, removing a meaningful source of sales for {co}.'],
      ['{co} falls out with {peer} over licensing terms', 'A dispute over fees has halted cooperation on {prod}, and both sides said talks have stalled.'],
    ],
    uncertain: [
      ['{co} in talks with {peer} over possible deal', 'The companies confirmed discussions but cautioned there is no certainty an agreement will be reached.'],
      ['{co} and {peer} extend negotiations', 'Talks about a joint project have been extended. Neither side gave a reason or a new deadline.'],
      ['{co} weighs deeper ties with {peer}', '{ceo} said {co} is considering expanding its work with {peer} on {prod} and expects to decide in the coming months.'],
      ['{co} and {peer} announce exploratory cooperation', 'The companies will study joint opportunities for six months before deciding whether to go further.'],
    ],
  },
  management: {
    positive: [
      ['{co} names new chief operating officer', '{co} appointed an experienced executive from the {sector} industry, and {ceo} said the hire will speed up execution.'],
      ['{ceo} signs long-term contract with {co}', "{co}'s board extended {ceo}'s contract by five years, which directors described as a vote of confidence in the strategy."],
      ['{co} hires industry veteran to lead {prod}', 'A well-known leader will head the business starting next month, according to a company statement.'],
      ['Executives buy shares in {co}', 'Several senior executives at {co} bought shares in the open market, regulatory filings showed.'],
      ['{co} adds two independent directors', 'The additions bring fresh experience to the board and were welcomed by shareholder groups.'],
      ['{co} promotes insider to lead {prod} division', 'A longtime executive takes over the business, which {ceo} said ensures continuity.'],
    ],
    negative: [
      ['{cfo} to leave {co}', "{co}'s chief financial officer is stepping down after several years in the role, and the company has started a search for a successor."],
      ['{ceo} steps down as {co} chief executive', '{ceo} will leave immediately for personal reasons. The board named an interim chief while it looks for a permanent replacement.'],
      ['Senior executives depart {co}', 'Several senior managers have left in recent weeks, according to people familiar with the company.'],
      ['{co} director resigns over strategy', 'A board member quit, saying he disagreed with the direction the company is taking.'],
      ['Insiders sell shares in {co}', 'Filings show several executives sold shares over the past week. The company said the sales were pre-planned.'],
      ['{co} chief operating officer resigns', 'The departure was unexpected, and the company said duties will be shared among existing executives for now.'],
    ],
    uncertain: [
      ['{co} announces leadership reshuffle', '{co} is reorganizing its management team. {ceo} remains in charge and said further details will follow.'],
      ['{ceo} to retire from {co} next year', '{ceo} will step down at the end of next year, and the board has begun searching for a successor.'],
      ['{co} creates new executive role', 'The company is adding a chief strategy officer and said the position will oversee investments in {prod}.'],
      ['{co} board begins strategic review', 'Directors will examine the company\'s options with the help of outside advisers, {co} said, with no timetable.'],
    ],
  },
  legal: {
    positive: [
      ['{co} wins patent dispute', 'A court ruled in favor of {co} in a long-running case related to {prod}, removing an overhang on the company.'],
      ['Regulator clears {co} to proceed', 'The regulator approved {co}\'s plan after a lengthy review, allowing the company to move ahead with {prod}.'],
      ['{co} settles lawsuit on favorable terms', '{co} agreed to settle for less than it had set aside, and said the matter will cause no disruption to its business.'],
      ['Investigation of {co} closed without action', 'Authorities told {co} they have ended an inquiry without charges or fines.'],
      ['Court dismisses claims against {co}', 'A judge threw out a case filed by a former supplier, saying it lacked evidence.'],
    ],
    negative: [
      ['{co} sued over {prod}', 'A group of customers filed a lawsuit claiming the product did not perform as advertised. {co} said the claims have no merit and it will defend itself.'],
      ['Regulator opens probe into {co}', 'The Competition Authority is examining some of {co}\'s business practices. {co} said it is cooperating fully.'],
      ['{co} fined over compliance failures', '{co} agreed to pay {amt} to resolve findings that it failed to follow certain rules, and promised to improve its controls.'],
      ['Court rules against {co} in patent case', 'A judge found that {co} infringed a rival\'s patent. The company said it will appeal and may be required to pay damages.'],
      ['{co} loses appeal in contract dispute', 'The ruling could require {co} to pay damages, though the amount has not been set.'],
    ],
    uncertain: [
      ['Hearing scheduled in case against {co}', 'A court will hear arguments next month in a case involving {co}. Analysts said the outcome is difficult to predict.'],
      ['{co} in settlement talks', '{co} confirmed it is discussing a possible settlement of a pending dispute but said no agreement has been reached.'],
      ['{co} faces new regulatory questions', 'A regulator sent {co} a list of questions about {prod}. The company said it will respond within the deadline.'],
      ['{co} receives request for documents', '{co} said it received a request for information from authorities and is cooperating, adding that it does not believe it is a target.'],
    ],
  },
  operations: {
    positive: [
      ['{co} opens new facility in {region}', 'The site adds capacity and is expected to cut delivery times. {ceo} said it will employ about {n}00 people.'],
      ['{co} reports efficiency gains', 'Changes to production have trimmed costs by {pct}% in some units, {cfo} told investors.'],
      ['Supply chain pressures ease for {co}', '{co} said parts shortages have eased and deliveries are returning to normal levels.'],
      ['{co} completes expansion ahead of schedule', 'The expansion in {region} finished weeks early and under budget, according to the company.'],
      ['{co} locks in long-term supply agreements', 'Fixing prices for key inputs should make costs more predictable, {cfo} said.'],
      ['{co} wins approval for new {region} plant', 'Local authorities granted permits, and construction should begin next quarter, {ceo} said.'],
    ],
    negative: [
      ['{co} halts production at {region} site', 'Operations were suspended after an equipment failure. The company said it is working to restart and has not given a timetable.'],
      ['Workers at {co} begin strike', 'Union members walked out at {co} sites in {region} after talks over pay broke down.'],
      ['Shortages hit {co} output', 'A lack of key components has forced {co} to slow production, and the company warned deliveries may be delayed.'],
      ['{co} warns of rising costs', '{cfo} said higher input and shipping costs will weigh on margins in the coming months.'],
      ['Storm disrupts {co} operations', 'Severe weather in {region} damaged facilities used by {co}. The company said it is assessing the extent of the damage.'],
      ['Repairs drag on at {co} site', 'Work at a key facility is taking longer than planned, and customers in {region} may see delays.'],
    ],
    uncertain: [
      ['{co} reorganizes operations', '{co} is merging two business units and moving some work to {region}. The company said it expects the changes to take a year.'],
      ['{co} begins maintenance shutdown', 'A planned shutdown of part of {co}\'s operations started this week. The company said it will finish on schedule but gave no further detail.'],
      ['{co} reviews facility network', '{ceo} said the company is studying whether to consolidate some sites, and no decisions have been made.'],
      ['{co} shifts production between sites', 'Some work will move to {region} over the next several months, which the company said will not change its output targets.'],
    ],
  },
  financial: {
    positive: [
      ['{co} announces {amt} share buyback', 'The board approved a program to repurchase shares over the next year, which {cfo} said reflects confidence in the outlook.'],
      ['{co} raises dividend by {pct}%', '{co} lifted its quarterly payout, citing strong cash flow.'],
      ['{co} lifts full-year outlook', 'Management now expects results at the upper end of its earlier range, {cfo} said, citing demand for {prod}.'],
      ['{co} refinances debt at lower rates', '{co} replaced {amt} of borrowing with cheaper debt, which should reduce interest costs.'],
      ['{co} secures new credit line', 'A new {amt} credit facility gives {co} more flexibility to invest, the company said.'],
      ['{co} pays down {amt} of debt early', 'Using cash on hand, the company retired borrowings ahead of schedule, {cfo} said.'],
    ],
    negative: [
      ['{co} cuts full-year forecast', '{cfo} said slower demand and higher costs mean results will fall short of earlier guidance.'],
      ['{co} plans {amt} share offering', '{co} intends to sell new shares to raise money, a move that dilutes existing shareholders.'],
      ['Rating agency downgrades {co} debt', 'A credit rating agency cut its view of {co}\'s borrowing, pointing to weaker cash flow.'],
      ['{co} suspends dividend', 'The board said it would preserve cash while the outlook remains uncertain.'],
      ['{co} takes {amt} charge', '{co} will record a one-time charge related to restructuring, which {cfo} said is partly non-cash.'],
      ['{co} warns on margins', '{cfo} told investors that higher costs will squeeze profitability over the next few quarters.'],
    ],
    uncertain: [
      ['{co} to update investors on capital plans', '{co} announced a briefing to discuss how it will allocate cash, and gave no preview of what it will say.'],
      ['{co} explores financing options', '{cfo} said the company is looking at several ways to fund growth, including debt and equity.'],
      ['{co} reaffirms outlook amid uncertainty', '{co} kept its guidance unchanged but acknowledged that conditions in the {sector} sector are hard to predict.'],
      ['{co} schedules earnings call', 'The company will discuss recent performance at a call next week and said it will not pre-announce results.'],
    ],
  },
  analyst: {
    positive: [
      ['{firm} upgrades {co}', 'Analyst {person} raised the rating, saying the market is underestimating demand for {prod}.'],
      ['{firm} raises {co} price target', '{person} at {firm} lifted the target by {pct}% following a meeting with management.'],
      ['{firm} starts {co} coverage with buy rating', 'In a first report, {person} described {co} as well positioned in the {sector} industry.'],
      ['Analysts turn more upbeat on {co}', 'A string of research notes this week praised {co}\'s execution, with {firm} calling the shares attractive.'],
      ['{firm} names {co} a top pick', '{person} said {prod} gives the company a competitive edge that the market has yet to appreciate.'],
    ],
    negative: [
      ['{firm} downgrades {co}', '{person} cut the rating, warning that growth looks harder to come by.'],
      ['{firm} lowers {co} price target', '{person} trimmed expectations by {pct}%, citing competition and a weaker outlook for {prod}.'],
      ['Analyst warns on {co} valuation', 'A note from {firm} argued the shares already reflect good news and look expensive.'],
      ['Short seller targets {co}', 'A research firm published a report questioning {co}\'s accounting. The company called it misleading.'],
      ['{firm} sees limited upside for {co}', '{person} argued that growth has been priced in and cut near-term estimates.'],
    ],
    uncertain: [
      ['{firm} holds {co} at neutral', '{person} kept a neutral rating, saying risks and opportunities are evenly balanced.'],
      ['Analysts split on {co}', 'Research firms disagree about the outlook, with {firm} positive and others cautious.'],
      ['{firm} hosts {co} investor day', '{ceo} presented to analysts, who left with differing views on how the strategy will play out.'],
      ['{firm} initiates {co} at market perform', '{person} said strengths in {prod} are offset by uncertainty about costs.'],
    ],
  },
  contract: {
    positive: [
      ['{co} wins major contract', '{co} was selected for a multi-year contract worth about {amt} involving {prod}.'],
      ['{co} adds large customer', 'A leading company in the {sector} industry signed up for {prod}, and {co} said more customers are expected to follow.'],
      ['{co} renews key customer agreement', 'A top customer extended its agreement with {co} for another three years on similar terms.'],
      ['Government agency picks {co} for program', 'A public agency chose {co} for a new program, with deliveries to start next year.'],
      ['{co} extends deal with largest customer', 'The agreement runs for five years and includes volume commitments, according to the company.'],
    ],
    negative: [
      ['{co} loses key customer', 'A major customer said it will move its business away from {co}, which accounted for a notable share of sales.'],
      ['Contract with {co} cancelled', 'A client cancelled an agreement worth around {amt}, citing delays. {co} said it disagrees with the decision.'],
      ['{co} passed over for contract', 'A rival won a large contract that {co} had bid for, the buyer announced.'],
      ['Customer renegotiates terms with {co}', '{co} agreed to lower prices for a large customer in return for keeping its business.'],
      ['{co} warns of delays on key order', 'Deliveries under a large contract will arrive late, and the customer may be entitled to compensation.'],
    ],
    uncertain: [
      ['{co} bids for large contract', '{co} confirmed it has submitted a bid for a major contract. A decision is expected within months.'],
      ['Customer reviews {co} agreement', 'A big customer is reviewing its supplier arrangements, including the one with {co}, the company said.'],
      ['{co} gets small order with option for more', 'A first order for {prod} could grow substantially if the customer is satisfied.'],
      ['{co} negotiates new terms with customer', 'Both sides said talks are constructive, but no deal has been announced.'],
    ],
  },
  research: {
    positive: [
      ['{co} reports breakthrough in lab tests', 'Results from the latest tests exceeded expectations, {ceo} said, and the next phase should start soon.'],
      ['{co} receives key patent', 'The patent covers core technology behind {prod} and should protect it from imitators.'],
      ['{co} completes successful pilot', 'A pilot program of {prod} met all of its goals, and a larger rollout is being planned.'],
      ['{co} secures research grant', 'A {amt} grant will help {co} advance its work on {prod}.'],
      ['{co} files for new patents on {prod}', 'The filings cover improvements that the company said will extend its technology lead.'],
    ],
    negative: [
      ['{co} test results disappoint', 'Results of the latest study fell short of goals. {co} said it will review the data before deciding its next steps.'],
      ['{co} postpones key trial', 'Technical difficulties have pushed a major test of {prod} back by several months.'],
      ['{co} loses lead researcher', 'A senior scientist is leaving to join a rival, raising doubts about the timetable for {prod}.'],
      ['Rival reaches milestone ahead of {co}', 'A competitor announced results from a similar project, weakening {co}\'s position.'],
      ['{co} scales back research program', 'To save cash, {co} will reduce spending on early-stage projects and focus on {prod}.'],
    ],
    uncertain: [
      ['{co} presents early data', '{co} shared early results, which {ceo} described as encouraging but preliminary.'],
      ['{co} extends testing of {prod}', 'The study will continue longer than planned so that more information can be collected.'],
      ['{co} to present at scientific meeting', '{co} will present findings next week. The company declined to comment on what they will show.'],
      ['{co} opens new research center in {region}', 'The center will employ about {n}0 scientists, though {co} said results will take years.'],
    ],
  },
  incident: {
    negative: [
      ['{co} investigates security breach', '{co} said unauthorized access to some systems was detected and it is working with outside experts to determine what was affected.'],
      ['Accident at {co} site prompts inspection', 'An accident at a facility in {region} led to a safety inspection. Operations there are partly suspended.'],
      ['{co} service outage frustrates customers', '{prod} was unavailable for several hours, and {co} apologized and promised a full review.'],
      ['Safety concerns raised about {co}', 'Regulators asked {co} for information after reports of problems with {prod}.'],
      ['Data exposure reported at {co}', 'A misconfiguration left customer information accessible. {co} said it has been fixed and affected customers are being notified.'],
      ['Fire damages {co} warehouse', 'Nobody was hurt, but inventory was lost and {co} said it is assessing the impact on deliveries.'],
    ],
    uncertain: [
      ['{co} looks into reports of irregularities', '{co} said it is reviewing claims made online about its operations and will share findings when complete.'],
      ['{co} responds to rumors', 'The company said it does not comment on speculation after unconfirmed reports about its business circulated on social media.'],
      ['{co} reviews minor incident', 'A limited incident at a {co} site was contained, the company said, and its effects are being assessed.'],
      ['{co} confirms limited outage', 'A brief disruption affected some users of {prod}. {co} said service was restored and it is investigating the cause.'],
    ],
  },
  demand: {
    positive: [
      ["Demand for {co}'s {prod} accelerates", '{co} said orders rose {pct}% from a year earlier.'],
      ['{co} gains market share', 'Industry data showed {co} increasing its share of the {sector} market in {region}.'],
      ['{co} sees strong bookings', 'Early bookings suggest a busy period ahead, according to {cfo}.'],
      ['{co} reports growing customer base', 'The number of customers using {prod} has grown by {pct}% since the start of the year.'],
      ['{co} cannot keep up with orders', 'Stronger-than-planned demand for {prod} has left some customers waiting, {ceo} said, and the company is adding capacity.'],
    ],
    negative: [
      ["Demand softens for {co}'s {prod}", 'Sales slowed in recent weeks, {cfo} said, and the company is watching trends closely.'],
      ['{co} loses ground to rivals', 'Industry figures show {co}\'s share of the {sector} market slipping in {region}.'],
      ['Price war weighs on {co}', 'Aggressive discounting by competitors is pressuring prices of {prod}.'],
      ['{co} sees customers cutting back', '{ceo} said several clients are trimming budgets, which could slow growth.'],
      ['Inventory builds at {co}', 'Unsold stock of {prod} has risen, {cfo} said, and the company may discount to clear it.'],
    ],
    uncertain: [
      ['{co} says demand is mixed', 'Some product lines are strong while others are weak, {cfo} said, making the overall picture hard to read.'],
      ['Survey gives mixed view of {co}', 'A consumer survey found high awareness of {co} but uncertainty about purchase plans.'],
      ['{co} sees seasonal swing in orders', '{co} noted orders are shifting between quarters, which makes near-term comparisons difficult.'],
      ['{co} sees early signs of a shift in buying habits', 'Customers are changing how they purchase {prod}, though it is too early to say what it means for sales.'],
    ],
  },
};

/**
 * The story of a quarterly report. Its numbers come from fundamentals.ts and always agree with the headline. The three "uncertain" stories are
 * picked by the numbers (in line / EPS beat but revenue short / revenue beat but EPS short), in that order.
 */
export const EARNINGS_TEMPLATES: TemplateSet = {
  positive: [
    ['{co} beats expectations in {q} results', 'Earnings per share of {eps} topped the {epscons} analysts expected, a surprise of {surp}. Revenue was {rev} against {revcons} expected, and per-share profit is {yoy} from a year earlier. {ceo} credited strong demand for {prod}.'],
    ['{co} posts stronger-than-expected profit', '{co} earned {eps} a share in the {qn}, {surp} more than forecast. Revenue of {rev} was {revcmp} the {revcons} expected. {cfo} said margins improved and cash flow was solid.'],
    ['{co} {q} earnings jump past forecasts', 'Per-share profit of {eps} compared with {epscons} expected, and is {yoy} from a year earlier. Revenue was {rev}, {revcmp} the {revcons} forecast. {ceo} credited demand for {prod} and growth in {region}.'],
    ['{co} earnings top estimates', 'Earnings per share beat forecasts by {epsdiff}, at {eps} against {epscons}. Revenue came in at {rev}. {co} said orders for {prod} remain healthy.'],
  ],
  negative: [
    ['{co} misses expectations in {q} results', 'Earnings per share of {eps} fell short of the {epscons} analysts expected, a miss of {surp}. Revenue was {rev} against {revcons} expected. {ceo} pointed to weaker demand and rising costs.'],
    ['{co} profit falls short', '{co} earned {eps} a share in the {qn}, {surp} less than forecast, and per-share profit is {yoy} from a year earlier. {cfo} said margins narrowed, and the company trimmed its outlook for the rest of the year.'],
    ['{co} disappoints with {q} results', 'Per-share profit of {eps} compared with {epscons} expected. Revenue came in at {rev}, {revcmp} the {revcons} forecast, and {co} warned the coming period could be difficult.'],
    ['{co} earnings miss estimates', 'Earnings per share came in {epsdiff} below forecasts, at {eps} against {epscons}. {cfo} blamed higher costs and lower sales of {prod}.'],
  ],
  uncertain: [
    ['{co} reports results in line with forecasts', 'Earnings per share were {eps}, {epscmp} the {epscons} expected, and revenue of {rev} was {revcmp} the {revcons} forecast. {ceo} said the company is on track and did not change its outlook.'],
    ['Mixed results at {co}', 'Earnings per share of {eps} beat the {epscons} expected, but revenue of {rev} was {revcmp} the {revcons} forecast. {cfo} said the mix of sales of {prod} left investors guessing.'],
    ['{co} sales beat but profit lags', 'Revenue of {rev} was {revcmp} the {revcons} forecast, but earnings per share of {eps} were {epscmp} the {epscons} expected. {cfo} said investments in {prod} weighed on margins.'],
  ],
};

export const LISTING_TEMPLATES: TemplateSet = {
  uncertain: [
    ['{co} ({tk}) begins trading', '{co}, based in {hq}, makes {prod} and {prod2}. Its shares started trading today. {ceo} said the listing will help the company invest in growth.'],
    ['New listing: {co} debuts as {tk}', 'The {sector} company, known for {prod}, joins the market with {ceo} as chief executive. Investors will be watching how its shares settle in the coming days.'],
  ],
};

export const MACRO_TEMPLATES: TemplateSet = {
  positive: [
    ['Central bank cuts interest rates', 'Borrowing costs fall as policymakers cite cooling inflation. Lower rates tend to support company profits and valuations.'],
    ['Inflation cools more than expected', 'Prices rose more slowly last month than economists forecast, raising hopes for easier monetary policy.'],
    ['Jobs report shows steady hiring', 'Employers added more workers than expected while wage growth stayed moderate.'],
    ['Consumer confidence rebounds', 'A closely watched survey showed households feeling more positive about their finances and spending plans.'],
    ['Trade agreement reached between major economies', 'Lower tariffs are expected to ease costs for manufacturers and retailers.'],
    ['Economy grows faster than forecast', 'Output expanded at a firmer pace than expected last quarter, led by business investment.'],
  ],
  negative: [
    ['Central bank raises interest rates', 'Policymakers lifted rates to fight inflation. Higher borrowing costs can weigh on company profits and valuations.'],
    ['Inflation runs hotter than expected', 'Consumer prices rose faster than forecast, raising worries that interest rates will stay high.'],
    ['Job growth slows sharply', 'Hiring fell well short of expectations, stoking concern about the economy.'],
    ['Consumer confidence falls', 'A survey showed households turning more cautious on spending as prices stay high.'],
    ['New tariffs announced between major economies', 'Higher import taxes are expected to raise costs for manufacturers and retailers.'],
    ['Economy contracts unexpectedly', 'Output shrank last quarter, adding to fears of a downturn.'],
  ],
  uncertain: [
    ['Central bank leaves rates unchanged', 'Policymakers held rates steady and offered few clues about their next move.'],
    ['Economic data sends mixed signals', 'Strong retail sales were offset by weak factory output, leaving economists unsure which way the economy is heading.'],
    ['Markets await central bank meeting', 'Investors are cautious ahead of a policy decision that could shape borrowing costs.'],
    ['Government to unveil budget plan', 'Details of tax and spending proposals are due soon, and analysts disagree about what they will mean.'],
  ],
};

export const SECTOR_TEMPLATES: Readonly<Record<SectorId, TemplateSet>> = {
  tech: {
    positive: [['Chip demand strengthens across the technology industry', 'Orders for processors and cloud services are rising as businesses upgrade their systems.'], ['Software spending rises as companies modernize', 'Corporate budgets for technology are growing, according to a new industry survey.']],
    negative: [['Technology firms warn of weaker corporate spending', 'Several industry executives said customers are delaying purchases.'], ['New data-privacy rules worry technology companies', 'Lawmakers proposed stricter rules that could raise compliance costs.']],
    uncertain: [['Technology regulation under review', 'Officials are considering changes to rules for technology firms, but details are unclear.']],
  },
  ai: {
    positive: [['Business adoption of AI accelerates', 'A survey found most large employers plan to expand AI projects this year.'], ['Demand for AI computing capacity outstrips supply', 'Cloud providers said they are struggling to add servers fast enough.']],
    negative: [['Calls grow for tougher AI rules', 'Lawmakers in several countries proposed limits on how AI systems may be used.'], ['AI projects face scrutiny over costs', 'Some companies said returns from AI spending are arriving more slowly than hoped.']],
    uncertain: [['AI safety hearing draws wide attention', 'Experts offered conflicting views on how fast the technology should advance.']],
  },
  robotics: {
    positive: [['Factories boost spending on automation', 'Labor shortages are pushing manufacturers to order more robots.'], ['Warehouse automation orders climb', 'Retail distributors are investing in robotic systems ahead of the busy season.']],
    negative: [['Robot makers see slowing orders', 'Higher interest rates are making customers think twice about big automation projects.'], ['Safety review hits robot makers', 'A report called for tougher standards, which could raise costs for the industry.']],
    uncertain: [['Automation and jobs debate heats up', 'Unions and manufacturers differ about the pace of change.']],
  },
  energy: {
    positive: [['Energy prices climb on tight supply', 'Supplies are limited while demand remains firm, supporting producers.'], ['Governments back new power projects', 'Support for grid and generation projects should lift demand for energy equipment.']],
    negative: [['Energy prices fall as supply rises', 'Higher output and weaker demand pushed prices lower, weighing on producers.'], ['Windfall tax proposed on energy profits', 'Lawmakers want to tax what they call unusually large profits.']],
    uncertain: [['Energy ministers meet amid uncertainty', 'Output decisions are expected, but analysts disagree about what will be agreed.']],
  },
  health: {
    positive: [['Health regulators speed up approvals', 'A faster review process should help companies bring treatments to patients sooner.'], ['Hospital spending on equipment rises', 'Health systems are upgrading technology after a profitable year.']],
    negative: [['Drug price controls proposed', 'Lawmakers are weighing limits on prices, which could pressure revenue across the industry.'], ['Health authority tightens safety rules', 'New requirements could lengthen testing and raise costs for drug and device makers.']],
    uncertain: [['Healthcare reform bill moves forward', 'The proposal could change how care is paid for, but its final shape is unclear.']],
  },
  finance: {
    positive: [['Lending picks up across the financial sector', 'Loan demand is growing and defaults remain low, according to industry data.'], ['Trading and deal activity jumps', 'Higher volumes are lifting fee income at banks and brokers.']],
    negative: [['Loan defaults edge up', 'Banks reported more borrowers falling behind on payments.'], ['Regulators propose higher capital requirements', 'Financial firms may have to hold more cash against risks, limiting lending.']],
    uncertain: [['Financial regulators review banking rules', 'A review is under way, and it is unclear whether it will lead to changes.']],
  },
  transport: {
    positive: [['Freight volumes rise', 'Shippers and carriers report busy conditions as demand for goods grows.'], ['Travel demand stays strong', 'Bookings across air, rail and road are above last year\'s levels.']],
    negative: [['Fuel costs jump for transport firms', 'Higher diesel and jet fuel prices will squeeze margins across the industry.'], ['Port congestion delays shipments', 'Backlogs at major ports are raising costs for carriers.']],
    uncertain: [['Transport safety rules under review', 'Officials are weighing changes that could affect operating costs.']],
  },
  consumer: {
    positive: [['Retail sales beat expectations', 'Shoppers spent more than forecast, led by everyday goods.'], ['Commodity costs ease for consumer brands', 'Lower input prices should help margins at food and household companies.']],
    negative: [['Shoppers trade down as prices stay high', 'Consumers are shifting to cheaper brands, according to a retail survey.'], ['Input costs squeeze consumer brands', 'Higher prices for ingredients and packaging are weighing on profits.']],
    uncertain: [['Consumer spending data mixed', 'Spending on essentials is firm but discretionary categories are soft.']],
  },
  media: {
    positive: [['Streaming subscriptions climb', 'New signups grew across major services this quarter.'], ['Box office hits boost entertainment outlook', 'A run of popular releases lifted attendance.']],
    negative: [['Advertising spending slows', 'Marketers are trimming budgets, which hurts media companies.'], ['Viewers cut back on subscriptions', 'Rising prices are prompting households to cancel services.']],
    uncertain: [['Industry awaits new content rules', 'Regulators are considering changes to licensing and distribution.']],
  },
  industrial: {
    positive: [['Metal prices firm as construction picks up', 'Higher demand from builders and manufacturers is helping producers.'], ['Infrastructure spending plan approved', 'Public works funding should boost orders for materials and equipment.']],
    negative: [['Metal prices slide on weaker demand', 'Softer orders from manufacturers pushed prices lower.'], ['Mining regulations tightened', 'New environmental rules could raise costs for producers.']],
    uncertain: [['Industrial output data mixed', 'Some factories are busy while others report slowing orders.']],
  },
  aero: {
    positive: [['Defense budgets get a boost', 'Lawmakers approved higher spending on aircraft and equipment.'], ['Airlines order more aircraft', 'Strong travel demand is driving new orders for planes and parts.']],
    negative: [['Defense program faces review', 'A government audit raised concerns about costs and schedules.'], ['Supply delays slow aircraft deliveries', 'Shortages of parts mean planes are arriving later than planned.']],
    uncertain: [['Defense policy debate continues', 'Officials are divided about priorities and the pace of spending.']],
  },
  utilities: {
    positive: [['Regulators approve higher utility rates', 'Approved increases will help utilities fund upgrades.'], ['Grid investment plan announced', 'A program to modernize networks should provide work for years.']],
    negative: [['Regulators reject utility rate request', 'Limits on rates would reduce earnings growth.'], ['Heat wave strains the grid', 'Record demand and outages prompted calls for tougher oversight.']],
    uncertain: [['Utility regulation under review', 'A review of how rates are set could change the industry, but timing is unclear.']],
  },
  emerging: {
    positive: [['Investors pour money into emerging industries', 'Venture funding for new technologies reached a multi-year high.'], ['Government announces support for new industries', 'Grants and tax breaks will target early-stage companies.']],
    negative: [['Funding dries up for early-stage companies', 'Investors are growing more selective, making it harder to raise cash.'], ['Safety concerns grow over unproven technologies', 'Critics called for tighter oversight of new products.']],
    uncertain: [['Experts divided on pace of new technologies', 'Forecasts for adoption vary widely across the industry.']],
  },
  meme: MEME_SECTOR_TEMPLATES,
};

/** Viral and important-person events. {person} is a fictional influencer, investor or official. */
export type ViralKind = 'influencer' | 'clip' | 'rumor' | 'investor' | 'founder' | 'whistleblower' | 'official';
export const VIRAL_KINDS: readonly ViralKind[] = ['influencer', 'clip', 'rumor', 'investor', 'founder', 'whistleblower', 'official'];

export const VIRAL_TEMPLATES: Readonly<Record<ViralKind, TemplateSet>> = {
  influencer: {
    positive: [['Social media star {person} backs {co}', '{person}, who has {n} million followers, called {co} a stock to watch in a video that spread rapidly. {co} had no comment.']],
    negative: [['Influencer {person} criticizes {co}', 'A video by {person}, seen by millions, claims {co} is overhyped. The clip is circulating widely and {co} said it stands by its products.']],
    uncertain: [['{person} mentions {co} in viral post', '{person} posted about {co} to an audience of {n} million, without making clear whether the view is positive.']],
  },
  clip: {
    positive: [['Viral video of {prod} wins fans', 'A clip showing {prod} in action has been watched tens of millions of times, driving a surge of interest in {co}.']],
    negative: [['Viral clip shows {prod} failing', 'A video appearing to show a failure of {prod} spread quickly online. {co} said it is looking into the incident.']],
    uncertain: [["Online debate over {co}'s {prod}", 'Social media users are split over {prod}, with some praising it and others complaining. {co} has not commented.']],
  },
  rumor: {
    positive: [['Reports say {peer} considering bid for {co}', 'Unconfirmed reports suggest {peer} has looked at acquiring {co}. Neither company commented, and no offer has been made.']],
    negative: [['Rumor of trouble at {co} spreads online', 'Unverified posts claim {co} faces a cash crunch. The company called the claims false.']],
    uncertain: [['Rumors swirl around {co}', 'Unconfirmed online chatter about {co} grew through the day. The company said it does not comment on speculation.']],
  },
  investor: {
    positive: [['Famed investor {person} discloses stake in {co}', '{person}, known for long-term bets, revealed a position in {co}, according to a filing that drew wide attention.']],
    negative: [['Famed investor {person} sells {co} shares', '{person} told followers the position in {co} has been closed, saying better opportunities exist elsewhere.']],
    uncertain: [['Investor {person} comments on {co}', '{person} said {co} was interesting but gave no details about any trade.']],
  },
  founder: {
    positive: [["{ceo}'s surprise announcement stirs excitement around {co}", 'In a livestream, {ceo} teased a bold new direction for {prod}. The clip drew millions of views within hours.']],
    negative: [["{ceo}'s remarks spark backlash for {co}", 'Comments made by {ceo} in an interview drew criticism online, and {co} issued a clarification.']],
    uncertain: [['{ceo} stays cryptic about {co} plans', 'In an interview that went viral, {ceo} hinted at big news soon without saying what it is.']],
  },
  whistleblower: {
    positive: [["Whistleblower's claims about rival help {co}", 'A former employee at a competitor made claims that put the rival under pressure, possibly benefiting {co}.']],
    negative: [['Whistleblower claims surface at {co}', 'A former employee made allegations about practices at {co}. The company denied wrongdoing and said it would cooperate with any review.']],
    uncertain: [['Former employee posts claims about {co}', 'A former worker wrote about conditions at {co}; the company disputes the account and says it has not been verified.']],
  },
  official: {
    positive: [['Minister {person} praises {sector} industry', 'Comments by {person} in a widely shared speech signaled strong government support for the {sector} industry.']],
    negative: [['Minister {person} threatens crackdown on {sector} firms', '{person} said the industry may face tougher rules, in remarks that spread quickly online.']],
    uncertain: [['Minister {person} comments on {sector} sector', 'A short remark by {person} about the {sector} industry sent investors scrambling to interpret its meaning.']],
  },
};

/** Follow-ups when a low-credibility story fades. */
export const VIRAL_FADE_TEMPLATES: TemplateSet = {
  negative: [
    ['{co} denies reports; online hype fades', '{co} said there is no truth to recent reports, and the enthusiasm that followed them cooled.'],
    ['Excitement over {co} cools', 'Analysts said the earlier surge of interest was not backed by any new information about {co}.'],
  ],
  positive: [
    ['Claims about {co} found to be unsupported', 'Independent checks found no support for earlier claims about {co}, and sentiment recovered.'],
    ['{co} shrugs off online rumor', 'The company said nothing has changed in its business and the rumor appears to have been unfounded.'],
  ],
};

/** Special events created by the owner (labelled in the feed). */
export const ADMIN_TEMPLATES: TemplateSet = {
  positive: [['Special event: {co} in the spotlight', 'A special event created by the TradeQuest team puts {co} in a favorable light.']],
  negative: [['Special event: trouble at {co}', 'A special event created by the TradeQuest team puts {co} under pressure.']],
  uncertain: [['Special event: all eyes on {co}', 'A special event created by the TradeQuest team has people talking about {co}.']],
};

export const ANALYST_FIRMS: readonly string[] = ['Ashgrove Research', 'Pinnacle Row Partners', 'Halvorsen & Pike', 'Northlight Securities', 'Calder Bay Capital', 'Merrow Street Advisors', 'Tallis Wren Research', 'Brightwater Equity Research', 'Fenwick Lane Analytics', 'Oakhurst & Vale'];
export const REGIONS: readonly string[] = ['Northern Europe', 'Southeast Asia', 'the Pacific coast', 'the Midwest', 'Latin America', 'the Gulf region', 'Eastern Canada', 'the Nordic countries', 'Central Asia', 'West Africa', 'the Alpine region', 'Australasia'];
export const PERSON_FIRST: readonly string[] = ['Aldous', 'Brielle', 'Casimir', 'Delphine', 'Emeric', 'Fenella', 'Gareth', 'Halima', 'Ivo', 'Jorunn', 'Kasimir', 'Lucinda', 'Matteo', 'Nerys', 'Orsino', 'Perpetua', 'Quentin', 'Rhiannon', 'Soren', 'Tamsin', 'Ulrich', 'Vesper', 'Wystan', 'Xenia', 'Yusuf', 'Zelda', 'Amias', 'Bettina', 'Corin', 'Dagny'];
export const PERSON_LAST: readonly string[] = ['Ashdown', 'Bellweather', 'Crestmoor', 'Dunmore', 'Eastcott', 'Fairbourne', 'Glenhaven', 'Hartnoll', 'Ivesley', 'Jarrold', 'Kestrelwood', 'Lovelace-Park', 'Marchmont', 'Netherby', 'Oakeshott', 'Pennywhistle', 'Quillfeather', 'Rookwood', 'Sandelin', 'Thistlewood', 'Underhill', 'Valmont', 'Whitlock', 'Yarrowby', 'Zellweger-Moss'];

/** Fills {slots}. Throws on an unknown slot so a typo in a template can never reach a player. */
export function fill(text: string, slots: Readonly<Record<string, string>>): string {
  const filled = text.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = slots[key];
    if (v === undefined) throw new Error(`News template uses {${key}} but no value was given: "${text}"`);
    return v;
  });
  // "Networks's" → "Networks'" (a possessive of a name that already ends in s)
  return filled.replace(/s's\b/g, "s'");
}

/** Every slot name a template mentions (used by tests). */
export function slotsIn(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string);
}
