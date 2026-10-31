# ADR 0005: Phase 5 items, costs, share links and PDF

Status: proposed (defaults pending review by Alex) · Date: 2026-10-28 · Spec: `docs/specs/phase-5-share-export.md` (section 10 lists every default)

## Context
Users record what they are considering or have booked (hotels, courses, rental car, flights) with a status and a price, and want a cost overview like the reference golf plan (cost per person, open choices). Plans must be shareable by a revocable link that always shows the latest version, and exportable as PDF. Ground rules: facts never come from the LLM (prices are user data), deterministic first, users see only their own data, shared plans are read server-side by token only, secrets stay server-side, no PII in logs. The plan JSON reserved `items`/`costs` keys in phase 3; plan versions are immutable and pruned to 30. The demo account is shared by anonymous visitors.

## Decisions
1. **Items in their own table `trip_items`, not in the plan JSON.** Plan versions are immutable snapshots of AI output; storing items there would create a version per status toggle, lose items on regenerate and revert them on restore. A per-trip table with the usual owner RLS and composite FK is simpler and never reaches the LLM. The reserved plan keys stay unused.
2. **Four statuses: `option | planned | booked | rejected`.** The architecture named three, but the reference trip needs "decided, not booked yet": with only options, two rounds on the same day would be read as alternatives.
3. **Costs are computed in code** per currency without FX: booked total, and an expected range of booked + planned + per (category, day) the cheapest to dearest option. Per person divides totals by the item's `persons` or the group's entry counts. The reference golf plan reproduces exactly (1 679,64–1 769,64 € per person).
4. **No LLM for items.** No suggestions or placeholders; a code-only quick add prefills items from plan places and verified flight legs.
5. **Share tokens are 256-bit random values stored only as sha256 hashes**; the URL is shown once. Revoke deletes the row. A leaked database or backup therefore exposes no working links; the cost is that owners create a new link instead of copying an old one.
6. **The public read path uses the secret key with explicit column lists** in one server module (`plan-document.ts`) shared by the share page and the share PDF. Every failure gives the same 404; the page is `noindex`, `no-referrer`, dynamic, and never calls external APIs (the destination photo is read from `api_cache` only and shown through the Next image optimizer, so the viewer's browser never contacts Wikimedia). Shares show plan content, group counts and (opt-out per link) items with costs and notes; never names, birthdates, emails, trip notes or group/purpose text.
7. **Privacy of access logging:** views increment a counter and log `share.viewed` with link id only. IPs are used only as in-memory rate-limit keys, never stored, not even hashed (hashed IPv4 addresses are trivially reversible).
8. **Demo account cannot create share links**, enforced in code and in the RLS insert policy (`private.is_demo()`), because demo visitors hold a real session and could otherwise publish arbitrary text on our domain. Items and PDF stay allowed; the reset cascades.
9. **PDF with `@react-pdf/renderer` v4** in Node route handlers (owner and share), built from the same `PlanDocument`, generated on demand and never stored. Noto Sans is embedded because built-in PDF fonts lack glyphs like `→`. Labels follow the plan's locale so they match the prose.
10. **Retention:** item edits extend a trip's 18-month retention (purge function updated); share views do not. Trip delete and purge cascade to items and links.

## Consequences
- Three small migrations; no change to the plan schema, prompts or input hashes, so evals and recordings stay valid.
- Booked items do not yet influence the itinerary (e.g. a fixed tee time); feeding booked items to the LLM as fixed constraints is a later decision.
- Lost share URLs cannot be recovered; users create a new link.
- Rate limits are per server instance until phase 6 hardening.
- Next.js needs `serverExternalPackages` and file tracing for the fonts; the PDF route is the heaviest function (~a few MB bundle), well within Vercel limits.
- Users without a group must set `persons` per item to get per-person amounts.
