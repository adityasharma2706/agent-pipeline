<!-- Written by: design-planning stage. Read by: architecture-planning, implementation-planning, system-design. -->

# Product Design: Export Buyer Discovery for Indian Exporters

> **Scope of this document:** functional requirements and product/experience direction only. It covers what the product does, for whom, through which flows, and in what order. It does **not** cover data sources, vendors, data models, system architecture or implementation. Those belong to architecture-planning, which should read this alongside `docs/okf.md`.
>
> **Inputs:** `docs/idea.md`, `docs/product_understanding.md`, `docs/classification.md`, `docs/okf.md` (research as of September 2026).
>
> **Requirement IDs (`REQ-###`) are permanent.** Downstream stages cite them. Never renumber, reuse or repurpose an ID. New requirements take the next unused number.

---

## 1. Product direction

### 1.1 One-line positioning

**"From 'I make X in India' to a shortlist of real, checked overseas buyers and a first email ready to send, in one sitting, for a monthly price in rupees."**

Working name in this document: **the product**. Naming is left open.

### 1.2 Chosen differentiation

The OKF (§10) lists eight differentiation options. Company-level importer lists are commoditised and partly free (ImportYeti, ITC Trade Map, DGFT Trade Connect), so this design does **not** try to win on "more data". It combines three options that support each other:

| Pillar | OKF option | Why |
|---|---|---|
| **A. Guided journey for first-time and small exporters** | #1 | Incumbents build analyst dashboards and sell annual USD plans. Indian SMEs expect ₹1.5k–5k/month and plain language. |
| **B. Trust layer: every buyer shows evidence and checks** | #2 | Fraud and fake or stale data are the category's biggest pains. Many useful checks rely on free signals. |
| **C. Help with the first contact, not just a list** | #4 (lightweight) | Users churn when leads don't convert. Help with drafting and tracking addresses this. The product does not send email itself in the MVP, which avoids deliverability and shared-reputation risk. |

The following are **deliberately not chosen** for the MVP and are recorded for later:
- Vertical niche (#5). The author's sector is unknown. The design is sector-agnostic, but it could launch with a featured sector (see §9, open questions).
- Paid "buys from India / competitor" intelligence (#6). Supported as a *Should* where data allows (REQ-022). It depends on licensing.
- EPC/government channel (#7). The design leaves room for it (team/consultant workspaces, REQ-063) but does not depend on it.

### 1.3 Product principles

1. **Say "potential buyers", never "guaranteed buyers".** The product sells evidence and tools, not orders. Wording, guarantees and refunds are designed around this (OKF §6, the refund-dispute pattern).
2. **Show evidence for everything.** Every buyer states *why* it is listed, *where* the information came from and *when* it was last checked.
3. **Be honest about coverage.** Before a user spends anything, the product shows how good its buyer data is for each country (strong, partial or limited). This reflects the real gap in the EU/UK/GCC (OKF §3.2).
4. **Company contacts first.** Default contacts are company-level and role-based (website, phone, sales@ and purchasing@ addresses). Named-person data is a later extension that goes through compliance review (OKF §6).
5. **Plain language, mobile-friendly and cheap to start.** Users should be able to do something useful without paying and without knowing their HS code.
6. **The user stays in control of outreach.** The product drafts and the user sends from their own account.

---

## 2. Users

| Persona | Description | Main need | MVP? |
|---|---|---|---|
| **P1 First-time exporter** ("Ravi") | Small manufacturer or trader, maybe has an IEC, has never exported or only through agents. Uses a phone a lot and WhatsApp heavily. Budget is about ₹1,500–3,000/month. | "Which country? Who buys? What do I say? Is this buyer real?" | **Primary** |
| **P2 Growing SME exporter** ("Meena") | Already exports to one or two markets and wants new ones. Has a small export team. | Faster discovery in new countries, competitor insight, a pipeline to track. | **Primary** |
| **P3 Export consultant / agent** | Finds buyers for several client exporters. | Several products and clients, exports, seats. | Secondary (partly served) |
| **P4 Author's own use** | If the author only wants buyers for their own business (open question #1). | Same as P1/P2 for one product. | Covered by the same flows. See §9. |

---

## 3. Shape of the experience

### 3.1 The guided journey (core loop)

```
 1. My product      →  2. Where to sell   →  3. Find buyers    →  4. Check buyer   →  5. Reach out      →  6. Track
 (plain words →        (ranked countries,    (evidence-backed     (trust checklist,   (AI draft email,     (shortlist,
  HS code)              coverage labels)      list, filters)       red flags)          user sends)          status, reminders)
```

Each step can be used on its own (for example, an experienced user types an HS code and jumps straight to buyers), but a new user is walked through them in order. The journey is organised **per product**: a user with three products has three workspaces.

### 3.2 Main areas (information architecture)

| Area | Purpose |
|---|---|
| **Home / dashboard** | Next actions, follow-ups due, new buyers for saved searches, credit balance. |
| **My products** | Product workspaces: HS code, description, export policy status. |
| **Markets** | Country ranking for a product, with coverage labels. |
| **Find buyers** | Search results with filters. |
| **Buyer profile** | Evidence, activity, trust checks, contacts, draft outreach, notes. |
| **My buyers (pipeline)** | Shortlist and status tracking across products. |
| **Check a buyer** | Standalone check for a buyer who contacted the user (e.g. from IndiaMART or email). |
| **Learn** | Glossary (HS, IEC, Incoterms, FOB/CIF), scam guide, links to government resources. |
| **Account & billing** | Plan, credits, invoices, data rights. |

### 3.3 Tone and wording

- Plain English, with a Hindi option later (REQ-058). Avoid trade-data jargon, or explain it in context.
- Trust wording: use "Checks passed: 5 of 6" and "Trust: Medium". Do not use "Verified buyer" or "Genuine".
- Coverage wording: for example, "Strong: based on shipment records", "Partial: based on business directories and websites", "Limited: few sources for this country".
- Put the price in credits and rupees on every action that costs something ("Reveal contacts: 1 credit").

---

## 4. Key user flows

### Flow 1: First session for a new user (activation)
1. The user lands on the site and tries **"What do you want to export?"** without signing up. They type "handmade cotton bedsheets".
2. The product suggests HS codes with plain descriptions. The user picks one or refines it (REQ-005, REQ-006).
3. The product shows the top target countries, with import size, growth, India's share, coverage labels and a one-line "why" (REQ-010, REQ-012, REQ-013).
4. The user picks two countries. The product shows a preview of the buyer count and the first few buyer names with trust summaries. It then asks the user to sign up (phone or email OTP) to see the full list (REQ-001, REQ-051).
5. Short onboarding: business name, city, exporter experience, IEC (optional) (REQ-002).
6. The user sees the full list, opens a buyer profile, reads the evidence and trust checks, and reveals contacts using free credits (REQ-021, REQ-027, REQ-032).
7. The user generates a first email draft and copies it or opens it in their mail app (REQ-038, REQ-040).
8. The buyer is added to **My buyers** with status "Contacted" and a follow-up reminder is set (REQ-045, REQ-046, REQ-047).

**Activation target:** a new user saves at least 5 buyers and generates at least 1 draft in the first session.

### Flow 2: Experienced exporter opens a new market
The user enters an 8-digit ITC-HS code directly, chooses "Germany + Netherlands" and sees the coverage label "Partial" with an explanation. They filter by buyer type "Distributor" and "active in the last 12 months", then sort by trust. They bulk-add 20 buyers to the shortlist, reveal contacts in bulk (with a credit confirmation) and export the list to Excel (REQ-015, REQ-018, REQ-019, REQ-048, REQ-054).

### Flow 3: "Is this inbound buyer real?"
The user gets an email from a "buyer" in the UAE asking for a registration fee. They open **Check a buyer**, paste the email address, company name and website, and get the trust checklist plus matching scam red flags ("asks for advance fee", "free-mail domain") and advice on what to do next (REQ-030, REQ-031). This is available with limited use on the free tier and works as an acquisition hook.

### Flow 4: Bad data and credit refund
A revealed email bounces. The user marks the contact "Invalid". The credit comes back automatically, the contact is flagged for re-checking and the user sees confirmation (REQ-025, REQ-034). If a buyer is reported as "Not a real importer" or "Suspicious", it is hidden for that user and sent to the review queue (REQ-064).

### Flow 5: Follow-up and pipeline
The dashboard shows "3 follow-ups due today". The user opens one, generates a follow-up draft, sends it, and moves another buyer to "Replied". When the user records a reply, it feeds the product's success metrics (REQ-041, REQ-049, REQ-050).

### Flow 6: Opt-out by a listed company or person
A company contact visits the public "Remove my data" page and submits a request. The data is suppressed from search and profiles after review, and the requester receives a confirmation (REQ-037, REQ-064).

### Flow 7: Upgrade and payment
The user runs out of free credits and sees the plan comparison in INR per month. They choose a plan, pay by UPI AutoPay, receive a GST invoice, and the credits show up immediately (REQ-052, REQ-053, REQ-054).

---

## 5. Feature areas (narrative)

**5.1 Product and HS helper.** Turns a plain-language product description into candidate HS codes (6-digit global plus 8-digit ITC-HS), shows how confident the suggestion is, and lets the user browse the hierarchy. It shows export-policy status (free, restricted or prohibited) with a link to the official source and a "confirm with your CHA/DGFT" disclaimer. Codes are aware of HS versions. When HS 2027 takes effect, affected products prompt the user to re-confirm.

**5.2 Market finder.** Ranks countries for the product by import size, growth, India's share, competitor supplier countries and trade-agreement advantage. It also shows a **buyer-data coverage label** for each country, so users don't pay to search places where the product is weak.

**5.3 Buyer discovery.** Search by product and country. The results are **evidence-backed**: each row explains *why* the company is a likely buyer (shipment records, a website stating it distributes the product, a directory listing) and when that was last seen. Logistics companies and freight forwarders are removed by default. Lower-confidence sources (web or directory) are labelled clearly.

**5.4 Trust layer.** A checklist for each buyer: registered entity found, website present and consistent, domain age, corporate or free-mail email, recent trade activity, and sanctions screening. Each check is shown as pass, fail or unknown, with a date. The checks roll up into a trust level with a disclaimer. Sanctions hits block the outreach tools. The same checks power the standalone **Check a buyer** tool and the contextual scam warnings.

**5.5 Contacts.** Company-level and role-based contacts, each showing its source, a "last checked" date and deliverability status. Revealing contacts costs credits. Invalid contacts are refunded. Named decision-makers are a later, compliance-gated extension that stays off for EU/UK by default. A public opt-out process exists from day one.

**5.6 Outreach assistant.** AI drafts first and follow-up emails from the user's product profile and the buyer's evidence. The user can edit the tone and choose English or the buyer's language. Drafts always include sender identity, business details and an opt-out line, plus source disclosure for EU/UK recipients. The user sends from their own email (copy or open in their mail app). There are optional WhatsApp templates and pitch or one-pager helpers.

**5.7 Pipeline (lightweight CRM).** Shortlists per product, statuses, notes, reminders and Excel/CSV export. It is intentionally simple: it is not a full CRM and does not sync to one in the MVP.

**5.8 Plans, credits and billing.** A free tier that is useful without a card. Monthly INR plans with a visible credit balance and an optional annual discount. UPI AutoPay, cards, net banking and GST invoices. Costs per action are always shown before the credit is used. There is a money-back window. The product does not use hidden per-country multipliers; if some countries cost more, this is shown up front.

**5.9 Learn and support.** Glossary, a scam red-flag guide, a first-export checklist, and links to free government resources (Trade Connect, the relevant EPC). Being open about free options builds trust. WhatsApp support and notifications are opt-in.

**5.10 Account, privacy and operations.** Consent and privacy notice at signup. Users can view, export and delete their data (DPDP obligations fully apply from 13 May 2027). An internal review queue handles user reports and opt-out requests.

---

## 6. Functional requirements

Priority key: **Must** = required for MVP launch · **Should** = MVP if feasible, otherwise first follow-up release · **Could** = later / nice to have.

| ID | Requirement | Priority |
|---|---|---|
| REQ-001 | Users can sign up and sign in using a mobile number or email with a one-time password. No card is needed to create an account. | Must |
| REQ-002 | Onboarding captures a short business profile: business name, city/state, what they make or trade, export experience (none / some / regular), IEC (optional) and target markets (optional). All fields can be edited later. | Must |
| REQ-003 | Users can optionally have their IEC checked and show a "Verified exporter" badge on their own profile and outreach drafts. | Could |
| REQ-004 | Visitors can try the product-to-HS-code helper and the market ranking before signing up. The full buyer list requires sign-up. | Must |
| REQ-005 | Users can describe a product in plain language and receive suggested HS codes (6-digit HS and 8-digit ITC-HS) with plain-language descriptions and a confidence indicator. | Must |
| REQ-006 | Users can refine the code by browsing the HS hierarchy (chapter → heading → subheading → ITC-HS line) or by entering a code directly. | Must |
| REQ-007 | For the selected ITC-HS code, the product shows export policy status (free / restricted / prohibited / conditions) with a link to the official source and a disclaimer to confirm with DGFT or a customs broker. | Should |
| REQ-008 | Users can save several products. Each product is a workspace holding its HS code, chosen markets, searches and shortlisted buyers. | Must |
| REQ-009 | When the HS nomenclature version changes (e.g. HS 2027), products with affected codes are flagged and the user is asked to re-confirm the code. | Should |
| REQ-010 | For a product, the product shows a ranked list of target countries with import value, recent growth, India's current share and the main competing supplier countries. | Must |
| REQ-011 | Market ranking shows tariff or trade-agreement advantages for Indian goods where known (e.g. CEPA/ECTA/CETA partners). | Should |
| REQ-012 | Every country in market ranking and buyer search shows a buyer-data coverage label (Strong / Partial / Limited) with a short plain-language explanation of what it is based on. | Must |
| REQ-013 | Each ranked country has a short plain-language "why this market" summary. | Should |
| REQ-014 | Users can shortlist target countries for a product, and these become the default filters for buyer search. | Must |
| REQ-015 | Users can search for potential buyers by product (HS code or keyword) and one or more countries. | Must |
| REQ-016 | Each search result shows company name, country and city, buyer type (importer / distributor / wholesaler / retailer / manufacturer), relevance evidence summary, latest activity date, trust level and which contact types are available. | Must |
| REQ-017 | Every buyer shows "why this buyer" evidence: the type of source (e.g. shipment records, company website, directory), what it says about the product, and the date it was last seen or checked. | Must |
| REQ-018 | Search results can be filtered by country, buyer type, activity recency, shipment frequency (where available), trust level, contact availability, and "sources from India / from competitor countries" (where available). | Must |
| REQ-019 | Search results can be sorted by relevance, most recent activity, trade volume (where available) and trust level. | Should |
| REQ-020 | Freight forwarders, logistics companies and similar non-buyers are left out of results by default, and a toggle can show them. | Must |
| REQ-021 | Each buyer has a profile page with an overview, product evidence, activity or shipment summary where available (frequency, volumes, origin countries, main suppliers), website, trust checks, contacts, outreach drafts and the user's notes and status. | Must |
| REQ-022 | Where data allows, the buyer profile shows whether the buyer already sources the product from India and which competitor countries it buys from. | Should |
| REQ-023 | A buyer profile suggests similar buyers (same product, country and type). | Could |
| REQ-024 | Buyers found through non-customs sources (websites, directories) are clearly labelled as such and show a lower-confidence indicator than shipment-evidenced buyers. | Must |
| REQ-025 | Users can report a buyer or a contact as wrong product, not a buyer, closed, invalid contact or suspicious. The item is hidden or flagged for that user and passed on for review. | Must |
| REQ-026 | Users can save a search and get notified (in-app and email, optionally WhatsApp) when new matching buyers appear. | Could |
| REQ-027 | Each buyer shows a trust checklist: registered entity found, website present and consistent, domain age, corporate vs free-mail email, recent trade activity and sanctions screening. Each check shows pass / fail / unknown and the date it was checked. | Must |
| REQ-028 | The checklist rolls up into a trust level (High / Medium / Low / Unknown). The product never labels a buyer as "verified genuine" or guaranteed, and it shows a disclaimer explaining what the checks do and do not mean. | Must |
| REQ-029 | Buyers matching a sanctions or denied-party list carry a prominent warning, and contact reveal and outreach drafting are blocked for them. | Must |
| REQ-030 | A standalone "Check a buyer" tool lets users enter any buyer's name, email, website and/or country (e.g. an inbound inquiry) and get the trust checklist and matching scam red flags. It has a limited free allowance. | Should |
| REQ-031 | Contextual scam red-flag guidance appears with trust checks and in the Learn area (advance-fee or registration-fee requests, certification-fee traps, free-mail domains, urgent large orders, sample-only requests). | Should |
| REQ-032 | Buyer contacts include company-level and role-based details: website, main phone, address, role emails (e.g. sales, purchasing, info) and contact-form link, where available. | Must |
| REQ-033 | Every contact field shows its source, "last checked" date and, for emails, a deliverability status (valid / risky / unknown). Data older than a set freshness threshold is shown as stale or re-checked before it is revealed. | Must |
| REQ-034 | Revealing a buyer's contacts uses credits, with confirmation before any credit is spent. If a revealed email or phone is confirmed invalid, the credit is returned automatically. | Must |
| REQ-035 | Named decision-maker contacts (name, title, business email) can be offered as an opt-in extension after compliance review. They are off by default for EU/UK buyers. | Could |
| REQ-036 | The product does not show contact or profile data gathered by scraping LinkedIn or other sources whose terms forbid it. | Must |
| REQ-037 | A public page lets any company or person ask for their data to be removed or corrected. Approved requests stop the data from appearing anywhere in the product, and the requester receives confirmation. | Must |
| REQ-038 | Users can generate an AI-drafted first-contact email for a buyer based on their product profile and the buyer's evidence. The draft can be edited, with a choice of tone and language (English or the buyer's main business language). | Must |
| REQ-039 | Every outreach draft includes sender identity, the user's business details and an opt-out line. Drafts for EU/UK recipients also include a short note on where the contact details came from. | Must |
| REQ-040 | Users send drafts from their own email account (copy, or open in their mail app). The product does not send outreach email on the user's behalf in the MVP. | Must |
| REQ-041 | Users can generate follow-up drafts (2nd and 3rd touch) with suggested timing, and set reminders for them. | Should |
| REQ-042 | For buyers with a business WhatsApp number, users can open a click-to-chat link with a ready-made intro message. | Could |
| REQ-043 | Users can create a reusable company or product intro (one-pager text covering products, MOQ, certifications and Incoterms offered) that outreach drafts use. | Could |
| REQ-044 | In-context outreach guidance for first-time exporters: what a first email should contain, how to handle sample requests, and Incoterms basics. | Should |
| REQ-045 | Users can save buyers to a shortlist inside a product workspace, one at a time or in bulk. | Must |
| REQ-046 | Each shortlisted buyer has a status the user can change: To contact, Contacted, Replied, In discussion, Sample sent, Order won, Not interested. | Must |
| REQ-047 | Users can add notes and next-action reminders to a shortlisted buyer. Due reminders appear on the dashboard and, if the user opts in, as notifications. | Should |
| REQ-048 | Users can export a shortlist or search results to Excel/CSV, including only the contacts they have already revealed, within their plan's limits. | Must |
| REQ-049 | A dashboard shows the pipeline by status, follow-ups due, new buyers for saved searches, and credit balance. | Should |
| REQ-050 | When a user marks a buyer as Replied / In discussion / Order won, this is recorded as an outcome signal for measuring product success and improving relevance. | Could |
| REQ-051 | A free tier includes the HS helper, market ranking, buyer search with limited visible results, a small monthly allowance of contact reveals, and limited use of Check a buyer. | Must |
| REQ-052 | Paid plans are priced monthly in INR, with clear credit allowances per plan. Annual billing is optional and discounted. | Must |
| REQ-053 | Users can pay by UPI AutoPay, card or net banking, and receive GST-compliant invoices. They can update the payment method and cancel on their own. | Must |
| REQ-054 | The credit balance and usage history are always visible. Every credit-consuming action shows its cost before use. Any country or action that costs more credits is shown clearly beforehand. | Must |
| REQ-055 | A published money-back window for new paid subscribers, which users can request from their account. | Should |
| REQ-056 | Users can buy one-off credit top-up packs without changing plan. | Could |
| REQ-057 | All core flows (product, markets, search, buyer profile, drafting, pipeline, billing) are fully usable on a mobile browser. | Must |
| REQ-058 | The interface is available in Hindi, with other Indian languages as a later option. | Could |
| REQ-059 | A Learn area and in-context tooltips explain export terms (HS / ITC-HS, IEC, Incoterms, FOB/CIF, MOQ) in plain language. | Should |
| REQ-060 | Users can opt in to WhatsApp for support and notifications (reminders, saved-search alerts). | Could |
| REQ-061 | Users can view, download and delete their account data, and withdraw consent, from account settings. | Must |
| REQ-062 | Signup asks for clear consent and shows a privacy notice explaining what user data is collected and why. | Must |
| REQ-063 | An account can have several team members, and a consultant can manage several client workspaces, each with its own products and pipelines. | Could |
| REQ-064 | An internal review queue lets the operator handle user reports on buyers and contacts, and data removal requests, with outcomes recorded. | Must |
| REQ-065 | The Learn area and relevant product pages link to free official resources (DGFT Trade Connect, the relevant EPC, Indian missions) for the user's product. | Could |
| REQ-066 | Public pages clearly state what the product does and does not promise (potential buyers and evidence, not guaranteed orders), along with coverage limits and the refund policy. | Must |

---

## 7. MVP scope summary

**In the MVP (all Must items):** sign-up, onboarding and privacy consent · HS helper · market ranking with coverage labels · evidence-backed buyer search, filters and profiles · trust checklist and sanctions blocking · company-level contacts with source, freshness and refund of invalid contacts · AI first-email drafts sent by the user · shortlist, status and export · free tier, INR monthly plans, UPI, visible credits · opt-out page and review queue · mobile-friendly · honest-promise public pages.

**Explicitly out of the MVP:**
- Sending email or running sequences from the platform (deliverability and shared-reputation risk, OKF §4.7).
- Named-person contacts, especially in the EU/UK (REQ-035, compliance-gated).
- LinkedIn data of any kind obtained through scraping (REQ-036).
- A marketplace, inbound inquiries or buyers paying to list. The product is not IndiaMART.
- Full CRM, CRM integrations, trade finance, logistics or document tools.
- Guaranteed-lead or pay-per-buyer-promise pricing.

**Launch country coverage:** this design assumes a **limited set of launch countries** where coverage is at least "Partial". Architecture-planning should choose them based on data feasibility (OKF §3.2), and the coverage labels (REQ-012) keep the product honest about the rest.

---

## 8. Pricing and packaging direction (product level)

Illustrative shape only. The final numbers depend on unit costs (OKF §7.3), which architecture-planning should model.

| Plan | Indicative price | Who | Contents (direction) |
|---|---|---|---|
| **Free** | ₹0 | Try it, P1 | HS helper, market ranking, limited buyer results, a few contact reveals/month, a few buyer checks/month |
| **Starter** | ~₹1,500–2,000/month (UPI AutoPay) | P1 | Full search in launch countries, tens of reveals/month, drafts, pipeline, export |
| **Growth** | ~₹4,000–5,000/month | P2, P3 | More reveals, bulk actions, saved-search alerts, follow-ups, more products |
| **Annual** | ~2 months free | All | Same as monthly |

Commercial trust levers: no card needed for Free, cancel on your own, a money-back window (REQ-055), automatic refunds of invalid-contact credits (REQ-034), and no hidden per-country multipliers (REQ-054).

---

## 9. Success metrics

| Metric | Target direction |
|---|---|
| Activation: new users who shortlist ≥5 buyers and generate ≥1 draft in the first session | Primary north-star input |
| Weekly active product workspaces | Growth |
| Drafts generated → buyers marked "Contacted" | Outreach adoption |
| Self-reported replies (Replied / In discussion) per 100 contacted | The value users actually get (REQ-050) |
| Invalid-contact report rate and refund rate | Data quality (keep low) |
| Buyer "suspicious" reports | Trust layer effectiveness |
| Free → paid conversion; monthly churn | Business health |
| Refund / money-back requests | Promise–delivery gap |

---

## 10. Assumptions and open questions

**Assumptions made in this design:**
1. The product is a commercial SaaS for other Indian exporters (product_understanding assumption #7). If it is for the author's own business only (OKF option #8), most value comes from REQ-005, 010, 015–021, 027–034, 038, 045–046, and billing (REQ-051–056) can be dropped. The earlier stages' advice still stands: consider existing free tools first.
2. The product covers all sectors and is not a vertical niche. A featured launch sector could be added without changing any requirement.
3. English first. Hindi is a *Could* (REQ-058) because language preference was not researched.
4. WhatsApp matters to users (OKF §8 marks this as an assumption), so it appears only as *Could* items.
5. Users are comfortable sending from their own mailbox. This keeps outreach legally and reputationally on the user, with product guidance.
6. A credit model is acceptable to users if costs are transparent and invalid contacts are refunded.

**Open questions (for the author / later stages):**
1. Own use or SaaS? (still unresolved; this decides scope)
2. Which launch countries and sectors? This depends on data feasibility, which architecture-planning should settle.
3. Can data licensing support REQ-022 ("buys from India / competitors"), and at what cost?
4. Where is the line for "trust level" liability? Legal review of the REQ-028 disclaimer wording is needed.
5. Does free use of Check a buyer (REQ-030) work as the main acquisition hook, or should it be fully free?
6. Should named contacts (REQ-035) ever be offered, and in which regions, given the DPDP (May 2027) and GDPR positions?
7. Is there an EPC/EPM partnership route (bulk seats, subsidised access) that would move REQ-063 up in priority?
8. Exact credit prices and allowances depend on unit costs and caching across users (OKF §7.3).

---

## 11. Notes for architecture-planning (functional constraints, not solutions)

These are requirements implied by the design. How to meet them is left to architecture-planning.
- Every buyer and contact fact must be traceable to a **source type and a last-checked date** (REQ-017, REQ-033).
- Coverage labels must be computable **per country and product** before the user searches (REQ-012).
- Trust checks must each be able to return **unknown**, not only pass or fail (REQ-027).
- User reports, opt-outs and sanctions hits must take effect across **all** surfaces: search, profile, export and drafts (REQ-025, REQ-029, REQ-037).
- Credit accounting must support refunds that happen automatically when an invalid contact is reported (REQ-034).
- The design assumes the product **does not send outreach email** in the MVP (REQ-040).
