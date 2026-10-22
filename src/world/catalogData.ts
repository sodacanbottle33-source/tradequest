// The hand-written companies of the persistent world. Every company, product, person and ticker is invented.
// Positions are permanent: ids 0–9 are the ten original TradeQuest stocks (same tickers and names as the live and classic
// modes), ids 10 and up were added in catalog version 1. Never reorder or delete an entry — add new ones at the end
// (or let the procedural generator in catalog.ts continue after the last one).
// Tickers were NOT checked against real exchanges for ids ≥ 10 (the original ten were web-checked on 2026-10-15,
// rules.md §12.2). Recheck all of them before any public launch.

import type { Personality, SectorId, Tier } from './params';

/**
 * The numbers a memecoin carries itself. Every other company gets its numbers from its size class and personality; a coin is wilder
 * than any size class allows, so each one states its own. They are saved with the coin (server/schema.ts, table meme_companies) and
 * never change afterwards, like everything else in the catalog.
 */
export interface MemeProfile {
  /** Coins in circulation. Market cap = price × this. */
  readonly supply: number;
  /** Share of the supply that is freely tradable (0 … 1). */
  readonly floatFrac: number;
  /** Share of the supply traded per day (can be above 1: coins change hands several times a day). */
  readonly turnover: number;
  /** 0 … 1, like a stock's: how easily large orders are absorbed. Also sets the spread. */
  readonly liquidity: number;
  /** Typical price change over 3 minutes (one standard deviation, fraction). Stocks stay below 0.085; coins go far above. */
  readonly vol3m: number;
  /** Fundamental-value change per day (one standard deviation, fraction). */
  readonly dailyVol: number;
  /** How strongly news moves the coin (a stock's is 0.5 … 1.9). */
  readonly newsImpact: number;
  /** Size of a trend regime's daily drift (fraction per day). */
  readonly driftDay: number;
  /** The anonymous developer's handle (the "chief executive" of the coin in news). */
  readonly dev: string;
}

export interface CatalogEntry {
  readonly ticker: string;
  readonly name: string;
  readonly sector: SectorId;
  readonly industry: string;
  readonly tier: Tier;
  /** Price at listing, in cents. */
  readonly price: number;
  readonly personality: Personality;
  /** Two products or services, used in news. */
  readonly products: readonly [string, string];
  readonly description: string;
  /** Only memecoins (sector 'meme') have this. */
  readonly meme?: MemeProfile;
}

const e = (
  ticker: string,
  name: string,
  sector: SectorId,
  industry: string,
  tier: Tier,
  price: number,
  personality: Personality,
  p1: string,
  p2: string,
  description: string,
): CatalogEntry => ({ ticker, name, sector, industry, tier, price, personality, products: [p1, p2], description });

export const CATALOG_VERSION = 1;

export const CURATED: readonly CatalogEntry[] = [
  // ---- the original ten (ids 0–9) ----
  e('QLRX', 'Quellaris Energy', 'energy', 'Oil, gas and power generation', 'mid', 3500, 'steady', 'Quellaris Gridpower', 'Northfield Gas Network', 'Integrated energy company operating gas fields, regional pipelines and gas-fired power plants.'),
  e('NVRA', 'Novera Systems', 'tech', 'Enterprise software', 'large', 9000, 'growth', 'Novera Core', 'Lattice Cloud', 'Sells operating software and cloud tooling that mid-sized banks and logistics firms run their daily operations on.'),
  e('BRLF', 'Brookleaf Foods', 'consumer', 'Packaged foods', 'mid', 1150, 'steady', 'Brookleaf Oat Bakes', 'Meadow Fresh soups', 'Maker of everyday packaged foods such as cereals, soups and frozen meals, sold through supermarkets.'),
  e('HLQN', 'Helioquin Biotech', 'health', 'Biotechnology', 'small', 2600, 'volatile', 'HQ-114 antibody', 'Helio-Scan assay', 'Clinical-stage biotech developing antibody treatments for autoimmune disease; its value hinges on trial results.'),
  e('MRDL', 'Mardell Rail & Freight', 'transport', 'Rail freight', 'mid', 5250, 'steady', 'Mardell Intermodal', 'Prairie Line', 'Operates freight railways and container terminals across the interior of the continent.'),
  e('ZYRA', 'Zyra Airways', 'transport', 'Airlines', 'small', 2500, 'cyclical', 'Zyra Connect', 'Zyra Cargo', 'Regional passenger airline with a growing cargo business; sensitive to fuel prices and holiday demand.'),
  e('TVLM', 'Tavelum Metals', 'industrial', 'Metals and mining', 'mid', 4000, 'cyclical', 'Tavelum Copper', 'Redrock Alloys', 'Mines and smelts copper and aluminium, selling mostly to construction and electrical manufacturers.'),
  e('SKVR', 'Skyvere Aerospace', 'aero', 'Aircraft and defense', 'large', 11500, 'steady', 'Skyvere Sparrow trainer', 'Skyvere Vantage radar', 'Builds commercial aircraft components and military trainers under multi-year government contracts.'),
  e('PLNB', 'Pellmont Bancorp', 'finance', 'Regional banking', 'mid', 7000, 'steady', 'Pellmont Everyday Checking', 'Pellmont Small Business Loans', 'Regional bank holding company with branches across five states and a strong small-business lending arm.'),
  e('VRDW', 'Verdane Water Utilities', 'utilities', 'Water utilities', 'mid', 2500, 'income', 'Verdane Reservoir System', 'Verdane Smart Meters', 'Regulated water and wastewater utility serving a few million customers with predictable, slow-growing income.'),
  // ---- technology ----
  e('CLMR', 'Cloudmere Software', 'tech', 'Cloud infrastructure', 'mid', 4200, 'steady', 'Cloudmere Vault', 'Streamline pipelines', 'Provides cloud storage and data-pipeline services to online retailers and media companies.'),
  e('PXLG', 'Pixelgrove Semiconductors', 'tech', 'Semiconductors', 'large', 12800, 'cyclical', 'Grove-7 processor', 'PixelCore graphics chips', 'Designs processors and graphics chips sold into phones, cars and data centers; earnings follow the chip cycle.'),
  e('QBTN', 'Quibiton Networks', 'tech', 'Network security', 'mid', 3600, 'steady', 'Quibiton Sentinel', 'Gatewall firewalls', 'Network-security appliances and subscriptions protecting corporate offices and hospitals from cyber attacks.'),
  e('SYNQ', 'Synqrio Data', 'tech', 'Analytics software', 'small', 1800, 'growth', 'Synqrio Pulse', 'DataLoom', 'Subscription analytics platform that helps retailers forecast demand; small but fast-growing.'),
  e('DWLN', 'Dawnline Devices', 'tech', 'Consumer electronics', 'large', 6400, 'cyclical', 'Dawnline Halo phone', 'Dawnline Loop earbuds', 'Designs phones, earbuds and smart-home gadgets; sales surge around product launches and holidays.'),
  // ---- artificial intelligence ----
  e('MNDR', 'Mindrift AI', 'ai', 'Enterprise AI models', 'mid', 5500, 'growth', 'Mindrift Atlas', 'Driftwork agents', 'Builds large language models that businesses license to draft documents, answer customer questions and write code.'),
  e('TNSR', 'Tensorvale', 'ai', 'AI hardware', 'large', 21000, 'growth', 'Vale-X accelerator', 'Tensorvale Cluster racks', 'Makes the accelerator chips and server racks that AI labs buy to train their models; demand is intense but lumpy.'),
  e('COGA', 'Cogniva Labs', 'ai', 'AI customer support', 'small', 1400, 'volatile', 'Cogniva Concierge', 'VoiceDesk', 'Sells AI assistants that answer support calls and chats for telecom and travel companies.'),
  e('VLMD', 'Valemind Imaging', 'ai', 'Medical imaging AI', 'small', 2200, 'growth', 'Valemind Radiant', 'ScanSight', 'Software that reads X-rays and scans to flag early signs of disease, sold to hospital networks.'),
  e('AXNC', 'Axonic Systems', 'ai', 'Neural computing', 'mid', 3300, 'volatile', 'Axonic Mesh', 'Synapse Edge chips', 'Low-power neural-network chips and software for cameras, drones and factory sensors.'),
  e('PRMW', 'Promptwell', 'ai', 'AI developer tools', 'micro', 600, 'volatile', 'Promptwell Studio', 'EvalKit', 'Tiny start-up selling tools that help developers test and tune AI prompts; a speculative small stock.'),
  // ---- robotics ----
  e('RVNX', 'Rovonix Robotics', 'robotics', 'Warehouse robots', 'mid', 4700, 'growth', 'Rovonix Picker', 'Hive fleet software', 'Autonomous warehouse robots and fleet software sold to e-commerce and grocery distributors.'),
  e('GRHV', 'Gearhaven Automation', 'robotics', 'Industrial automation', 'mid', 3800, 'steady', 'Gearhaven Armline', 'TorqueSense', 'Robot arms and control systems for car factories, with steady orders from long-term customers.'),
  e('KNQD', 'Kinetiq Dynamics', 'robotics', 'Humanoid robots', 'small', 2700, 'volatile', 'Kinetiq Walker', 'Kinetiq Hand', 'Developing humanoid robots for logistics and elder care; spectacular demos, few paying customers yet.'),
  e('ATPL', 'Autopilar', 'robotics', 'Agricultural automation', 'micro', 800, 'turnaround', 'Autopilar Harvest', 'FieldScout drones', 'Farm robots that pick fruit and weed fields; restructuring after a difficult couple of years.'),
  // ---- energy ----
  e('SLVN', 'Solvane Renewables', 'energy', 'Solar power', 'mid', 2900, 'growth', 'Solvane Sunfield', 'SunLease', 'Builds and operates utility-scale solar farms and leases rooftop systems to businesses.'),
  e('IRPK', 'Ironpeak Petroleum', 'energy', 'Oil and gas', 'large', 7200, 'cyclical', 'Ironpeak Deepwater', 'Peakline Refining', 'Oil producer and refiner whose profits swing with crude prices.'),
  e('VLTM', 'Voltmere Storage', 'energy', 'Battery storage', 'small', 1900, 'volatile', 'Voltmere GridPack', 'Cellforge', 'Grid-scale battery systems that store solar and wind power for utilities.'),
  e('BWNC', 'Brightwell Nuclear', 'energy', 'Nuclear power', 'small', 3300, 'turnaround', 'Brightwell SMR-60', 'Brightwell Fuel Services', 'Developer of small modular nuclear reactors, working through approvals and cost overruns.'),
  e('TDLN', 'Tidalon Power', 'energy', 'Offshore wind and tidal', 'micro', 1100, 'volatile', 'Tidalon Arrays', 'Seabreeze turbines', 'Early-stage offshore wind and tidal-energy developer that depends on government subsidies.'),
  // ---- healthcare ----
  e('CRVL', 'Curevale Pharmaceuticals', 'health', 'Generic drugs', 'large', 5800, 'steady', 'Curevale Generics', 'PharmaPack', 'Large maker of generic medicines with a wide portfolio and thin but dependable margins.'),
  e('MDRD', 'Medira Devices', 'health', 'Medical devices', 'mid', 8100, 'growth', 'Medira Precision robot', 'Medira Stent line', 'Surgical instruments and implants sold to hospitals worldwide; steady growth from an aging population.'),
  e('GNVT', 'Genovia Therapeutics', 'health', 'Gene therapy', 'small', 1700, 'volatile', 'GNV-301', 'Genovia Vector Platform', 'Gene-therapy developer with several trials in progress; any result can move the stock sharply.'),
  e('NVDX', 'Nuvia Diagnostics', 'health', 'Diagnostic tests', 'mid', 2400, 'cyclical', 'Nuvia RapidTest', 'LabLink', 'Rapid diagnostic tests and lab services whose demand rises and falls with outbreaks.'),
  e('PLSM', 'Pulsemark Health', 'health', 'Wearable health devices', 'small', 1200, 'growth', 'Pulsemark Band', 'Pulsemark Care app', 'Wearable monitors that track heart rhythm and sleep, with a subscription health-coaching app.'),
  e('ORBC', 'Orbis Clinics', 'health', 'Outpatient clinics', 'mid', 4400, 'steady', 'Orbis Urgent Care', 'Orbis Telehealth', 'Chain of urgent-care and outpatient clinics with a growing telehealth service.'),
  // ---- financials ----
  e('HRGC', 'Harrowgate Capital', 'finance', 'Investment banking', 'large', 11200, 'cyclical', 'Harrowgate Advisory', 'Harrowgate Trading', 'Investment bank earning fees from mergers, stock offerings and trading; busy markets make it very profitable.'),
  e('LDGR', 'Ledgerly Payments', 'finance', 'Payments', 'large', 9500, 'growth', 'Ledgerly Pay', 'Ledgerly Merchant', 'Payments network handling card and mobile transactions for millions of shops and apps.'),
  e('ARDM', 'Ardent Mutual', 'finance', 'Insurance', 'mid', 5200, 'income', 'Ardent Home Cover', 'Ardent Life', 'Home, car and life insurer with a large, stable customer base and a reliable dividend.'),
  e('CNDF', 'Cinderfield Credit', 'finance', 'Consumer lending', 'small', 1300, 'declining', 'Cinderfield Card', 'QuickAdvance loans', 'Subprime credit-card and personal-loan lender struggling with rising defaults.'),
  // ---- transportation ----
  e('SFLX', 'Seaflux Shipping', 'transport', 'Container shipping', 'mid', 3100, 'cyclical', 'Seaflux Atlantic Line', 'Seaflux Reefer', 'Container-ship operator whose earnings follow global freight rates.'),
  e('HLMK', 'Haulmark Logistics', 'transport', 'Trucking and logistics', 'mid', 3900, 'steady', 'Haulmark Express', 'Haulmark Cold Chain', 'Trucking and warehousing company moving goods for retailers and manufacturers.'),
  e('SKLP', 'Skyloop Mobility', 'transport', 'Urban air mobility', 'micro', 900, 'volatile', 'Skyloop Hopper', 'Skyloop Vertiport', 'Pre-revenue developer of electric air taxis; progress depends on aviation approvals and funding.'),
  // ---- consumer goods ----
  e('THRD', 'Threadline Apparel', 'consumer', 'Apparel', 'small', 2100, 'cyclical', 'Threadline Basics', 'Threadline Active', 'Mid-priced clothing brand sold online and in mall stores; sales depend on fashion trends.'),
  e('HRTH', 'Hearthstone Home', 'consumer', 'Home goods retail', 'mid', 4800, 'steady', 'Hearthstone Living', 'Hearthstone Kitchen', 'Home-furnishings retailer with stores and a growing online business.'),
  e('FZWK', 'Fizzwick Beverages', 'consumer', 'Beverages', 'large', 7700, 'steady', 'Fizzwick Spark', 'Fizzwick Zero', 'Soft-drink and energy-drink company with brands sold in almost every convenience store.'),
  e('PWPT', 'Pawprint Pet Co', 'consumer', 'Pet products', 'small', 1600, 'growth', 'Pawprint Fresh food', 'Pawprint Vet Plan', 'Premium pet-food and pet-insurance business riding a boom in pet ownership.'),
  e('GRBK', 'Greenbasket Grocers', 'consumer', 'Grocery retail', 'mid', 2700, 'income', 'Greenbasket Market', 'Greenbasket Delivery', 'Supermarket chain known for low prices, with low growth and dependable cash flow.'),
  // ---- entertainment and media ----
  e('SFRG', 'Starforge Games', 'media', 'Video games', 'mid', 5800, 'volatile', 'Starforge Legends', 'Rift Racers', 'Video-game publisher whose stock moves with big releases and review scores.'),
  e('LMRL', 'Lumenreel Studios', 'media', 'Film and streaming', 'large', 6600, 'cyclical', 'Lumenreel Plus', 'Lumenreel Pictures', 'Film studio and streaming service; blockbuster seasons lift subscriptions.'),
  e('ECBX', 'Echobox Audio', 'media', 'Music and podcasts', 'small', 1500, 'turnaround', 'Echobox Streams', 'PodForge', 'Audio-streaming service trying to turn podcasts and live audio into a profitable business.'),
  e('MQAR', 'Marquee Arenas', 'media', 'Live events', 'small', 2300, 'cyclical', 'Marquee Arenas', 'TicketVault', 'Owns concert arenas and a ticketing platform; busy touring seasons drive profits.'),
  e('PXPR', 'Pixelpress Publishing', 'media', 'Digital publishing', 'micro', 500, 'declining', 'Pixelpress Daily', 'Pressroom network', 'Digital magazines and news sites facing falling advertising revenue.'),
  // ---- industrials and materials ----
  e('BCST', 'Brightcast Steel', 'industrial', 'Steel', 'mid', 3400, 'cyclical', 'Brightcast Rebar', 'Brightcast Coil', 'Steel producer selling to builders and car makers; profits follow construction activity.'),
  e('ARGC', 'Argentum Chemicals', 'industrial', 'Specialty chemicals', 'large', 8800, 'steady', 'Argentum Coatings', 'Argentum Catalysts', 'Specialty coatings and catalysts sold to manufacturers on long contracts.'),
  e('TRMN', 'Terraform Mining', 'industrial', 'Lithium and rare earths', 'small', 2000, 'volatile', 'Terraform Lithium', 'Rareline magnets', 'Mines lithium and rare-earth metals for batteries and magnets; prices swing with demand.'),
  e('BLDW', 'Buildwell Construction', 'industrial', 'Construction', 'mid', 4600, 'cyclical', 'Buildwell Infrastructure', 'Buildwell Homes', 'Builds bridges, roads and housing developments; sensitive to interest rates and government spending.'),
  // ---- aerospace and defense ----
  e('AGSO', 'Aegis Orbital', 'aero', 'Satellites', 'small', 2900, 'growth', 'Aegis Constellation', 'Aegis Ground Stations', 'Launches and operates small communication and Earth-observation satellites.'),
  e('VDWK', 'Vanguard Drone Works', 'aero', 'Defense drones', 'mid', 5300, 'growth', 'Vanguard Sentry', 'Vanguard Courier', 'Builds surveillance and cargo drones for defense and disaster-response customers.'),
  // ---- utilities and infrastructure ----
  e('GRDL', 'Gridline Electric', 'utilities', 'Electric utility', 'large', 6100, 'income', 'Gridline Power', 'Gridline Smart Grid', 'Regulated electric utility with a long-running dividend and modernization plans.'),
  e('LMNO', 'Lumeno Telecom', 'utilities', 'Telecom infrastructure', 'large', 3400, 'income', 'Lumeno Fiber', 'Lumeno Towers', 'Owns fiber networks and cell towers that carriers rent on long contracts.'),
  // ---- emerging industries ----
  e('FSNL', 'Fusionary Labs', 'emerging', 'Fusion energy research', 'micro', 1400, 'volatile', 'Fusionary Tokamak Mk2', 'Plasma Core', 'Research company chasing commercial fusion power; every experiment is headline news.'),
  e('QNTS', 'Quantaris Computing', 'emerging', 'Quantum computing', 'small', 3100, 'volatile', 'Quantaris Q-48', 'Qubit Cloud', 'Builds quantum computers and rents access through the cloud; big promises, early revenue.'),
  e('CLTF', 'Cultura Foods', 'emerging', 'Lab-grown meat', 'micro', 700, 'turnaround', 'Cultura Cutlet', 'Cultura Bioreactor', 'Grows meat from cells and is working to cut costs and win regulatory approvals.'),
  e('ORBM', 'Orbitmine Resources', 'emerging', 'Space mining', 'micro', 450, 'volatile', 'Orbitmine Prospector', 'Regolith Refinery', 'Speculative asteroid-mining venture with no revenue yet.'),
  e('BLMT', 'Biolume Materials', 'emerging', 'Bio-engineered materials', 'small', 1600, 'growth', 'Biolume Fibre', 'Biolume Pack', 'Develops plant-based plastics and fibres for packaging and fashion brands.'),
];
