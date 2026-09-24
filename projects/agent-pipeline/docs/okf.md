<!-- Written by: deep-discovery stage (organized knowledge file). Read by: design-planning, architecture-planning. -->

# Organized Knowledge File (OKF): Export Buyer Discovery for Indian Exporters

> **What this file is:** the research reference for the idea *"a website which can find clients and connection details for export business"* (an Indian exporter looking for overseas B2B buyers). It builds on `product_understanding.md` and `classification.md` (category: **B2B sales intelligence / lead-gen, trade-data sub-vertical**) and goes deeper.
>
> **What this file is not:** a design or architecture decision. Where there are options, they are listed with evidence and trade-offs. Choosing between them is left to design-planning and architecture-planning.
>
> **Research date:** September 2026. Prices are indicative and come from vendor pages and 2026 reviews. Items marked **[verify]** come from background knowledge or a single secondary source and should be re-checked before anyone relies on them.

---

## 0. How to use this file

| If you are... | Read first |
|---|---|
| **Design-planning** (features, UX, pricing, positioning) | §2 Competitors, §7 Pricing, §8 User expectations, §9 Government ecosystem, §10 Differentiation options |
| **Architecture-planning** (data, pipeline, integrations, compliance) | §3 Data sources, §4 Technical approaches, §5 Standards, §6 Legal/compliance, §7.3 Unit costs |
| **Both** | §1 Key findings, §11 Open questions & assumptions |

---

## 1. Key findings (summary)

1. **Company-level buyer discovery is largely commoditised, and much of it is free for an Indian user.** US importer names come free from ImportYeti (US bills of lading). **ITC Trade Map** (a UN/WTO agency tool) is **free for users in developing countries, including India**, and now includes a **company directory of importers and exporters from 60+ countries**. DGFT **Trade Connect** is free for about 600k IEC holders. A new product cannot win on "we have a list of importers."
2. **Shipment-level data with importer names exists for only some countries.** Good coverage: the US (bills of lading) and much of **Latin America** (about 17 countries through commercial vendors), plus India's own export records, which list the *foreign buyers of Indian exporters*. The **EU does not publish importer names**: customs confidentiality and GDPR apply, and Eurostat/Comext is aggregate-only. The EU, the UK and much of the GCC are therefore mostly **not** discoverable from customs data and need other signals (directories, web, trade fairs).
3. **Getting from a company to a reachable person is the costly, legally sensitive step.** Enrichment APIs cost from about $0.01/record (People Data Labs, bulk) through about $0.09/verified email (Hunter) to seat-based plans (Apollo, $49–119/user/month, annual billing, no API on Basic). **LinkedIn scraping is effectively off the table:** LinkedIn sued Proxycurl in January 2025, and Proxycurl shut down in July 2025 under a permanent injunction.
4. **Compliance timelines fall during any build in 2026–27.** India's DPDP Rules were notified on 13 November 2025. The consent-manager phase starts in November 2026, and full obligations apply from **13 May 2027**. GDPR permits B2B cold email under *legitimate interest*, provided the sender has an LIA, discloses the data source and offers an opt-out. Since 2024, Gmail, Yahoo and Microsoft require SPF, DKIM and DMARC, one-click unsubscribe and a spam rate below 0.3% (0.1% is the practical target). This applies directly to any outreach feature.
5. **The market is splitting into "data vendors" and "AI export-sales assistants."** Incumbents (Volza, Eximpedia, Export Genius, Seair, Tendata, Vujis) sell data at about $1.2k–$10k/year. Newer entrants in 2025–26 (Exporter.AI, ShipScout (June 2026), Blinkus.ai, VyaparAI, IGEN World) sell AI buyer discovery, HS classification and sales-funnel tools. A thin AI wrapper on commodity data is already a crowded position.
6. **Price tolerance in India is much lower than incumbent pricing.** The benchmark for Indian SME SaaS is **₹1,500–₹5,000/month**. UPI AutoPay (via Razorpay Subscriptions) is the practical payment rail for monthly plans under about ₹2,000. Incumbents mostly sell **annual-only** plans in USD, which leaves room for monthly INR pricing.
7. **Trust and fraud are the category's main emotional problems.** Scams run through B2B marketplaces (fake buyers, advance-fee demands, "ISO certification" traps) are well documented. A product that says "buyers" instead of "data" takes on this trust burden.
8. **Government spending is growing.** The **Export Promotion Mission** (₹25,060 crore, FY2025-26 to 2030-31, with 7 new MSME interventions launched in February 2026) and EPC/MAI programmes are possible **channels, subsidies or partners**, as well as free competitors.

---

## 2. Competitive landscape

### 2.1 Tiered map

| Tier | Players | What they sell | Price signal | Notes relevant to us |
|---|---|---|---|---|
| **A. Global trade-data platforms (India-focused)** | Volza, Eximpedia, Export Genius, Seair Exim, Cybex Exim, TradeImex, Eximtradedata | Shipment records by HS code/country, buyer and supplier lists, some contacts | Volza ~$1.5k / $4.5k / $9.6k per year (annual only, points-based). Eximpedia ~$1.2k–$3.5k/yr. Export Genius has a free tier. | Crowded. Differentiation is by country coverage and price per record. Trustpilot/G2 complaints about stale or fake data are common. |
| **B. Global trade-data platforms (enterprise/US)** | Panjiva (S&P), Descartes Datamyne, ImportGenius, Tendata, TradeInt, Coreties | Same, larger scale. TradeInt claims 8B+ shipment records and 500M+ company profiles. | Enterprise pricing. Vujis sells a one-time ~$5,000 1-year plan for 3 users (all countries, unlimited HS codes and searches). | Datamyne covers 17 LATAM countries. Vujis markets AI search plus decision-maker contacts. |
| **C. Free / freemium data** | ImportYeti (US BoL, free; Pro ~$130/user/yr; Enterprise from $1k/org/month with API), ITC Trade Map (free for developing-country users, company directory for 60+ countries), UN Comtrade (free API with quotas), Eurostat Comext (aggregate), Zauba (India shipment-level, free; recency **[verify]**) | Search, aggregate statistics, directories | Free | Sets the **price floor at zero** for "who imports X into the US/LATAM" and "which countries import X." |
| **D. Government / institutional** | DGFT Trade Connect ePlatform, EPCs (e.g. EEPC, Pharmexcil, EPCH, APEDA), Indian missions' trade enquiries, FIEO | Buyer leads, buyer-seller meets, trade fairs, subsidies | Free or membership fee | ~600k IEC holders already have access. Possible partner or channel (§9). |
| **E. AI export-sales startups (2025–26)** | Exporter.AI (Mumbai, founded 2020: trade data, competitor mapping, importer discovery, sales funnel), ShipScout (MyDome Labs, public launch June 2026: buyer discovery engine filtered by product/country/port/shipment frequency, with contact intelligence), Blinkus.ai (buyer finding, HS classification, duties, tracking), VyaparAI (verified Indian manufacturers ↔ international buyers), IGEN World | AI discovery, HS help, outreach and funnel tools | Mostly unpublished | **The most direct competitors to a new entrant.** Their positioning is close to the "differentiation angles" listed in `classification.md`. |
| **F. B2B marketplaces (adjacent)** | IndiaMART, TradeIndia, ExportersIndia, Alibaba, Tradologie | Inbound inquiries, paid seller memberships | Membership-based | Heavy complaints about fake leads and refunds. The model to avoid copying (see classification). |
| **G. Generic sales-intel / enrichment** | Apollo, Hunter, Lusha, People Data Labs, ZoomInfo, Clay-style waterfalls | Person/company contact enrichment | See §7.3 | Could be suppliers to us, or tools users already use themselves. |

### 2.2 Common features among competitors (baseline expectations)
- Search by **HS code** (2/4/6/8-digit) or product keyword, filtered by country, port, date range and shipment volume.
- A **buyer profile** with shipment history, suppliers (including competing Indian exporters), volumes, unit prices and trend charts.
- **Competitor mapping:** "which Indian exporters already ship to this buyer?" This comes from Indian export records.
- **Contact data:** company website, phone and email. Premium tiers add named decision-makers.
- **Exports** to Excel/CSV, usually capped by credits or points.
- Newer additions: sanctions and compliance screening (Export Genius), HS classification help (Blinkus), duty calculators, CRM and sales funnels (Exporter.AI).
- Commercial terms: free trials of about 7 days, money-back guarantees (Volza, ImportYeti), and points- or credit-based metering.

### 2.3 Recurring competitor weaknesses (from reviews)
- Stale, incomplete or fake contacts (Trustpilot for eximtradedata; G2 for Panjiva's incomplete contacts).
- Annual-only USD pricing that is too expensive for micro and first-time exporters.
- Complex dashboards built for analysts, not for first-time exporters.
- "Lead" products that don't convert, followed by churn and refund disputes (TradeIndia, ExportersIndia).
- Points-based pricing where poorly covered countries cost up to 10× per record (Volza).

---

## 3. Data sources (inventory for architecture-planning)

### 3.1 Source matrix

| Layer | Source | What it gives | Access & cost | Legal / quality notes |
|---|---|---|---|---|
| **Market prioritisation (aggregate)** | **UN Comtrade** API | Imports by country × HS code × year/month | Free with registration; ~500 calls/day, up to 100k records/call with a token; the Preview API is capped at ~500 rows | Public statistics, safe to use. Lags by months. No company names. |
| | **ITC Trade Map** | Same, down to tariff line, plus growth and competitor-country analysis | **Free for developing-country users (India)**; paid in developed countries | Terms for redistribution/commercial reuse **[verify]**. Likely usable for internal analysis only. |
| | **ITC Market Access Map** (macmap.org) | Tariffs, NTMs, rules of origin by market | Free for developing countries **[verify]** | Useful for "is this market worth it" scoring. |
| | Eurostat Comext | EU imports by product and partner | Free | Aggregate only. |
| **Company discovery: customs-based** | **US bills of lading** (CBP AMS vessel manifests) | Consignee (importer), shipper, product description, weight, ports, dates | Public under 19 CFR 103.31. Raw feeds are sold by manifest-data resellers (price not found **[verify]**). Free to browse via ImportYeti; ImportYeti API on Enterprise (~$1k+/month). | Importers can request **manifest confidentiality**, so some large buyers are missing. Sea freight only. HS codes on BoLs are often missing or noisy. |
| | **Latin America customs** (e.g. Mexico, Brazil, Chile, Colombia, Peru, Ecuador, Argentina, Paraguay, Uruguay, Panama, Costa Rica…) | Importer names, HS code, values | Commercial vendors (Datamyne covers 17 countries; ImportGenius 12). Some national portals publish records directly **[verify per country]**. | Country rules differ. Some countries mask names. |
| | **Indian export records** (shipping bills) | The *foreign buyer* of each Indian export shipment, with HS code, value, port and Indian exporter | Resold by Volza, Seair, Export Genius, Cybex etc. The official DGCI&S/NIRYAT portals give aggregates only. | Highly relevant: it shows who already buys from India. The provenance and legal basis of vendor-held shipping-bill data is **unclear [verify]**. Treat it as a licensing and legal question, not a scraping target. |
| | **EU / UK customs** | None at company level | Not public | Confidential under national customs and trade-secret rules plus GDPR. Coverage here has to come from non-customs signals. |
| | GCC, Africa, SE Asia | Patchy | Vendors claim coverage, often via mirror data (for example inferring buyers from exporters' shipping records) | Incumbents charge a premium here (up to 10 points/record at Volza). |
| **Company discovery: non-customs** | ITC Trade Map company directory (60+ countries) | Importing/exporting companies by product | Free for Indian users | Terms of reuse **[verify]**. Probably cannot be bulk-copied into our DB. |
| | DGFT Trade Connect, EPC buyer databases, Indian mission trade enquiries, trade-fair exhibitor lists | Buyer leads and enquiries | Free or with membership | Often unstructured. Fair lists carry copyright/terms issues. |
| | Web search / crawling (Exa, Firecrawl, Tavily…) | Distributor/importer websites found by product + country queries | Exa ~$7/1k searches; Firecrawl Standard ~$83/month (yearly) for 100k credits; free tiers exist | A 2026 benchmark on multi-hop company search: Exa deep 45.5% F1 at ~$0.49/run, Firecrawl 28.3% at ~$0.21/run. Accuracy is moderate, so results need verification. |
| | Google Places API | Business website, phone, address | ~$35 per 1k requests for Enterprise-tier fields (phone/website); the SKU is set by the most expensive field requested | Google Maps Platform terms **restrict caching/storing** Places content beyond place IDs **[verify current ToS]**. That is a constraint on building a persistent database from it. |
| **Company identity / verification** | **GLEIF LEI API** | Legal entity name, registration, parent relationships | **Free, no key** | Coverage is limited to entities with LEIs (larger and financial-market firms). |
| | OpenCorporates | 200M+ companies, 140+ jurisdictions | API needs a key; free only for public-benefit use, paid otherwise | Good for "is this a registered company?" checks. |
| | National registries: UK Companies House (free API), SEC EDGAR (free), EU VAT VIES (VAT number validation, free **[verify]**) | Registration status, directors | Free | Useful for anti-fraud buyer checks. |
| | Sanctions lists (OFAC SDN, UN, EU consolidated) | Denied parties | Free downloads | Export Genius already bundles sanctions screening. |
| **Contact enrichment (people)** | Hunter | Domain → emails, verification | ~$0.09/verified contact (Growth); shared credit pool, unlimited seats | Good email pattern coverage. Mostly US/EU-weighted. |
| | People Data Labs | Person/company records via API | ~$0.01/record at volume | Cheapest unit cost. Data provenance matters for GDPR. |
| | Apollo | Database + sequencing | Free tier with 75 credits/month; $49/$79/$119 per user/month, annual only; no API on Basic | Not built for API resale. |
| | Lusha, ZoomInfo, etc. | Phone and emails | Seat or credit based | Resale/redistribution is usually prohibited by their ToS **[verify]**. |
| | LinkedIn | — | **Do not scrape** | LinkedIn v. Proxycurl (2025): permanent injunction and shutdown despite ~$10M ARR. |

### 3.2 Coverage reality by target region (important for scope)

| Region | Company discovery via customs | Best available alternative signals |
|---|---|---|
| USA | Strong (BoL; sea freight only; confidentiality gaps) | Web, Places |
| LATAM | Strong for many countries (via vendors) | — |
| EU / UK | **None** | Registries (Companies House, VIES), web, trade fairs, Trade Map directory |
| GCC / UAE | Weak / mirror data | Web, trade fairs (Gulfood etc.), Bharat Mart Dubai (EPM) |
| Africa | Patchy (some country data via vendors) | Mirror data from Indian export records, missions |
| SE Asia | Mixed (e.g. Vietnam, Indonesia and the Philippines are often sold by vendors **[verify]**) | Web |
| "Already buys from India", any country | Indian export records (via vendors) | — |

---

## 4. Technical approaches (prior art and options, not decisions)

The prior art suggests a pipeline shape shared by most tools in this category. For each stage, known approaches are listed.

### 4.1 Product → HS code resolution
- **The problem:** first-time exporters often don't know their HS / ITC-HS code, and choosing the wrong code gives wrong buyers and compliance risk.
- **Approaches seen:** keyword lookup against the official nomenclature (DGFT ITC-HS search, which needs at least 6 characters); LLM/embedding classification (Blinkus.ai markets this); letting the user refine by chapter → heading → subheading.
- **Constraints:** HS codes are 6-digit globally and **8-digit in India's ITC-HS**, and the extra digits differ from the national extensions of importing countries. **HS 2027** (the next WCO revision) comes into force on 1 January 2027 **[verify date]**, so any code tables need versioning and concordance. Schedule I (import) and Schedule II (export) policy conditions differ for the same code.

### 4.2 Market prioritisation ("which countries?")
- Use UN Comtrade / Trade Map aggregates to rank countries by import value, growth, India's current share, and tariff advantage (Market Access Map, India's FTAs/CEPAs such as UAE CEPA, the India–Australia ECTA and the India–UK CETA **[verify status]**).
- Prior art: Trade Map's "potential" indicators, ITC Export Potential Map (exportpotential.intracen.org) **[verify]**.

### 4.3 Buyer discovery
- **Customs-record approach:** filter shipments by HS code/keyword + destination → group by consignee → rank by frequency, volume, recency and supplier diversity (ShipScout's filters: product, country, port, shipment frequency).
- **"Buys from India / from competitors" approach:** use Indian export records, or foreign import records where the shipper country is a competitor such as China, Vietnam or Bangladesh, to find buyers already sourcing that product.
- **Web-discovery approach (needed for the EU/UK/GCC):** search agents query "importer/distributor/wholesaler of X in Y", then an LLM classifies whether each site is actually an importer or distributor of the product.
- **Directory approach:** Trade Map directory, Trade Connect, EPC and trade-fair exhibitor lists (subject to terms).

### 4.4 Entity resolution
- BoL consignee names are messy: abbreviations, freight-forwarder/NVOCC names instead of the real buyer, and inconsistent addresses. All serious vendors normalise and cluster names.
- Techniques: name normalisation (legal-suffix stripping), fuzzy matching, address geocoding, domain matching, LEI/registry IDs as anchors.
- **Pitfall:** forwarders and logistics companies show up as "top buyers" and need to be filtered out.

### 4.5 Enrichment (company → domain → contacts)
- Typical waterfall: company name + country → website domain (search / Places) → generic role emails (info@, sales@, purchase@) from the site → optional named contacts (Hunter/PDL) → verification (SMTP/MX checks).
- Company-level and role-based contacts carry less compliance risk than named-person data (see §6).

### 4.6 Verification and scoring (anti-fraud / quality)
- Signals used in the category: active registration (registry/LEI/VAT), recent shipment activity, domain age and corporate email (vs Gmail/Yahoo, a scam red flag), website consistency, sanctions screening, and repeat shipments with multiple suppliers.
- Buyer-side scam patterns to detect or warn about: advance-fee requests (taxes, registration, "ISO certification" fees), urgent large orders, free-mail domains, sample theft ("sample chors").

### 4.7 Outreach assistance
- Options seen: AI-drafted first emails in the buyer's language, CSV export to users' own tools, built-in sequencing (Apollo-style), WhatsApp templates.
- **Hard constraint if the product sends email itself:** SPF + DKIM + DMARC alignment, one-click unsubscribe (RFC 8058 list-unsubscribe headers), a complaint rate below 0.3% (target 0.1%). Cold campaigns commonly run at a 0.5–1% complaint rate without good hygiene. Non-compliant mail is rejected at SMTP or sent to spam. If the platform sends on users' behalf, its sending reputation is shared across all users.

### 4.8 Freshness
- Incumbents claim weekly India refresh (Eximpedia). Contacts decay continuously. Prior art uses re-verification on access and per-field "last verified" timestamps.

---

## 5. Relevant standards and identifiers

| Standard / identifier | Relevance |
|---|---|
| **Harmonized System (WCO), HS 2022 → HS 2027** | Core product taxonomy. 6-digit global. Needs version-aware tables. |
| **ITC(HS), India, 8-digit** | What Indian users know; DGFT maintains it with import/export policy schedules. |
| National tariff extensions (e.g. US HTS 10-digit, EU CN 8-digit) | For mapping to destination-country records. |
| **IEC (Importer-Exporter Code)** | Indian exporter identity; possible signup verification. Trade Connect is keyed on IEC holders. |
| **LEI (ISO 17442)** | Free global legal-entity identifier (GLEIF). |
| ISO 3166 country codes, **UN/LOCODE** ports | Country and port filters. |
| ISO 4217 currency | INR/USD pricing and trade values. |
| Incoterms 2020 | Outreach and quoting context (FOB/CIF) for first-time exporters. |
| **SPF, DKIM, DMARC, RFC 8058 one-click unsubscribe** | Needed if any email is sent. |
| NPCI **UPI AutoPay** mandates | Recurring INR billing. |

---

## 6. Legal and compliance landscape

| Area | Rule | Status / date | Implication to record |
|---|---|---|---|
| **India DPDP Act 2023 + Rules 2025** | Consent-centric; notice, purpose limitation, data-principal rights, breach reporting | Rules notified on 13 November 2025. Phase 1 (Data Protection Board) from November 2025; consent-manager framework from **November 2026**; remaining substantive obligations from **13 May 2027**. | Applies to processing done in India, including personal data of foreign individuals **[verify extraterritorial scope details]**. Obligations also cover our own users' data. The treatment of publicly available B2B contact data under DPDP is **unclear [verify with counsel]**. (The Act excludes personal data made publicly available by the data principal themselves.) |
| **GDPR (EU) / UK GDPR** | Named business contacts are personal data. B2B direct marketing can rely on legitimate interest (Art. 6(1)(f)) with an LIA, source disclosure (Art. 14 notice) and an opt-out. | Active; fines up to €20M or 4% of turnover (examples: TIM €27.8M, Criteo €40M). | A database of EU named contacts makes us a controller/data broker. Company-level and role-address data carries much lower risk. |
| **EU ePrivacy / national rules** | Some member states (e.g. Germany) are stricter on B2B cold email **[verify]** | Active | Outreach features may need per-country rules. |
| **CAN-SPAM (US)** | Opt-out, sender identification, non-deceptive headers | Active | Easier than the EU. |
| **Mailbox-provider rules** (Gmail/Yahoo/Microsoft) | Auth, one-click unsubscribe, <0.3% spam rate for senders of 5k+/day | Enforced, stricter in 2026 | §4.7 |
| **LinkedIn ToS / litigation** | Scraping with fake accounts leads to lawsuits | Proxycurl permanent injunction (2025) | Exclude LinkedIn scraping. Linking to public profile URLs is a separate question **[verify]**. |
| **US manifest data** | Public under 19 CFR 103.31; importers can request confidentiality | Active | Legal to use; coverage gaps. |
| **EU customs data** | Confidential (national law + trade secrets + GDPR) | Active | Don't expect EU importer names from customs. |
| **Vendor/API terms** | Google Places caching limits; enrichment vendors' no-resale clauses; Trade Map reuse terms | Varies | Each supplier's terms constrain whether a persistent database can be built from its data **[verify each]**. |
| **Consumer/refund exposure** | Selling "buyers/leads" creates refund disputes (TradeIndia/ExportersIndia pattern) | — | Wording and guarantees matter. |

---

## 7. Pricing models and economics

### 7.1 Market price points

| Offering | Price |
|---|---|
| Volza | ~$1,500 / $4,500 / $9,600 per year (annual only, points) |
| Eximpedia | ~$1,200–$3,500 per year (4 editions) |
| Vujis | ~$5,000 one-time for a 1-year, 3-user plan |
| ImportYeti | Free; Pro ~$130/user/yr; Enterprise from $1,000/org/month |
| Export Genius | Free tier + paid tiers |
| Apollo | $0 / $49 / $79 / $119 per user/month (annual) |
| ITC Trade Map, Trade Connect, UN Comtrade | Free (for Indian users) |

### 7.2 Indian SME willingness to pay and payment rails
- Typical Indian SME SaaS prices are **₹1,500–₹5,000/month**. Users expect INR pricing well below international rates, and a $49/month tool is a significant spend for them.
- Monthly plans under ₹2,000 are paid mainly by **UPI AutoPay** or net banking. Annual plans above ₹10,000 are paid by card or net banking.
- UPI was about 85.5% of digital payment volume in H2 2025. Razorpay Subscriptions supports UPI AutoPay mandates. UPI has near-zero MDR, but the gateway charges a platform fee. Stripe is weaker for INR recurring payments.
- Incumbents' annual-only USD pricing (~₹1–8 lakh/year) is out of reach for micro and first-time exporters.
- Government reimbursement (MAI/EPM market-research components, via EPCs) might offset costs for EPC members **[verify eligibility of software subscriptions]**.

### 7.3 Illustrative unit costs (for architecture/pricing modelling; not a decision)

| Step | Indicative cost |
|---|---|
| Aggregate market data (Comtrade/Trade Map) | ~$0 |
| US importer discovery via own BoL processing | Raw-feed licence cost unknown **[verify]**. ImportYeti API ≥ $1k/month. |
| Web search per buyer-discovery query (Exa) | ~$0.007/search; deep multi-hop research ~$0.2–0.5/run (model cost) |
| Company website/phone (Google Places, contact tier) | ~$0.035/lookup |
| Verified named email (Hunter) | ~$0.09 |
| Bulk person record (PDL) | ~$0.01 |
| LLM classification/drafting | Low cents per buyer (model-dependent) |

*Example:* one enriched buyer profile (search + Places + one verified email) costs roughly **$0.13–0.60**. At ₹2,000/month (~$24), a user could get somewhere around 40–180 enriched buyers per month before gross margin. This is illustrative only, and caching and reuse across users change the numbers a lot.

### 7.4 Business-model patterns (from classification, confirmed)
Annual subscription with usage caps (dominant) · freemium/trial → paid · pay-per-report (HS × country) · pay-to-unlock contacts (complaint-prone) · government-subsidised access · money-back guarantees as a trust tool.

---

## 8. User expectations and pain points (Indian exporter)

**Jobs to be done (inferred from competitor features, scams and government programmes):**
1. "Tell me my HS code and whether I'm allowed to export it."
2. "Which countries should I target?"
3. "Give me real, active buyers of my product in those countries."
4. "Show me who they currently buy from (and whether Indian competitors already supply them)."
5. "How do I contact them, and what do I say?"
6. "Is this buyer genuine?" (the fear of fraud is strong)
7. "Can I afford it monthly, and pay by UPI?"

**Expectations set by the market:**
- HS-code search and product-keyword search.
- A free trial or free tier (ImportYeti and Export Genius make free the norm).
- Excel export.
- A money-back guarantee (Volza, ImportYeti).
- Hindi or regional-language help is plausible for first-time exporters **[assumption, not researched]**.
- WhatsApp-first communication is common among Indian SMEs **[assumption]**.

**Pain points cited:**
- Fake or stale data.
- Paid leads that never arrive, and refund fights.
- Complex analyst dashboards.
- Leads that don't convert because of weak outreach skills.
- Fraud: fake overseas POs, advance-fee demands, "ISO certification" scams run by call centres targeting IndiaMART sellers (Delhi case reported by The420.in), and free-mail "buyers".

---

## 9. Government and institutional ecosystem (competitor, channel, or partner)

| Programme | What it is | Relevance |
|---|---|---|
| **DGFT Trade Connect ePlatform** (trade.gov.in) | Free platform connecting ~600k IEC holders with missions and EPC officials; buyer information; opened to DPIIT startups via "Source from India" microsites | Free competitor; possible integration/partner **[verify API availability: none known]** |
| **Export Promotion Mission (EPM)** | ₹25,060 crore, FY2025-26 to 2030-31; "Niryat Protsahan" (finance) + "Niryat Disha" (ecosystem); 7 MSME interventions launched 20 February 2026 (export factoring, interest subvention, e-commerce credit, TRACE certification reimbursement); overseas warehousing such as **Bharat Mart Dubai** | Funding and channels. Market-intelligence support under Niryat Disha could subsidise or compete **[verify specifics]** |
| **Market Access Initiative (MAI)** | Reimburses EPCs and exporters for fairs, buyer-seller meets, market research, e-business tools; guidelines valid 1 April 2021 to 31 March 2026 | Successor status after March 2026 is unclear; possibly folded into EPM **[verify]** |
| **EPCs** (EEPC, Pharmexcil, EPCH, APEDA, Spices Board, etc.) and **FIEO** | Sector bodies that run fairs and buyer databases | Distribution channel (B2B2C) or data partner |
| **Indian missions abroad** | Trade enquiries, commercial wings | Source of verified-ish leads |

---

## 10. Differentiation options, with evidence (for design-planning to choose from)

| Option | Evidence for | Evidence against / risk |
|---|---|---|
| **1. First-time-exporter UX** (HS helper → market ranking → buyer list → outreach, in plain language, INR monthly) | Incumbents are analyst-oriented and annual-only; the SME price band is ₹1.5–5k/month | Blinkus and Exporter.AI are moving here; free tools cover parts of it |
| **2. Verified / scored buyers (anti-fraud)** | Fraud is the strongest pain; free signals exist (registries, LEI, sanctions, shipment recency, domain checks) | Verification is expensive to do fully; liability if a "verified" buyer defrauds a user |
| **3. Coverage where customs data is absent (EU/UK/GCC) via web discovery + LLM classification** | Incumbents are weak there and charge premiums; search APIs are cheap | Benchmark accuracy is moderate (~28–46% F1 on hard company search); GDPR exposure is highest in the EU |
| **4. Outreach and conversion help** (AI email drafting, follow-ups, a lightweight CRM) | "Leads don't convert" drives churn; incumbents are adding funnels | Deliverability rules; shared sending reputation; spam liability |
| **5. Vertical niche** (e.g. spices/agri, engineering goods, textiles, pharma) | Sector EPC channels; deeper HS focus; smaller data needs | Smaller market; depends on the author's sector (unknown) |
| **6. "Buys from India / from competitor countries" intelligence** | High value for positioning a pitch | Needs licensed Indian export records; legal provenance unclear |
| **7. Channel play with EPCs / EPM** | Large government budget; trust from institutional endorsement | Slow sales cycles; possible free government competition |
| **8. Self-use tool** (if the author just wants buyers for their own business) | Free tools already cover most of it | If this is the case, building may be unnecessary; see classification's note |

---

## 11. Open questions and assumptions

**Carried forward from earlier stages (still unresolved):**
1. Is this for the author's own export business or a SaaS for others? (This decides whether to build at all.)
2. Which sector(s) and target markets? (This determines data feasibility; see §3.2.)
3. Budget for data licensing?
4. Is person-level contact data and outreach sending in scope?

**New questions raised by this research:**
5. What are ITC Trade Map's terms for commercial reuse of its company directory? It could be a huge free source, or usable only as a link-out.
6. Where do Indian shipping-bill buyer records at Volza, Seair etc. come from, what is their legal status, and can they be licensed wholesale?
7. What are raw US manifest (AMS) feed costs compared with ImportYeti's Enterprise API?
8. How is publicly available B2B contact data treated under DPDP, and how does DPDP apply to processing foreign individuals' data from India? (Needs legal counsel before May 2027.)
9. Did MAI continue after 31 March 2026, and can exporters claim software or market-intelligence subscriptions under EPM/MAI?
10. Does Trade Connect offer an API or a partnership route?
11. When does HS 2027 take effect, and how will DGFT update ITC-HS?
12. Does Google Places caching policy prevent building a persistent enriched database?

**Assumptions made in this file:**
- India qualifies as a "developing country" for ITC tool access (consistent with ITC practice).
- USD→INR at about ₹83–88 for rough conversions.
- Hindi/regional-language and WhatsApp preferences are plausible but were not researched.
- Competitor feature lists come from marketing pages and press releases, not hands-on trials.

---

## Sources

**Competitors / market**
- [Volza pricing](https://www.volza.com/pricing/) · [Volza India export data](https://www.volza.com/global-trade-data/india-export-trade-data/) · [Volza blog: avoiding import-export scams](https://blog.volza.com/trade-smart-how-to-identify-and-avoid-scams-in-import-export-deals/)
- [Eximpedia](https://www.eximpedia.app/) · [Export Genius LATAM data](https://www.exportgenius.in/export-import-trade-data/south-american-countries.php) · [Seair global trade data](https://www.seair.co.in/global-trade-data.aspx) · [Seair EU trade data blog](https://www.seair.co.in/blog/european-union-trade-data.aspx)
- [Descartes Datamyne LATAM](https://www.datamyne.com/countries-covered-global-trade-data/latin-america/) · [ImportGenius additional countries](https://www.importgenius.com/how-it-works/additional-countries) · [Tendata data](https://www.tendata.com/data) · [Tendata pricing](https://www.tendata.com/special/ads/pricing.html)
- [Vujis on Capterra](https://www.capterra.com/p/10033888/Vujis/) · [Vujis vs Tendata](https://www.vujis.com/compare/vujis-vs-tendata) · [G2: Vujis pricing](https://www.g2.com/products/vujis/pricing) · [TradeInt vs Tendata](https://tradeint.com/insights/unveiling-the-superiority-of-tradeint-over-tendata-a-comprehensive-comparison/)
- [ImportYeti API](https://www.importyeti.com/yeti-api) · [ImportYeti on Capterra](https://www.capterra.com/p/10006176/ImportYeti/) · [ImportYeti custom plan](https://www.importyeti.com/pricing/custom-plan)
- [Exporter.AI (PitchBook)](https://pitchbook.com/profiles/company/557023-87) · [Exporter.AI about](https://exporterai.com/about.html) · [ShipScout launch](https://news.indianaheadlines.com/story/615996/shipscout-launches-aipowered-global-trade-intelligence-platform-to-help-exporters-win-more-international-business.html) · [Blinkus.ai](https://www.openpr.com/news/4602701/blinkus-ai-ai-for-global-trade-exporters-importers) · [VyaparAI](https://www.vyapar-ai.com/) · [IGEN World](https://igenworld.com/) · [StartupHub: AI simplifies Indian export workflows](https://www.startuphub.ai/ai-news/artificial-intelligence/2026/ai-simplifies-indian-export-workflows)
- [Saleshandy: import-export data providers in India](https://www.saleshandy.com/blog/import-export-data-provider-in-india/)

**Data sources / APIs**
- [UN Comtrade API package](https://github.com/uncomtrade/comtradeapicall) · [comtradr docs](https://docs.ropensci.org/comtradr/articles/comtradr.html) · [UN Comtrade account help](https://uncomtrade.org/docs/how-to-create-an-account/)
- [ITC: company contacts now in Trade Map](https://www.intracen.org/news-and-events/news/company-contacts-now-in-trade-map) · [Trade Map FAQ](https://www.trademap.org/stFAQ.aspx) · [ITC Trade Map tool](https://www.intracen.org/resources/tools/trade-map) · [Market Access Map](https://www.macmap.org/)
- [eCFR 19 CFR 103.31 (vessel manifest info)](https://www.ecfr.gov/current/title-19/chapter-I/part-103/subpart-C/section-103.31) · [CBP manifest confidentiality](https://www.cbp.gov/trade/automated/electronic-vessel-manifest-confidentiality)
- [Finnwatch: legal briefing on EU customs data disclosure](https://finnwatch.org/images/pdf/FW_Transparency_of_customs_data_legal_briefing.pdf) · [Comext (Wikipedia)](https://en.wikipedia.org/wiki/Comext)
- [GLEIF API](https://www.gleif.org/en/lei-data/gleif-api) · [OpenCorporates API overview](https://publicapis.io/opencorporates-api)
- [DEV: Apollo vs Hunter vs Lusha vs PDL cost per contact](https://dev.to/zackrag/apollo-vs-hunter-vs-lusha-vs-pdl-the-cost-per-contact-number-nobody-publishes-2026-4lj5) · [Apollo vs Hunter (Apollo)](https://www.apollo.io/insights/apollo-vs-hunterio)
- [Google Places API pricing (Woosmap)](https://www.woosmap.com/blog/google-places-api-pricing) · [Places data fields](https://developers.google.com/maps/documentation/places/web-service/data-fields)
- [Firecrawl vs Exa](https://www.firecrawl.dev/alternatives/firecrawl-vs-exa) · [Openbenchmarks: Firecrawl for research agents](https://openbenchmarks.com/multi-turn-company-search/firecrawl-for-research-agents) · [Best web search APIs 2026 (Probo)](https://www.probo.com/hub/best-web-search-apis-2026)

**Standards**
- [DGFT ITC-HS search](https://www.dgft.gov.in/CP/?opt=itchs) · [ITC-HS guide (impexkit)](https://impexkit.com/blog/itc-hs-code-export-india/) · [Razorpay: ITC HS code](https://razorpay.com/blog/itc-hs-code-meaning-list-india/) · [Harmonized System (Wikipedia)](https://en.wikipedia.org/wiki/Harmonized_System)

**Legal / compliance**
- [DPDP Rules 2025 (Wikipedia)](https://en.wikipedia.org/wiki/Digital_Personal_Data_Protection_Rules,_2025) · [AZB: DPDP phased rollout](https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/) · [Scrut: DPDP rules guide](https://www.scrut.io/post/dpdp-rules) · [Sansa Legal: DPDP timeline](https://www.sansalegal.com/post/dpdp-act-2023-and-rules-2025-phased-implementation-timeline-and-business-compliance-deadlines)
- [Instantly: GDPR & CAN-SPAM B2B list compliance](https://instantly.ai/blog/b2b-email-list-compliance-gdpr-canspam/) · [Vonsel: GDPR cold email fines](https://vonsel.com/blog/legal/gdpr-fines-for-cold-email) · [LiteMail: GDPR legitimate interest 2026](https://litemail.ai/blog/gdpr-legitimate-interest-cold-email-2026)
- [Proxycurl shutdown (Nubela)](https://nubela.co/blog/goodbye-proxycurl/) · [Social Media Today: LinkedIn wins vs Proxycurl](https://www.socialmediatoday.com/news/linkedin-wins-legal-case-data-scrapers-proxycurl/756101/)
- [Red Sift: 2026 bulk sender requirements](https://redsift.com/guides/bulk-email-sender-requirements) · [InboxLee: Gmail/Yahoo rules for cold email 2026](https://inboxlee.com/blog/gmail-yahoo-2026-bulk-sender-rules) · [PowerDMARC bulk sender rules](https://powerdmarc.com/bulk-email-sender-requirements/)

**Fraud / trust**
- [The420.in: ISO certification trap scam on IndiaMART exporters](https://the420.in/delhi-dwarka-cyber-fraud-call-centre-b2b-export-scam/) · [Trustpilot: ExportersIndia](https://www.trustpilot.com/review/www.exportersindia.com) · [Infobanc: internet frauds in export](https://www.infobanc.com/article/faida4_16.htm) · [trade.gov: avoiding scams](https://www.trade.gov/market-intelligence/ghana-avoiding-scams-international-trade-and-business)

**Pricing / payments (India)**
- [Playto: pricing SaaS for Indian vs international customers](https://www.playto.so/blogs/how-to-price-your-saas-for-indian-vs-international-customers-in-2026) · [Razorpay: SaaS payment gateway TCO](https://razorpay.com/blog/best-payment-gateway-pricing-saas-india-tco-guide) · [Rohit Raj: Razorpay vs Stripe for Indian MVPs](https://rohitraj.tech/en/notes/razorpay-vs-stripe-india-mvp-2026)

**Government**
- [PIB: Export Promotion Mission launch](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2230664&reg=3&lang=1) · [IBEF: Export Promotion Mission](https://www.ibef.org/economy/export-promotion-mission) · [InsightsIAS: EPM 7 interventions](https://www.insightsonindia.com/2026/02/21/export-promotion-mission/) · [NewsOnAir: EPM ₹25,000 crore](https://www.newsonair.gov.in/union-cabinet-approves-new-export-credit-guarantee-scheme-launches-%e2%82%b925000-crore-export-promotion-mission)
- [India Briefing: MAI scheme](https://www.india-briefing.com/news/indias-market-access-initiatives-scheme-offers-airfare-support-for-start-ups-and-new-exporters-29054.html/) · [AYUSHEXCIL: MAI validity](https://ayushexcil.in/mai) · [PIB: DGFT Trade Connect](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2145471)
