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

Not in scope: a narrated or rewritten guide (would need a new rule 2 use), recorded audio, offline packs, location
tracking, user-written notes per stop.

## 1. Ground rules applied

- **Rule 1.** Text, facts and pictures come from Wikipedia (TextExtracts), Wikidata (claims) and Commons (image
  metadata), matched by the stop's own OSM `wikidata` tag. Each card shows its sources and check date. Nothing is
  guessed: a stop without a match shows its name and the facts that exist, or nothing.
- **Rule 2.** No LLM. The read-out speaks the stored text as it is.
- **Rule 3.** Optional: a tour works without any info; the cards load after the tour.
- **Rule 5.** Labels, fact sentences and controls in `messages/*.json` (de + en). The fetched text is in the tour
  owner's locale (de or en Wikipedia); en is the fallback when the owner's language has no article.
- **Rule 6.** Stored on the tour row (owner RLS as `city_tours`; share link read by token through the server route).
- **Rule 7.** Cards and controls work at 360 px (section 6).
- **Rule 8.** Every call cached in `api_cache`; Wikimedia etiquette (serial batches, the app's User-Agent).

## 2. Matching a stop to an article [S1]

Per stop key, cheapest first:
1. **`osm:` key in the cached city places or landmarks** (both carry `wikidata` and `wikipedia` tags,
   `facts/places.ts`, `facts/landmarks.ts`): read by key, 0 calls.
2. **Other `osm:` keys:** one Overpass query by element ids for the tour (`node(id:…);way(id:…);relation(id:…);
   out tags;`), only the `wikidata`/`wikipedia`/`website`/`opening_hours` tags, cached
   `cacheKey("osm-tags", 1, { ids: hash })` 30 d.
3. **`geo:` (a town) or `gfy:` (an address) keys:** no info card. A town start or end is not a sight; an address has
   no stable identity. *Recommended*; the alternative (geosearch on Wikipedia by coordinates) mismatches easily.

A `wikidata` id wins over a `wikipedia` tag (the tag's title is used only when there is no id). Ids are checked with
`^Q\d{1,12}$`.

## 3. Data sources and calls [S2]

Per tour, all batched (at most 27 stops):

| Call | Request | Gives | Cache key | TTL |
|---|---|---|---|---|
| Wikidata entities | `wbgetentities&ids=Q1|Q2…&props=sitelinks|claims&sitefilter=dewiki|enwiki` (≤ 50 ids) | article titles in de/en; claims P18 image, P571 inception, P84 architect, P1435 heritage designation, P856 website | `cacheKey("wd-stop", 1, { ids: hash })` | 30 d |
| Wikidata labels | `wbgetentities&ids=…&props=labels&languages=de|en` for the architect and heritage items | their names | `cacheKey("wd-labels", 1, { ids: hash })` | 90 d |
| Wikipedia extracts | `query&prop=extracts&exintro&explaintext&exlimit=20&titles=…` per language (one or two requests) | intro text | `cacheKey("wp-extract", 1, { lang, titles: hash })` | 30 d |
| Commons image info | `prop=imageinfo&iiprop=url|size|mime|extmetadata&titles=File:…` (≤ 50) | thumbnail, licence, artist | `cacheKey("commons-info", 1, { titles: hash })` | 60 d |

- A cold 25-stop tour costs about 4–5 requests (plus one Overpass query when stops are outside the cached places).
  A recomputed tour with the same stops costs 0.
- Providers `wikidata`, `wikipedia`, `wikimedia` exist (picture, sitelinks, destination summary); calls are logged in
  `api_calls` as `stop_entities`, `stop_labels`, `stop_extracts`, `stop_images`.
- Text: the intro clipped on a sentence boundary to at most 700 characters (`clipParagraphs` of `wikivoyage.ts`),
  marked "gekürzt" when clipped. Disambiguation pages and pages without an extract are dropped.
- Images: only free licences (CC0, public domain, CC BY, CC BY-SA in their versions; same rule as the destination
  picture in `facts/picture.ts`), a standard thumbnail width (330 px). `Artist` is HTML from Commons: reduced to
  plain text, never rendered as HTML. Unknown or non-free licence = no picture.
- Facts: inception as a year ("Erbaut 1147", "Eröffnet 1891" for a station or museum by `cat`), at most two
  architects, one heritage designation, website (also from the OSM tag), OSM `opening_hours` raw as today.

## 4. Data model [S3]

A new column, not part of `result`: **`city_tours.stop_info jsonb`** (null = not fetched yet), check
`pg_column_size(stop_info) <= 65536`, written with the secret key like `result`. *Recommended*: `result` already
spends 200 kB of its 256 kB on route lines (25 stops), and the info changes on a different schedule (articles
change; the route does not). Alternative: inside `result` with a smaller polyline budget.

```ts
export const StopInfo = z.object({
  key: z.string(),                          // tour point key
  qid: z.string().regex(/^Q\d{1,12}$/),
  lang: z.enum(["de", "en"]),               // language of title and text
  title: z.string().max(200),               // Wikipedia article title (link)
  text: z.string().max(700),
  clipped: z.boolean(),
  image: z.object({ url: z.string().url(), w: z.number(), h: z.number(), licence: z.string().max(60),
    licenceUrl: z.string().url().optional(), artist: z.string().max(200), file: z.string().max(240) }).optional(),
  facts: z.object({ year: z.number().int().optional(), architects: z.array(z.string().max(80)).max(2).optional(),
    heritage: z.string().max(120).optional(), website: z.string().url().optional() }),
});
export const TourStopInfo = z.object({
  v: z.literal(1),
  locale: z.enum(["de", "en"]),             // the owner's locale when fetched
  stops: z.array(StopInfo).max(27),
  fetchedAt: z.string(),                    // oldest source date, shown as "abgerufen am"
});
```

Size: about 1.2 kB per stop, 33 kB for 27 stops. A tour edit that changes the stop set keeps the info of the
remaining stops and fetches only the new ones.

## 5. When it is fetched [S4]

- **Lazily, on the first expand.** Nothing is fetched with the computation or on page load. The first time any stop
  of a tour is expanded, `tourStopInfo(id)` fetches the info **for all stops of the tour in one batch** and stores
  it in `stop_info`; later expands (of any stop, by anyone) read what is stored. *Recommended* over a per-stop fetch:
  the APIs are batched (section 3), so all 27 stops cost the same 4–5 requests as one stop, and the next expand then
  answers instantly. Budget 4 s; stops not done in time are fetched on their own expand.
- **Who can trigger it:** the owner and read grantees (session, RLS read), and share-link viewers through the share
  route by token. All of them write only `stop_info`, through the server with the secret key; nobody else's input
  changes. Share-link fetches are rate limited per token (10 per hour) on top of the per-user limits.
- **Stops added later** have no entry; their first expand fetches them (and any other missing stops) in one batch.
- Refresh: an entry older than 30 days is fetched again on its next expand. No background job.
- Rate limit: 10 per minute and 60 per day per user (the calls are cheap, the limit guards against loops).

## 6. UI [S5]

**Tour result.** Each stop row gets a toggle button "Infos zum Ort" (`aria-expanded`, `aria-controls`), collapsed by
default; only stops with a possible match (section 2) show it. Expanding shows "Wird geladen…" until the batch
answers, then the card (or "Für diesen Ort gibt es keine Infos"):
- picture (330 px, `next/image` from `upload.wikimedia.org`, already allowed in `next.config.ts`; the image optimizer
  fetches it, not the viewer's browser), with credit "Foto: {artist}, {licence}" linking to the Commons file;
- text, then "Weiter auf Wikipedia" (link to the article);
- facts as short lines: "Erbaut 1147", "Architekt: …", "Denkmalschutz: …", website link;
- source line: "Text: Wikipedia, CC BY-SA 4.0 (gekürzt) · Fakten: Wikidata · abgerufen am {date}".

**Read-out (Web Speech API).**
- Shown only when `window.speechSynthesis` exists and a voice for the text's language exists; otherwise one muted
  line "Vorlesen wird von diesem Browser nicht unterstützt".
- Per stop: a play button inside the expanded card; while reading it becomes pause, then resume. A small bar above
  the stop list, shown only once any card is open: "Tour vorlesen" (from the first stop with text; it fetches the
  info batch if needed), pause/resume, "Nächster Ort" (expands the next stop's card while reading it), stop. Only one
  utterance at a time; starting another stop stops the current one.
- Spoken text: "{n}. {name}." then the card text, then the fact lines as sentences. No picture credits, no links.
- Long texts are split into sentence chunks (Chrome cuts long utterances; iOS needs the first `speak` inside the tap).
- Accessibility: buttons at least 44 × 44 px with text labels (`aria-pressed` for play/pause), an `aria-live="polite"`
  status "Liest: {name}" (not repeating the text), keyboard operable, no autoplay. Reading stops when the page is
  hidden (`visibilitychange`) to avoid audio from a background tab.
- Nothing is sent anywhere: the browser speaks locally (some systems use an online voice of their own; the help
  text says "Die Stimme kommt von deinem Gerät").

**Share page.** The same collapsed toggles, cards and read-out. Stored info is read by token through the server
route; a first expand with nothing stored triggers the batch fetch through the share route (section 5).

**Trip PDF.** Nothing can be toggled on paper, so the PDF stays compact by default ([Q2], *Recommended*): an
**opt-in "Ortsinfos aufnehmen"** checkbox next to the PDF download (off by default). Off: the PDF is as today. On:
**one line per stop** under its name, the first sentence of the text (at most 140 characters, cut on a word with
"…"), plus the sources line in the tour block ("Ortsinfos: Wikipedia (CC BY-SA 4.0), Wikidata"). Missing info is
fetched for the export in the batch (same budget); stops still missing get no line. No pictures and no facts lines
in the PDF. Alternative: always one line per stop when info is stored, without a checkbox.

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
2. Server: clients, matching, `tourStopInfo`, after-compute fetch, cache keys, limits.
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

## 11. Open questions for Alex

- **[Q1] Language of the text on the share page and PDF:** the owner's locale only (*Recommended*: one fetch, the
  share viewer sees the owner's language), or both de and en stored (double calls and size).
- **[Q2] Stop info in the PDF:** opt-in checkbox "Ortsinfos aufnehmen" with one line per stop (*Recommended*), or
  always one line per stop when info is stored (no checkbox). Either way no pictures and no facts in the PDF.
- **[Q3] Start and end that are towns (`geo:`):** no card (*Recommended*) or the town's Wikipedia intro as for the
  destination summary.
