<!-- Written by: product-understanding stage. Read by: product-alignment, deep-discovery, reviewer. -->

# Product Understanding

## The raw idea (verbatim)

> "I want to build a website which can find clients and connection details for export business. I am from India"

## Core idea in plain language

A website that helps an **Indian exporter find overseas buyers** (importers, distributors, wholesalers, and sourcing/procurement contacts in other countries) for the products they want to sell. For each potential buyer it gives the **details needed to reach out**: company name, country, what they import, and contact points such as website, email, phone, LinkedIn, or a named decision-maker.

Put simply: *"I make or trade X in India. Who abroad buys X, and how do I contact them?"*

## Who it's for

**Primary user (assumed):** Indian small and medium exporters, including manufacturers, merchant exporters, and first-time exporters. They have a product and an IEC (Importer-Exporter Code), or are about to get one, but lack a pipeline of international buyers. They may have a limited budget and limited experience with international sales outreach.

**Possible secondary users (not confirmed):**
- Export consultants and agents who find buyers on behalf of clients.
- Export sales staff at larger Indian firms.

**The idea author** says they are from India. This suggests they are either an exporter who wants this tool for themselves, or an Indian founder building it for Indian exporters. Which one is unclear (see open questions).

## Problem it solves

Finding genuine, active foreign buyers is one of the hardest parts of exporting from India:
- **Discovery is hard:** it's not obvious which companies in which countries actually import a given product (typically identified by HS code).
- **Contact details are scattered or missing:** trade records show company names but rarely a reachable person, and B2B directories contain a lot of stale or fake listings.
- **Existing options are expensive, generic, or noisy:** trade fairs cost money and travel, B2B marketplaces (IndiaMART, Alibaba, TradeIndia, ExportersIndia) bring low-quality inquiries, and paid trade-data platforms can be costly and complex for a small exporter.
- **Trust is low:** exporters worry about fraudulent "buyers" and wasted outreach.

The product's job is to shorten the path from "I have a product" to "I have a qualified list of real foreign buyers I can contact."

## Premise sanity check (brief)

The need is real and already served by an established market. Trade-intelligence platforms such as **Volza, ExportGenius/ImportGenius, Panjiva (S&P Global), Descartes Datamyne, Market Inside, Vujis, TradeInt, and Coreties** build buyer lists from customs and bill-of-lading shipment records. Several of them specifically target Indian exporters. So the idea is valid, but it is **not novel as stated**. It will need a clear angle to stand out, for example price, ease of use for first-time exporters, contact quality or verification, AI-assisted outreach, or a niche product or market focus. This document does not choose that angle. It is flagged as a key question for later stages.

## Assumptions made

1. **Direction is export from India:** the user wants buyers *outside* India, not domestic clients or foreign suppliers.
2. **B2B only:** buyers are businesses (importers, distributors), not individual consumers.
3. **"Connection details" means business contact information:** company website, generic or role emails, phone, LinkedIn, and possibly named contacts.
4. **Search is by product:** the user starts from a product, probably an HS code or a plain description, and optionally a target country.
5. **It's a web app, not a one-off service:** users use a self-serve website rather than hiring someone for manual lead research.
6. **It's product-agnostic:** it covers all export categories rather than one vertical (e.g. only spices, textiles, or engineering goods).
7. **It's a commercial product for external users:** the user intends others to use it, rather than it being purely an internal tool for their own export business.

## Open questions

These are for alignment and discovery in later stages:

1. **Who is the user building for?** Their own export business, or a product sold to other Indian exporters? This changes scope a lot.
2. **Which products or sectors, if any?** Is there a specific category the user exports or wants to focus on first?
3. **Which target markets?** Any priority geographies (e.g. US, EU, UAE/GCC, Africa, SE Asia)?
4. **Where does the data come from?** Customs and shipment data (licensed, often paid), public business directories, web scraping, LinkedIn, government sources (e.g. EPCs, embassies, DGFT, trade-promotion bodies), or users contributing data? This affects cost, legality, and feasibility.
5. **What does success look like for a user?** Just a contact list, or also outreach help (email drafting and sending), buyer verification, or lead tracking (a CRM-like feature)?
6. **What is the differentiation** against Volza, ExportGenius, and similar platforms?
7. **Business model:** free, freemium, subscription, or pay-per-lead? What price would an Indian SME tolerate?
8. **Privacy and compliance:** collecting and showing personal contact details of foreign individuals raises questions under GDPR (EU), India's DPDP Act, and anti-spam laws. How far into personal data is the user willing to go?
9. **What resources does the user have?** Budget for data licensing, technical skills, and timeline.

## Out of scope for this stage

This stage does not cover classification, feature design, architecture, data-vendor choice, or monetization decisions. Those are left to later stages.
