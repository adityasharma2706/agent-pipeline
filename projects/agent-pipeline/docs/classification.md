<!-- Written by: product-alignment stage. Read by: deep-discovery, architecture-planning. -->

# Classification

## Decision

**Primary category: Other → B2B sales intelligence / lead generation, in the trade-data ("export buyer discovery") sub-vertical.**

**Secondary tag: Self-business (conditional).** This tag applies only if open question #1 in `product_understanding.md` resolves to "the author wants this for their own export business." In that case, the product is an internal lead-finding tool and not a SaaS product for sale.

**Categories considered and rejected:**

| Candidate | Why it doesn't fit |
|---|---|
| Ecommerce | Nothing is bought or sold on the platform. It helps a seller *find* buyers, and the deals happen off-platform. The nearest ecommerce model is a B2B marketplace (IndiaMART, TradeIndia). That model is a known pain point (see pitfalls), not the intended model. |
| Finance | No payments, credit, trade finance, or FX. Export finance (ECGC, LC, factoring) is a nearby area but not the stated idea. |
| Content/media | The value is structured, searchable records (companies, shipments, contacts), not articles or media. |
| Dev tooling | The users are exporters, not developers. |
| Self-business (as primary) | The working assumption (#7) is that this is a commercial product for other exporters. Self-business stays as a secondary tag until the author confirms. |

## Reasoning

1. **The core job is data plus search.** The job is: "Given product X (HS code) and optionally country Y, return companies that import X and a way to contact them." This is the core loop of sales-intelligence tools such as ZoomInfo and Apollo, applied to cross-border trade. Most of the value and cost lie in **data acquisition, matching, and freshness**, not in the UI.
2. **The established comparables all sit in this category.** Every comparable named in the product understanding (Volza, ExportGenius, Panjiva, Datamyne, ImportGenius, Eximpedia, Seair) is a trade-intelligence data vendor with a subscription model. Research should therefore be benchmarked against data/lead-gen SaaS, not against marketplaces or content sites.
3. **The main risks are the ones this category is known for:** data licensing cost, contact accuracy and staleness, personal-data compliance (GDPR, DPDP, anti-spam), and churn when leads don't convert. Classifying it this way points later stages at those risks.

## Grounded market research (for this category)

### 1. Comparable products

**a) Paid trade-data platforms (the closest comparables).** These build buyer lists from customs and bill-of-lading records and add contact details on top.

| Product | Positioning | Indicative price |
|---|---|---|
| **Volza** | 200+ countries, strong focus on Indian exporters, points-based access (India and US shipments cost 1 point each; poorly covered countries up to 10). 7-day free trial and a money-back guarantee. | Annual only: ~$1,500 (Startup) / $4,500 (SME) / $9,600 (Corporate) per year |
| **Eximpedia** | Dashboard covering 200+ countries, weekly India data refresh | ~$1,200–$3,500/yr across 4 editions (BOOST at $1,200/yr, 45 countries) |
| **Export Genius** (India) | Trade intelligence plus sanctions and compliance screening. Has a limited free plan. | Tiered, with a free entry tier |
| **Seair Exim** (Delhi) | India customs data, strong in pharma, textiles, and agri. Offers buyer and supplier directories. | Tiered |
| **Panjiva (S&P Global), Descartes Datamyne, ImportGenius** | Enterprise or US-focused, built largely on US CBP bill-of-lading data | Enterprise pricing, higher end |

**b) Free or low-cost alternatives an Indian exporter already has access to.** These set the price floor.
- **ImportYeti:** free, unlimited search of US bill-of-lading data (consignee, shipper, product description, shipment counts) from January 2015 onward. This shows that the raw US importer list is effectively a commodity.
- **DGFT Trade Connect ePlatform (trade.gov.in):** free government platform offering global buyer information and exhibition listings. It connects about 600,000 IEC holders with Indian Mission and EPC officials, and now covers DPIIT startups through "Source from India" microsites.
- **Export Promotion Councils, Indian embassies/missions, and trade fairs:** traditional sources of buyer leads.

**c) Adjacent model to avoid copying naively: B2B marketplaces** (IndiaMART, TradeIndia, ExportersIndia, Alibaba). These use an inbound-inquiry model with paid seller memberships.

### 2. Typical business models in this category

1. **Annual subscription with usage limits** (the dominant model). Limits are set by points, searches, downloads, or countries. Tiers range from about $1.2k to $10k per year. Annual-only billing is common, which is a hurdle for small SMEs' cash flow.
2. **Freemium or trial, then upgrade.** Free trials of limited scope (Volza's 7-day trial, Export Genius's free plan) are standard. ImportYeti is fully free and makes money elsewhere.
3. **Pay-per-report or pay-per-country data.** One-off reports by HS code and country, sold by Indian vendors such as Seair.
4. **Pay-to-unlock contacts / seller memberships** (the marketplace model). Exporters pay to view buyer contact details. This model produces the most complaints (see below).
5. **Government and EPC-subsidised access.** Free, but limited in depth and in how actionable it is.

**What this means for pricing:** a newcomer targeting small Indian SMEs is squeezed between free options (ImportYeti, Trade Connect) and roughly $1,200/yr incumbents. A viable price is probably in the monthly, low-INR range, or pay-per-verified-lead. Deep-discovery should validate this; it is not established here.

### 3. Known pitfalls for this category

1. **Data acquisition is the business.** Buyer discovery depends on shipment data:
   - US bill-of-lading data is public through FOIA/CBP and already free through ImportYeti, so it cannot be a differentiator.
   - Data for other countries (EU, GCC, Africa) is patchy, often licensed from intermediaries, or not publicly available. Incumbents charge up to 10 times more per record for poorly covered countries.
   - US importers can also request that their manifest data be kept confidential, so some large buyers do not appear at all.
2. **Contact accuracy and freshness.** Customs records give company names, not reachable people. Contact enrichment goes stale quickly. Reviews of the category repeatedly cite "fake, inaccurate, useless data" (e.g. Trustpilot reviews of eximtradedata.com), and G2 reviews note incomplete contacts even on Panjiva.
3. **Trust and refund backlash from pay-to-unlock and lead promises.** TradeIndia and ExportersIndia draw frequent complaints about fraudulent leads, leads that never arrived after payment, refund disputes, and unresponsive support. Promising "buyers" rather than "data" creates the same exposure.
4. **Fraudulent buyers.** Fake buyers and advance-fee scams targeting Indian exporters are common. A buyer-finding product may be expected to verify buyers, which is costly to do.
5. **Leads don't convert, so users churn.** A contact list is not a sale. SMEs often lack outreach skills, so they blame the tool and cancel. Incumbents respond by adding features higher up the funnel, such as analytics and compliance screening.
6. **Compliance for personal data and outreach.** Named contacts of EU individuals fall under GDPR. India's DPDP Act applies to processing done from India. Cold email is regulated by CAN-SPAM, EU ePrivacy, and similar laws. Scraping LinkedIn breaches its terms of service. Company-level data is much safer than person-level data.
7. **A crowded, commoditised field.** At least 7 incumbents already target Indian exporters specifically, and a free government platform exists. Competing on "more data" is a losing strategy for a new entrant, so differentiation has to come from elsewhere.

## Implications for later stages (for deep-discovery and architecture)

- Treat **data sourcing strategy** as the first-order design decision, ahead of UI or features.
- The likely routes to differentiation in this category are: verified or scored buyers, the UX for first-time exporters (HS-code guidance), outreach assistance, a vertical or regional niche, and INR pricing suited to SMEs. Picking one is deep-discovery's job.
- Default to company-level data. Treat person-level contacts as an opt-in, compliance-reviewed extension.

## Assumptions and open questions (added by this stage)

- **Assumption:** the product is commercial (a SaaS for other exporters). If it is for the author's own use, the category becomes self-business. In that case the recommendation would lean towards *using* existing tools (ImportYeti, Trade Connect, a Volza trial) rather than building one.
- **Open:** Will the author pay to license non-US customs data, or restrict the MVP to public sources (the US bill-of-lading records and the government platforms above)?
- **Open:** Is buyer verification (anti-fraud) in scope? It is the most-cited pain point but is expensive to deliver.
- Prices above come from 2026 review and pricing pages, are indicative, and may vary by region or promotion.

## Sources

- [Volza pricing](https://www.volza.com/pricing/) · [Volza review 2026 (dupple)](https://dupple.com/reviews/volza) · [Volza review (networthexplained)](https://networthexplained.com/articles/volza-review/)
- [Eximpedia subscription](https://www.eximpedia.app/subscription) · [Export Genius plans](https://www.exportgenius.in/company/plan-and-pricing.php) · [Seair](https://www.seair.co.in/) · [ImportGenius pricing](https://www.importgenius.com/pricing)
- [Saleshandy: 10 import-export data providers in India](https://www.saleshandy.com/blog/import-export-data-provider-in-india/)
- [Trustpilot: eximtradedata.com](https://www.trustpilot.com/review/eximtradedata.com) · [Trustpilot: tradeindia.com](https://www.trustpilot.com/review/tradeindia.com) · [ComplaintsBoard: ExportersIndia](https://www.complaintsboard.com/exportersindia-b123416) · [G2: Panjiva reviews](https://g2.com/products/panjiva/reviews)
- [PIB: DGFT Trade Connect ePlatform](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2145471) · [Devdiscourse: Trade Connect opened to startups](https://www.devdiscourse.com/article/business/3961195-dgft-opens-trade-connect-platform-to-indian-startups-seeking-global-buyers)
- [Federal Reserve paper on bill-of-lading data](https://www.federalreserve.gov/econres/feds/files/2021066pap.pdf) · [Bellingcat toolkit: ImportYeti](https://bellingcat.gitbook.io/toolkit/more/all-tools/importyeti)
