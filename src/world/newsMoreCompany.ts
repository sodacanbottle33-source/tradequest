// More wordings for the company stories of stocks (newsText.ts has the first batch). Same format: [headline, body] with {slots}. Every company, person,
// firm and place named here is invented. Joined to the first batch by templateSets.ts; the extra ones go at the end of each list.
// Rules the tests check: only known {slots}; every partnership template names {peer}; no real names; no wording that is the same as an older one.

import type { CompanyCategory, TemplateSet } from './newsText';

const product: TemplateSet = {
  positive: [
    [`{co} adds new tier to {prod} lineup`, `The new tier targets customers who wanted more capacity without a big price jump. {co} said sign-ups were strong on the first day.`],
    [`{prod} passes {n} million users, says {co}`, `{co} said growth has been steady rather than sudden, with customers in {region} the fastest-growing group. {ceo} thanked the product team.`],
    [`{co} launches {prod2} alongside {prod}`, `The companion product shares parts with {prod}, which {co} said keeps costs down. Early orders came mostly from existing customers.`],
    [`Retailers expand shelf space for {co}'s {prod}`, `Several large chains said they will stock more of {prod} after strong sales in recent weeks. {co} did not give figures.`],
  ],
  negative: [
    [`{co} issues safety notice for {prod}`, `{co} asked customers to check a component in some units of {prod}. No injuries were reported, and a free replacement program has been set up.`],
    [`Reviewers give {co}'s {prod} a cool reception`, `Several reviewers said {prod} offers little over the previous version. Shares of {co} slipped as comparisons with rivals spread.`],
    [`{co} scales back {prod} launch plans`, `The company will release {prod} in fewer markets than first planned, saying it wants to protect quality. {ceo} said wider availability will follow later.`],
    [`Parts shortage hits {co}'s {prod}`, `A shortage of a key part is slowing production of {prod}. {co} said some customers will wait longer than expected for deliveries.`],
  ],
  uncertain: [
    [`{co} hints at successor to {prod}`, `In a short post, {co} said work on a successor to {prod} is under way. It gave no timing, and {ceo} declined to discuss details.`],
    [`{prod} gets mixed marks in customer survey`, `A survey of buyers found high praise for the design but frustration with the setup process. Analysts said it is unclear how that will affect {co}'s sales.`],
    [`{co} to rename {prod}`, `{co} said the new name is meant to simplify its range. Some analysts liked the idea; others worried customers will be confused.`],
    [`{co} tests {prod} in {region} before wider launch`, `A small trial of {prod} began this week. {co} said results will decide whether the rollout continues, and gave no deadline.`],
  ],
};

const partnership: TemplateSet = {
  positive: [
    [`{co} and {peer} to build {prod} together`, `The companies will pool engineers for a joint version of {prod}. {ceo} said the deal brings in skills {co} lacked.`],
    [`{peer} picks {co} as preferred supplier`, `{peer} named {co} its main supplier in {region} for the next several years. Neither side shared the value of the deal.`],
    [`{co} and {peer} open shared research lab`, `The lab will employ about {n}0 people and focus on products both companies sell. {peer} said it expects first results within a year.`],
    [`{co} takes small stake in {peer}`, `The investment deepens a relationship that began with a supply agreement. {cfo} said the stake is a vote of confidence in {peer}.`],
  ],
  negative: [
    [`{co} and {peer} scrap joint project`, `The two companies said they could not agree on how to share costs for {prod}. {co} said it will carry on alone.`],
    [`{peer} signs with rival, leaving {co} out`, `{peer} awarded a major agreement to a competitor of {co}. {co} said it remains on good terms with {peer} and will keep bidding.`],
    [`{co} and {peer} in dispute over payments`, `{peer} said {co} owes it money under a shared agreement, and {co} says the figures are wrong. Both are talking to lawyers.`],
    [`{peer} reduces orders from {co}`, `{peer} said it will buy less from {co} while it works down its own stock. {co} said the cut is temporary but gave no end date.`],
  ],
  uncertain: [
    [`{co} and {peer} extend talks on supply deal`, `The companies said talks are going well but need more time. {ceo} would not say whether a deal is close.`],
    [`{co} and {peer} to appear together at industry event`, `Both companies will speak on stage at a conference next week. Analysts expect an announcement but are split on whether it will be big.`],
    [`{peer} reviews its ties with {co}`, `{peer} said it is looking at all its suppliers and partners, {co} among them. It said no decisions have been made.`],
    [`{co} and {peer} swap staff for pilot project`, `A small group of engineers from each company will work at the other's site for six months. Both said it is a test and not a commitment.`],
  ],
};

const management: TemplateSet = {
  positive: [
    [`{co} hires {person} as chief technology officer`, `{person} joins from a larger rival and will lead engineering across {co}. {ceo} said the hire fills a gap the company has been trying to close for a year.`],
    [`{ceo} buys {co} shares on the open market`, `A filing showed the chief executive bought shares worth about {amt}. Investors often read such purchases as a sign of confidence.`],
    [`{co} promotes long-time insider to run operations`, `The new head of operations has spent most of a career at {co}. {ceo} said continuity matters while the company grows.`],
    [`{co} board adds two independent directors`, `The new directors bring experience from the {sector} industry. {co} said the move strengthens oversight and brings fresh thinking.`],
  ],
  negative: [
    [`{co} head of sales departs unexpectedly`, `{co} said the executive left to pursue other interests and that a search for a replacement is under way. Staff were told sales targets are unchanged.`],
    [`{ceo} sells part of {co} stake`, `A filing showed the chief executive sold shares worth about {amt}. {co} said the sale was planned in advance and for personal reasons.`],
    [`Several senior managers leave {co}`, `At least three senior managers have left in recent weeks, according to people familiar with the matter. {co} said it is not concerned.`],
    [`{co} chairman steps down after disagreement`, `The chairman resigned after the board could not agree on strategy. {co} said an interim chairman has been named.`],
  ],
  uncertain: [
    [`{co} to name new chief financial officer soon`, `{co} said a successor to {cfo} will be named in the coming weeks. It gave no hint about who is on the shortlist.`],
    [`{co} board reviews pay for top executives`, `A committee is looking at how executives are rewarded. Some investors want pay tied more closely to results; {co} said it will listen.`],
    [`{ceo} says succession plan is being drawn up`, `{ceo} told staff a succession plan is a routine step, not a sign of leaving. {co} did not give a timetable.`],
    [`{co} appoints advisory panel on strategy`, `A group of outside experts will advise {co}'s management for a year. The company said the panel has no decision-making powers.`],
  ],
};

const legal: TemplateSet = {
  positive: [
    [`Regulator clears {co}'s planned acquisition`, `A competition regulator said it found no concerns with {co}'s planned purchase, removing a hurdle that had worried investors.`],
    [`Court throws out claim against {co}`, `A judge dismissed a case about {prod}, saying the evidence did not support the claim. {co} welcomed the decision.`],
    [`{co} settles dispute on favorable terms`, `{co} agreed to resolve a long-running disagreement with a former supplier for less than analysts had feared. Details were not published.`],
    [`{co} wins approval to sell {prod} in {region}`, `Regulators in {region} approved {prod} after a lengthy review. {co} said sales can begin within weeks.`],
  ],
  negative: [
    [`Regulator takes a closer look at {co}`, `A regulator said it is examining how {co} markets {prod}. {co} said it will cooperate fully and believes it followed the rules.`],
    [`{co} faces fine over reporting lapses`, `A regulator said {co} was late filing some required reports. {co} said it has improved its processes and will pay the penalty.`],
    [`Class action filed against {co}`, `Shareholders filed a case claiming {co} misled them about demand for {prod}. {co} said the claims are without merit.`],
    [`Judge sides with rival in {co} patent dispute`, `A court sided with a rival in a dispute over technology used in {prod}. {co} said it will appeal.`],
  ],
  uncertain: [
    [`{co} receives request for information from regulator`, `A regulator asked {co} for documents about its business practices. {co} said such requests are routine and does not expect a problem.`],
    [`Appeal in {co} case set for next quarter`, `A higher court will hear an appeal involving {prod} later this year. Lawyers said it could go either way.`],
    [`Lawmakers question {co} over {prod}`, `A committee asked {co} to explain how {prod} handles customer data. {co} said it will send a written answer.`],
    [`{co} and rival trade claims in patent filings`, `Both companies filed documents this week making claims about each other's technology. Legal experts said the first ruling is months away.`],
  ],
};

const operations: TemplateSet = {
  positive: [
    [`{co} cuts delivery times after logistics upgrade`, `Orders of {prod} now reach customers days earlier, {co} said. {ceo} credited a new warehouse system.`],
    [`{co} signs long-term power deal to lower costs`, `The agreement fixes energy prices for several years at a lower level than {co} pays now. {cfo} said savings will show up next year.`],
    [`{co} reports fewer defects after factory upgrade`, `Quality checks showed a steady drop in faulty units since new equipment came online. {co} said returns of {prod} are down sharply.`],
    [`{co} hires {n}00 staff as it expands in {region}`, `The hiring spree will staff a new customer center. {ceo} said demand in {region} has outgrown the company's existing capacity.`],
  ],
  negative: [
    [`{co} faces strike at {region} plant`, `Workers walked out over pay and schedules. {co} said it is talking to the union and that output of {prod} may be affected.`],
    [`Storm damages {co} warehouse`, `Severe weather damaged a distribution center in {region}. {co} said stock is being moved and that some orders will be late.`],
    [`{co} warns of higher shipping costs`, `{cfo} said freight rates are eating into margins on {prod}. The company is looking for ways to pass some of the cost on.`],
    [`{co} closes older plant and cuts jobs`, `The company said the plant is no longer efficient and will close by year-end. About {n}0 jobs are affected.`],
  ],
  uncertain: [
    [`{co} reviews supplier network`, `{co} is checking whether it relies too heavily on a few suppliers. {ceo} said changes are possible but nothing has been decided.`],
    [`{co} tests automated warehouse`, `A pilot site will use robots to move goods for {prod}. {co} said the trial will show whether the savings are real.`],
    [`{co} plans maintenance shutdown at {region} site`, `The site will pause output for several days for planned work. {co} said it built up stock beforehand, but timing could slip.`],
    [`{co} considers moving some work overseas`, `{co} confirmed it is studying options for part of its manufacturing. {ceo} said no decision will be made this year.`],
  ],
};

const financial: TemplateSet = {
  positive: [
    [`{co} raises dividend`, `The board lifted the payout, which {cfo} said reflects steady cash flow and confidence in the next few years.`],
    [`{co} pays down debt ahead of schedule`, `{co} repaid a large loan early and said interest costs will fall as a result. {cfo} called it a step toward a stronger balance sheet.`],
    [`Credit agency lifts outlook on {co}`, `A ratings agency raised its outlook on {co}'s debt, citing stronger cash generation. {co} said the news lowers its future borrowing costs.`],
    [`{co} lifts forecast after strong sales of {prod}`, `{cfo} said strong sales of {prod} mean results should come in above earlier guidance.`],
  ],
  negative: [
    [`{co} halts its dividend payout`, `The board halted the payout to conserve cash. {cfo} said it will review the decision when conditions improve.`],
    [`{co} announces {amt} share sale`, `{co} will sell new shares to raise money for expansion. Existing holders will own a smaller slice of the company afterward.`],
    [`Ratings agency lowers {co} credit outlook`, `An agency cut its outlook on {co}'s debt, citing weaker cash flow. {co} said it disagrees but will keep the agency informed.`],
    [`{co} takes charge on write-down`, `{cfo} said {co} will write down the value of an earlier purchase. The charge will reduce reported profit this period.`],
  ],
  uncertain: [
    [`{co} explores sale of non-core unit`, `{co} said it is looking at options for a smaller business. {cfo} said it may keep the unit or sell it.`],
    [`{co} refinances debt on new terms`, `{co} replaced some existing loans with new ones. Analysts said the effect depends on how interest rates move.`],
    [`{co} announces investor day`, `{co} will walk investors through its long-term plans next month. It did not say whether it will update its forecasts.`],
    [`{co} issues bonds to fund projects`, `The company raised money by selling bonds. Some analysts liked the price; others said the debt load is growing.`],
  ],
};

const analyst: TemplateSet = {
  positive: [
    [`{firm} adds {co} to its top picks list`, `{person} said {co} offers the best mix of growth and value in the {sector} industry.`],
    [`{firm} raises price target on {co}`, `{person} lifted the target after meetings with management, saying demand for {prod} is stronger than most forecasts assume.`],
    [`{person} of {firm} starts {co} with a buy rating`, `The analyst said {co} is well placed to gain share, and pointed to its record in {region}.`],
    [`{firm} says {co} is undervalued`, `A new report argues the market is ignoring the strength of {co}'s cash flow. {person} sees room for the shares to rise.`],
  ],
  negative: [
    [`{firm} lowers price target on {co}`, `{person} cut the target, saying competition for {prod} is heating up and margins are likely to shrink.`],
    [`{person} of {firm} starts {co} with a sell rating`, `The analyst warned that {co} looks expensive compared with others in the {sector} industry.`],
    [`{firm} removes {co} from its favored list`, `{person} said {co} no longer stands out and that better opportunities exist elsewhere.`],
    [`{firm} warns of slowing growth at {co}`, `A report said growth for {co} is likely to cool over the next year. {person} cut estimates for revenue.`],
  ],
  uncertain: [
    [`{firm} reviews rating on {co}`, `{person} said the rating is under review while the firm waits for more information. No change was made today.`],
    [`Analysts divided over {co} outlook`, `{firm} sees upside while other firms see limited gains. {co} declined to comment on the differing views.`],
    [`{firm} raises estimates on {co} but keeps neutral view`, `{person} said better results are already expected by the market. The rating was left unchanged.`],
    [`{person} of {firm} to host call on {co}`, `The call will cover {co}'s plans for {prod}. The firm did not say whether it expects to change its rating.`],
  ],
};

const contract: TemplateSet = {
  positive: [
    [`{co} renews contract with largest customer`, `The new agreement runs for several years at similar prices. {ceo} said it gives {co} reliable income.`],
    [`{co} chosen for government program`, `{co} will supply {prod} under a program in {region}. The contract is worth about {amt} over its life.`],
    [`{co} secures follow-on order for {prod}`, `A customer that bought {prod} last year placed a larger repeat order. {co} said it shows the product delivers.`],
    [`{co} signs distribution deal in {region}`, `A large distributor will carry {prod} across {region}, which {co} said opens many new sales points.`],
  ],
  negative: [
    [`{co} loses bid for major contract`, `{co} was passed over in favor of a rival for a big contract. {ceo} said the company will examine why it lost.`],
    [`Customer cancels part of {co} order`, `A customer reduced its order of {prod}, saying its own plans changed. {co} said it will try to resell the capacity.`],
    [`{co} faces penalty on delayed delivery`, `{co} said it will pay a penalty after late delivery under an existing agreement. {cfo} said the cost is modest.`],
    [`{co} renews key contract at lower price`, `A key customer renewed but only after {co} agreed to cut prices. Analysts said margins will be squeezed.`],
  ],
  uncertain: [
    [`{co} shortlisted for large contract`, `{co} is one of three companies still in the running. A decision is expected later this year.`],
    [`{co} in talks to extend supply agreement`, `Talks are under way with a major customer. {ceo} said the discussions are constructive but declined to say when they will end.`],
    [`{co} reviews terms of {amt} agreement`, `{co} and a customer are renegotiating parts of an existing deal. Neither would say what is being changed.`],
    [`{co} awaits decision on contract protest`, `A rival has challenged an award to {co}. The outcome is expected within weeks.`],
  ],
};

const research: TemplateSet = {
  positive: [
    [`{co} files patent for technology behind {prod}`, `The filing covers a method that could make {prod} cheaper to make. {ceo} said it strengthens the company's position.`],
    [`{co} moves {prod2} into next phase of testing`, `Test results were good enough to proceed. {co} said the next phase will involve a larger group and last about a year.`],
    [`{co} prototype beats targets in field trial`, `A working model of {prod2} outperformed the company's goals in outdoor tests. {ceo} said the team will now work on scaling production.`],
    [`{co} publishes encouraging study`, `Independent experts reviewed the study and called the results promising. {co} said more work is needed but is pleased.`],
  ],
  negative: [
    [`{co} halts trial of {prod2}`, `A safety review led {co} to pause the trial while it studies the data. {ceo} said it is a precaution.`],
    [`{co} prototype fails key test`, `A model of {prod2} did not meet performance goals in a recent test. {co} said engineers are examining what went wrong.`],
    [`Key researcher leaves {co}`, `The scientist who led work on {prod2} has left for a rival, according to people familiar with the matter. {co} said the project continues.`],
    [`{co} delays results from study`, `{co} said analysis is taking longer than expected, and results will now come next quarter.`],
  ],
  uncertain: [
    [`{co} to present research at conference`, `{co} will share findings on {prod2} at a scientific meeting next month. It gave no hint about what the data shows.`],
    [`{co} adds partner site to its study`, `A university in {region} will join the work on {prod2}. {co} said it will broaden the data but may also add time.`],
    [`Reviewers question {co} study design`, `Outside experts said the study could have been set up differently. {co} said the design is standard in its field.`],
    [`{co} seeks extra funding for research`, `{co} said it is exploring ways to fund the next stage, including partners. {cfo} gave no figures.`],
  ],
};

const incident: TemplateSet = {
  negative: [
    [`Outage hits {co} services for hours`, `A technical failure took {prod} offline for most of the day. {co} apologized and said it has restored service.`],
    [`Fire damages {co} facility in {region}`, `A fire broke out at one of the company's sites. No one was hurt, but {co} said output of {prod} will be reduced while repairs are made.`],
    [`{co} warns of customer data exposure`, `{co} said some customer details may have been seen by outsiders. It has informed regulators and is offering credit monitoring.`],
    [`Accident at {co} site prompts safety review`, `An accident at a site in {region} led to a safety review. {co} said the injured workers are recovering and operations are partly paused.`],
    [`{co} forced to recall {prod} after complaints`, `{co} said it is pulling {prod} from shelves while it investigates reports of faults. The cost is not yet known.`],
    [`Cyber attack disrupts {co} operations`, `Systems at {co} were taken offline after an attack. {ceo} said the company is restoring them and has found no sign that money was stolen.`],
  ],
  uncertain: [
    [`{co} investigates unusual trading in its shares`, `{co} said it noticed unusual activity ahead of a recent announcement and has asked the exchange to look into it.`],
    [`{co} responds to complaints about {prod}`, `A number of customers posted complaints this week. {co} said it is reviewing the cases and will update soon.`],
    [`{co} reviews safety after near miss`, `No one was hurt, {co} said, but the incident at its {region} site has prompted a full review of procedures.`],
    [`Power cut briefly stops {co} production`, `A local power cut halted output for part of a day. {co} said it does not expect a lasting effect, but is checking.`],
    [`Reports of faults in {prod} under review at {co}`, `{co} said it has seen a small number of reports and is examining whether there is a common cause.`],
  ],
};

const demand: TemplateSet = {
  positive: [
    [`Waiting lists grow for {co}'s {prod}`, `{co} said customers are waiting weeks for {prod}, and that it is adding shifts to catch up.`],
    [`{co} says {prod} sales beat plan in {region}`, `Sales of {prod} in {region} came in {pct}% above the company's own target. {ceo} called it a strong start.`],
    [`Repeat purchases rise at {co}`, `More customers are coming back to buy again, {cfo} said, a sign that {prod} is keeping them satisfied.`],
    [`{co} reports busiest month on record`, `Orders hit a new high last month, {co} said, led by {prod}.`],
  ],
  negative: [
    [`{co} sees fewer new customers`, `Sign-ups for {prod} slowed over the past month. {cfo} said marketing is being reviewed.`],
    [`Inventory piles up at {co}`, `Unsold stock of {prod} has grown, {co} said, and discounts may be needed to clear it.`],
    [`{co} says customers are trading down`, `{cfo} said buyers are choosing cheaper versions of {prod}, which lowers the average price per sale.`],
    [`Orders for {co}'s {prod} fall {pct}%`, `{co} said demand weakened over the quarter as customers held off big purchases.`],
  ],
  uncertain: [
    [`{co} says demand is shifting between product lines`, `Sales of {prod} are slipping while {prod2} is gaining. {cfo} said the net effect is hard to predict.`],
    [`Seasonal swings cloud outlook at {co}`, `{co} said it is hard to tell how much of the recent change in orders is seasonal and how much is lasting.`],
    [`{co} sees uneven demand across {region}`, `Some areas are buying more and others less, {ceo} said, so the company is holding off on changing its plans.`],
    [`{co} surveys customers on future buying plans`, `A survey of customers found mixed intentions. {co} said the results are being studied.`],
  ],
};

/** The extra company templates, by category (joined to COMPANY_TEMPLATES in newsText.ts). */
export const MORE_COMPANY_TEMPLATES: Readonly<Record<CompanyCategory, TemplateSet>> = {
  product,
  partnership,
  management,
  legal,
  operations,
  financial,
  analyst,
  contract,
  research,
  incident,
  demand,
};
