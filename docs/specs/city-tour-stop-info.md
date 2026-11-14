# City tour: stop info and read-out (issue #213, phase 3)

After a tour is computed, each stop gets a short info card (what it is, a few facts, a picture) and a read-out:
the browser reads the card's text aloud, with play/pause per stop and "next stop". Everything shown is fetched by
code from Wikipedia, Wikidata, Wikimedia Commons and OpenStreetMap, with its source and check date.

Decided by Alex, 2026-11-13: (1) info cards plus **read-out by the browser's Web Speech API** (option A): no LLM,
no server text-to-speech; (2) the info shows in the **tour result, the trip PDF and the share page**; (3) audio is
**play/pause per stop plus "next stop"**, never triggered by location; (4) **the info must not overload the tour
view**: each stop gets a collapsed toggle "Infos zum Ort" / "About this place" that reveals its card and its
play/pause control, nothing is expanded by default, and the info is fetched only when a stop is first expanded
(section 5). The share page works the same way; the PDF follows a compact rule (section 6, [Q2]).
The open questions were decided the same day (section 11).

Not in scope: a narrated or rewritten guide (would need a new rule 2 use), recorded audio, offline packs, location
tracking, user-written notes per stop.

## 1. Ground rules applied

- **Rule 1.** Text, facts and pictures come from Wikipedia (TextExtracts), Wikidata (claims) and Commons (image
  metadata), matched by the stop's own OSM `wikidata` tag. Each card shows its sources and check date. Nothing is
  guessed: a stop without a match shows its name and the facts that exist, or nothing.
- **Rule 2.** No LLM. The read-out speaks the stored text as it is.
- **Rule 3.** Optional: a tour works without any info; the cards load after the tour.
- **Rule 5.** Labels, fact sentences and controls in `messages/*.json` (de + en). The fetched text is in the tour
  owner's locale (de or en Wikipedia, [Q1]); a stop without an article in that language falls back to the English
  article, labelled as English.
- **Rule 6.** Stored on the tour row (owner RLS as `city_tours`; share link read by token through the server route).
- **Rule 7.** Cards and controls work at 360 px (section 6).
- **Rule 8.** Every call cached in `api_cache`; Wikimedia etiquette (serial batches, the app's User-Agent).

## 2. Matching a stop to an article [S1]

Per stop key, cheapest first:
1. **All `osm:` keys:** one Overpass query by element ids for the whole tour, as a union so no selector replaces the
   others' results: `[out:json];(node(id:…);way(id:…);relation(id:…););out tags center;`. The parser keeps
   tag-only elements (ways and relations have no `lat`/`lon` of their own) and matches them by type and id. Only the `wikidata`,
   `wikipedia`, `website`, `contact:website` and `opening_hours` tags are kept, cached
   `cacheKey("osm-tags", 1, { ids: hash })` 30 d. The cached city places and landmarks are not enough: landmarks
   keep `wikipedia` only as a flag and neither keeps `opening_hours`. When Overpass fails, the `wikidata` id from
   those caches is used (read by key, 0 calls) and the OSM facts are left out.
3. **`geo:` (a town) or `gfy:` (an address) keys:** no info card ([Q3], decided). A town start or end is not a sight;
   an address has no stable identity.

A `wikidata` id wins over a `wikipedia` tag. Without an id, the `wikipedia` tag is parsed as `<lang>:<title>`
(OSM convention, e.g. `de:Passauer Dom`): used only for `de` or `en`, the title URL-decoded and `_` read as a space;
a tag without a language prefix is ignored. Ids are checked with `^Q\d{1,12}$`. A title-only match (no id) gets
text but no Wikidata facts or picture.

## 3. Data sources and calls [S2]

Per tour, all batched (at most 27 stops):

| Call | Request | Gives | Cache key | TTL |
|---|---|---|---|---|
| Wikidata entities | `wbgetentities&ids=Q1\|Q2…&props=sitelinks\|claims&sitefilter=dewiki\|enwiki` (≤ 50 ids) | article titles in de/en; claims P18 image, P571 inception, P84 architect, P1435 heritage designation, P856 website | `cacheKey("wd-stop", 1, { ids: hash })` | 30 d |
| Wikidata labels | `wbgetentities&ids=…&props=labels&languages=de\|en` for the architect and heritage items (≤ 50 ids per request) | their names | `cacheKey("wd-labels", 1, { ids: hash })` | 90 d |
| Wikipedia extracts | `query&prop=extracts\|pageprops&ppprop=disambiguation&exintro&explaintext&exlimit=20&redirects=1&titles=…` per language, chunks of ≤ 20 titles | intro text; the resolved title after redirects; pages with `disambiguation` are dropped | `cacheKey("wp-extract", 1, { lang, titles: hash })` | 30 d |
| Commons image info | `prop=imageinfo&iiprop=url\|size\|mime\|extmetadata&iiurlwidth=330&titles=File:…` (≤ 50) | `thumburl` (330 px), licence, artist | `cacheKey("commons-info", 1, { titles: hash })` | 60 d |

- Every request with an id or title list is chunked to the API limit (Wikidata 50 ids, extracts 20 titles,
  Commons 50 files) and the results are merged. A cold 25-stop tour costs about 5–7 requests plus one Overpass
  query; a recomputed tour with the same stops costs 0.
- **Time budget:** the batch has 4 s; each request gets `timeoutMs = min(its default, time left)`, and none starts
  with less than 500 ms left. Stops not done are left "unfinished" (section 4).
- Providers: `wikidata` (entities, labels, and Commons image info, as the destination picture in
  `facts/picture.ts` already logs Commons), `wikipedia` (extracts), `overpass` (tags); all in `CacheProvider` today.
  Endpoints in `api_calls`: `stop_entities`, `stop_labels`, `stop_extracts`, `stop_images`, `stop_osm_tags`.
- Text: the intro clipped on a sentence boundary to at most 700 characters including the "…" (`clipParagraphs` of
  `wikivoyage.ts`; its no-sentence fallback cuts at 699 so the ellipsis stays inside `StopInfo.text`'s max),
  marked "gekürzt" when clipped. Disambiguation pages and pages without an extract are dropped; a redirect stores
  the target article's title and URL.
- Images: only free licences (CC0, public domain, CC BY, CC BY-SA in their versions; same rule as the destination
  picture in `facts/picture.ts`), stored as the 330 px `thumburl` (never the original file URL). `Artist` is HTML
  from Commons: reduced to plain text, never rendered as HTML. Unknown or non-free licence = no picture.
- Facts: inception (P571) as a year, worded by `cat`: "Erbaut 1147" only for buildings (church, castle, tower,
  bridge, monument), "Eröffnet 1891" for a station or museum, otherwise the neutral "Seit 1891"; at most two
  architects, one heritage designation (all Wikidata); website (OSM `website`/`contact:website` first, else Wikidata
  P856) and opening hours (OSM `opening_hours`, raw, "laut OpenStreetMap"; a value over 255 characters is left
  out, never cut) with their own source.
- **Website values** are stored only as absolute `https:` or `http:` URLs (parsed with `new URL`, at most 300
  characters, no credentials), through the existing `safeUrl` of `src/lib/facts/sources.ts` (http(s) only, so
  `javascript:` and other schemes are refused). A bare OSM domain (`example.org`, `www.example.org/x`) gets
  `https://` before the check; anything that fails is dropped, never stored, and rendering checks again. Links render with
  `rel="noopener noreferrer nofollow"` and `target="_blank"`.

## 4. Data model [S3]

A new column, not part of `result`: **`city_tours.stop_info jsonb`** (null = not fetched yet), check
`pg_column_size(stop_info) <= 65536`, written with the secret key like `result`. *Recommended*: `result` already
spends 200 kB of its 256 kB on route lines (25 stops), and the info changes on a different schedule (articles
change; the route does not). Alternative: inside `result` with a smaller polyline budget.

```ts
export const StopInfo = z.object({
  key: z.string(),                          // tour point key
  status: z.enum(["ok", "none"]),           // "none" = checked, nothing usable (not fetched again until stale)
  checkedAt: z.string(),                    // oldest fetchedAt of the API answers used (cached or new): "abgerufen am", drives refresh
  qid: z.string().regex(/^Q\d{1,12}$/).optional(), // absent for a title-only match (section 2)
  lang: z.enum(["de", "en"]).optional(),    // language of title and text: the owner's locale, or "en" as fallback ([Q1])
  title: z.string().max(200).optional(),    // Wikipedia article title (link); absent = facts or picture only
  text: z.string().max(700).optional(),
  clipped: z.boolean().optional(),
  image: z.object({ url: z.string().url(), w: z.number(), h: z.number(), licence: z.string().max(60),
    licenceUrl: z.string().url().optional(), artist: z.string().max(200).optional(), file: z.string().max(240) }).optional(),
  facts: z.object({ year: z.number().int().optional(), architects: z.array(z.string().max(80)).max(2).optional(),
    heritage: z.string().max(120).optional(), website: z.string().url().max(300).optional(),
    websiteFrom: z.enum(["osm", "wikidata"]).optional(), openingHours: z.string().max(255).optional() }).optional(),
});
// status "ok" needs at least one of text, image or a fact; "none" carries only key, status and checkedAt.
// A key without an entry is unfetched or unfinished: the next expand fetches it.
export const TourStopInfo = z.object({
  v: z.literal(1),
  locale: z.enum(["de", "en"]),             // the owner's locale when fetched
  stops: z.array(StopInfo).max(MAX_TOUR_POINTS), // 12 on main today, 27 after #221 (city-tour.md 17.1 [P1])
});
```

Size: about 1.2 kB per stop, 33 kB for 27 stops. A tour edit that changes the stop set keeps the info of the
remaining stops and fetches only the new ones; `updateTour` removes the entries of removed keys in the same update
statement, so a key added back later is fetched again.

## 5. When it is fetched [S4]

- **Lazily, on the first expand.** Nothing is fetched with the computation or on page load. The first time any stop
  of a tour is expanded, `tourStopInfo(id)` fetches the info **for all stops of the tour in one batch** and stores
  it in `stop_info`; later expands (of any stop, by anyone) read what is stored. *Recommended* over a per-stop fetch:
  the APIs are batched (section 3), so all 27 stops cost about the same 5–7 requests as one stop, and the next expand then
  answers instantly. Budget 4 s; stops not done in time are fetched on their own expand.
- **Who can trigger it:** the owner and read grantees (session, RLS read), and share-link viewers through the share
  route by token. All of them write only `stop_info`, through the server with the secret key; nobody else's input
  changes. Share-link fetches have their own durable limit per link (section 12).
- **Stops added later** have no entry; their first expand fetches them (and any other missing stops) in one batch.
- Refresh: an entry whose `checkedAt` is older than 30 days (both statuses) is fetched again on its next expand,
  and so is the whole `stop_info` when its `locale` differs from the owner's current locale (the owner switched
  language, [Q1]). A completed refresh that finds nothing replaces the old entry with `status: "none"`. No
  background job.
- Rate limits and the cache-only mode when they are used up: section 12.

## 6. UI [S5]

**Tour result.** Each stop row gets a toggle button "Infos zum Ort" (`aria-expanded`, `aria-controls`), collapsed by
default; only stops with a possible match (section 2) show it. Expanding shows "Wird geladen…" until the batch
answers, then the card (or "Für diesen Ort gibt es keine Infos"):
- picture (330 px, `next/image` from `upload.wikimedia.org`, already allowed in `next.config.ts`; the image optimizer
  fetches it, not the viewer's browser), with credit "Foto: {artist}, {licence}" linking to the Commons file;
- text, then "Weiter auf Wikipedia" (link to the article);
- facts as short lines: "Erbaut 1147", "Architekt: …", "Denkmalschutz: …", website link;
- source line: "Text: Wikipedia, CC BY-SA 4.0 (gekürzt) · Fakten: Wikidata · abgerufen am {date}". A fallback text
  ([Q1]) is marked "Englischer Text" before it, carries `lang="en"` on its element and its own source line naming the
  English article ("Text: English Wikipedia, CC BY-SA 4.0 …", linking to it).

**Read-out (Web Speech API).**
- Shown only when `window.speechSynthesis` exists and a voice for the text's language exists; otherwise one muted
  line "Vorlesen wird von diesem Browser nicht unterstützt". A card with facts but no text is read (name and facts)
  with the voice of the owner's locale.
- Per stop: a play button inside the expanded card; while reading it becomes pause, then resume. A small bar above
  the stop list, shown only once any card is open: "Tour vorlesen" (from the first stop with text; it fetches the
  info batch if needed), pause/resume, "Nächster Ort" (expands the next stop's card while reading it), stop. Only one
  utterance at a time; starting another stop stops the current one.
- Spoken text: "{n}. {name}." then the card text, then the fact lines as sentences. No picture credits, no links.
  Each utterance gets the language of its text: the name and fact sentences the owner's locale, a fallback text an
  English voice (`lang = "en"`); without an English voice that text is skipped in the read-out and the card says so.
- Long texts are split into sentence chunks (Chrome cuts long utterances; iOS needs the first `speak` inside the tap).
- Accessibility: buttons at least 44 × 44 px with text labels (`aria-pressed` for play/pause), an `aria-live="polite"`
  status "Liest: {name}" (not repeating the text), keyboard operable, no autoplay. Reading stops when the page is
  hidden (`visibilitychange`) to avoid audio from a background tab.
- Nothing is sent anywhere: the browser speaks locally (some systems use an online voice of their own; the help
  text says "Die Stimme kommt von deinem Gerät").

**Share page.** The same collapsed toggles, cards and read-out. Stored info is read by token through the server
route; a first expand with nothing stored triggers the batch fetch through the share route (section 5).

**Trip PDF.** Nothing can be toggled on paper, so the PDF stays compact by default ([Q2], decided): an
**opt-in "Ortsinfos aufnehmen"** checkbox next to the PDF download (off by default). Off: the PDF is as today. On:
**one line per stop** under its name, the first sentence of the text (at most 140 characters, cut on a word with
"…"), plus the sources line in the tour block ("Ortsinfos: Wikipedia (CC BY-SA 4.0), Wikidata"). Missing info is
fetched for the export in the batch (same budget); stops still missing get no line. No pictures and no facts lines
in the PDF.

## 7. i18n (namespace `tours.stopInfo`, de + en)

`toggle ("Infos zum Ort" / "About this place"), loading, more, image.credit, facts.{built, opened, architect, heritage, website}, source, clipped, none,
readOut.{play, pause, resume, next, stop, tour, reading, unsupported, voiceNote}, pdf.{include, sources}`. The sources page
(`sources.*.provides` for Wikipedia and Commons) adds "Ortsinfos der Stadttouren".

## 8. Tests

- Matching: osm key from cached places/landmarks, Overpass fallback, `wikidata` over `wikipedia` tag, geo/gfy
  skipped, invalid ids dropped.
- Clients (recorded fixtures, one live check each like the sitelinks spike): batching ≤ 50, sitefilter, extracts per
  language, disambiguation dropped, clipping, licence filter, artist HTML stripped.
- Pipeline: budget leaves partial info; recompute keeps known stops; size check; owner-only writes; grantee read.
- Lazy loading: nothing fetched on render or computation; the first expand fetches one batch for all stops; a second
  expand makes no call; the share route fetch is rate limited per token.
- UI: toggles collapsed by default with `aria-expanded`; card renders facts and credits; no read-out controls without `speechSynthesis`; one utterance at a time; status
  text; 360 px without horizontal scroll (E2E).
- PDF and share: without the opt-in the PDF is unchanged; with it, one line (≤ 140 characters) per stop and the
  sources line; the share page shows collapsed toggles and stored info.
- pgTAP: `stop_info` size check, RLS unchanged (grantee read, no grantee write).

## 9. PRs (each with a bot review)

1. Migration `city_tours.stop_info` (alone, merged and applied first).
2. Server: clients, matching, `tourStopInfo` (fetched on the first expand only, never after a computation), cache
   keys, limits.
3. UI: cards and read-out in the tour result and the share page.
4. PDF lines and the sources page text.

## 10. Risks

- Wikipedia intros are written for reading, not listening; some start with pronunciation hints or long lists. The
  clip keeps whole sentences; parentheses with pronunciation (IPA) are removed before speaking only.
- Voices differ by device (good on iOS/macOS, plain on some Android); German voices may be missing on some
  desktops (then the unsupported line shows).
- A wrong `wikidata` tag in OSM gives a wrong card. The card names its source; nothing is invented.
- Commons licence metadata can be incomplete: the picture is then left out.
- Wikimedia APIs have no SLA; without them the tour shows no cards, nothing else changes.

## 11. Decisions on the open questions (Alex, 2026-11-13)

- **[Q1] Language** (changed by Alex the same day): stop info is stored in the tour owner's locale only; the share
  page and the PDF show that language, whatever the viewer's UI language. **Fallback:** when a stop has no
  Wikipedia article in the owner's language, the English article is used instead, labelled as English, with its own
  source line and CC BY-SA credit; the read-out uses an English voice for that text. One text per stop is stored,
  with its language (`StopInfo.lang`); the Wikidata call already returns both sitelinks (`sitefilter=dewiki|enwiki`),
  so the fallback costs at most one more extracts request per tour.
- **[Q2] PDF:** an opt-in checkbox "Ortsinfos aufnehmen" when exporting; when ticked, one line per stop of at most
  140 characters; no pictures and no fact lines (section 6).
- **[Q3] Towns as start or end:** a `geo:` start or end gets no info card (section 2).

## 12. Implementation rules (review of this spec, 2026-11-13)

- **Writes of `stop_info` are atomic merges per stop.** The server writes through one SQL function
  `private.merge_stop_info(tour_id uuid, entries jsonb, locale text)` (security definer, called with the secret
  key): in a single `update … where id = tour_id`, it keeps the stored entries, replaces or adds the fetched ones by
  `key`, and drops every entry whose `key` is no longer a point of the row's **current** `input` (read in the same
  statement). Overlapping fetches therefore never lose each other's entries, and a late fetch cannot restore removed
  stops. A locale change replaces the whole value.
- **`stop_info` writes do not move `updated_at`.** The `city_tours_set_updated_at` trigger skips rows where only
  `stop_info` changed (`when (old.input is distinct from new.input or old.title is distinct from new.title or …)`,
  the migration of PR 1), so `saveResult` and versioned edits see no conflict.
- **Rate limits are durable.** Per user: 60 batches per Berlin day, counted from `app_events` (`tour.stop_info`);
  per share link: 30 per day, counted the same way by link id; app-wide: 2,000 batches per day. In-memory
  `rateLimit` (10 per minute) stays only as a burst guard. When a limit is used up the view is **cache-only**: stored
  info and cached API answers are shown, no request is sent, and the card says "Infos gerade nicht abrufbar".
- **Share-link viewers** may trigger a batch through the share route within those limits (decision 4); they never
  write anything but `stop_info`, and only through `merge_stop_info`.
- **Concurrent cache misses** for the same key are not coalesced: two near-simultaneous fetches of the same public
  article give the same text, and the later upsert only renews the TTL. Accepted.
- **Image credit.** CC BY and CC BY-SA need an artist: without `Artist` metadata such an image is not used. CC0 and
  public domain: the artist is optional; the credit then reads "Foto: Wikimedia Commons, {licence}" with the link to
  the file page.
- **Sources per fact.** The card's source line lists every source it uses with its check date: "Text: Wikipedia …",
  "Fakten: Wikidata", "Website/Öffnungszeiten: OpenStreetMap" (for OSM-derived values).
- **PDF attribution.** With "Ortsinfos aufnehmen", the tour block's source line names each article used:
  "Ortsinfos: Wikipedia-Artikel „Stephansdom“, „Hofburg“ … (CC BY-SA 4.0, creativecommons.org/licenses/by-sa/4.0),
  gekürzt; Fakten: Wikidata", English fallbacks marked "(en)". Each article name is a PDF link to its article URL
  and the licence name links to the licence; the check date is the oldest `checkedAt` of the stops shown.
- **iOS speech activation.** The first `speechSynthesis.speak()` must run inside the tap. Per-stop play exists only
  inside a loaded card, so it speaks in the tap. "Tour vorlesen" is enabled only once the batch is loaded; when it is
  not, the first tap loads it and the button changes to "Jetzt vorlesen", which speaks on the next tap.
- **Voices load late.** The read-out controls listen to `speechSynthesis.onvoiceschanged` and re-check the voices
  for the text's language; the "nicht unterstützt" line disappears when a matching voice arrives.
- **Stop limit.** All bounds use `MAX_TOUR_POINTS`; capacity numbers in this spec assume the 27 points of #221.
- **Daily quotas are reserved, not just counted** (review 2): the limits of this section are checked and taken in one
  function that first takes `pg_advisory_xact_lock` per counted scope (user, share link, app-wide; as
  `ai_call_slots` does), then counts the window and inserts a `pending` reservation row; no reservation, no
  request. The reservation is marked used or released after the batch; a `pending` row older than 2 minutes (a
  batch that died) no longer counts.
- **A stale locale cannot overwrite a newer one** (review 2): `merge_stop_info` takes the batch's locale and applies
  it only when it equals the owner's current locale (read from `profiles` in the same statement); otherwise the
  write is discarded.
- **Duplicate cold batches** from simultaneous first expands are accepted: they are bounded by the reserved quotas,
  served mostly from `api_cache` after the first answer, and merged safely by `merge_stop_info`.
- **Stop names in the read-out** are spoken with the voice of the owner's locale. `TourPoint.name` carries no
  language of its own; place names are mostly proper nouns, so this is accepted.
