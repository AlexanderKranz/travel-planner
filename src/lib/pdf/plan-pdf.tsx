import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import { windowKind } from "@/components/plan/helpers";
import type { SharedItem } from "@/lib/domain/items";
import { isUserBest, type PlanDay, type PlanFlights } from "@/lib/domain/plan";
import type { PlanDocument } from "@/lib/domain/share";
import { flightGroups } from "@/lib/flights/groups";
import { fittingLegs } from "@/lib/flights/ui";
import { fixedItemsOf, mergeDayRows, timeRange, type FixedItem } from "@/lib/plan/fixed-items";
import { openItemKey } from "@/lib/plan/open-items";
import type { Fmt } from "./format";
import type { PdfT } from "./labels";
import { Card, Checkbox, h2Style, labelStyle, PlaceName, Pill } from "./parts";
import { C, SANS, SERIF } from "./theme";

const s = StyleSheet.create({
  page: { fontFamily: SANS, fontSize: 9, color: C.ink, backgroundColor: C.page, paddingTop: 37, paddingHorizontal: 40, paddingBottom: 54 },
  grow: { flexGrow: 1, flexShrink: 1 },
  row: { flexDirection: "row" },
  small: { fontSize: 7.5, color: C.subtle },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 40,
    fontSize: 7,
    color: C.subtle,
  },
});

type Props = { doc: PlanDocument; t: PdfT; fmt: Fmt };
type Leg = PlanFlights["legs"][number];

function itemAmounts(it: SharedItem, party: number | null): { total: number | null; per: number | null } {
  if (it.priceCents === null) return { total: null, per: null };
  const n = it.persons ?? party;
  if (it.priceBasis === "per_person") return { per: it.priceCents, total: n ? it.priceCents * n : null };
  return { total: it.priceCents, per: n ? Math.round(it.priceCents / n) : null };
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function isDone(text: string, done: string[]): boolean {
  try {
    return done.includes(openItemKey(text));
  } catch {
    return false; // key helper not available: show unchecked
  }
}

const STATUS = {
  booked: { bg: C.okBg, fg: C.okFg, border: C.okLine },
  planned: { bg: C.infoBg, fg: C.infoFg, border: C.infoLine },
  option: { bg: C.warnBg, fg: C.warnFg, border: "#e0a77f" },
  rejected: { bg: C.sunken, fg: C.muted, border: C.line },
} as const;

function StatusPill({ status, label }: { status: keyof typeof STATUS; label: string }) {
  const c = STATUS[status];
  return (
    <Pill bg={c.bg} fg={c.fg} border={c.border} size={6.5}>
      {label}
    </Pill>
  );
}

function plural(t: PdfT, key: string, count: number) {
  return t(`group.${key}.${count === 1 ? "one" : "other"}`, { count });
}

function Heading({ children }: { children: string }) {
  return (
    <Text style={[h2Style, { marginTop: 8 }]} minPresenceAhead={70}>
      {children}
    </Text>
  );
}

/** Stop window as pill text: "14:00–23:59", "ab 14:00", "bis 16:00" (same keys as the app). */
function windowText(from: string | undefined, to: string | undefined, t: PdfT): string {
  if (from && to) return `${from}–${to}`;
  return from ? t("windowFrom", { time: from }) : t("windowUntil", { time: to ?? "" });
}

/** Activity / item time as a rounded pill in a fixed-width column (pills align); empty column when untimed. */
function TimePill({ time, best }: { time: string; best: boolean }) {
  return (
    <View style={{ width: 64, flexDirection: "row" }}>
      {time ? (
        <Text
          style={{
            fontWeight: 600,
            fontSize: 7.5,
            color: best ? C.cream : C.navy,
            backgroundColor: best ? C.timeBgBest : C.timeBg,
            borderRadius: 6,
            paddingVertical: 1,
            paddingHorizontal: 4,
          }}
        >
          {time}
        </Text>
      ) : null}
    </View>
  );
}

function DayCard({ day, doc, fixed, t, fmt }: { day: PlanDay; doc: PlanDocument; fixed: FixedItem[]; t: PdfT; fmt: Fmt }) {
  const { plan } = doc;
  const merged = mergeDayRows(day, fixed);
  const best = isUserBest(day);
  const ink = best ? C.cream : C.ink;
  const muted = best ? C.navyMuted : C.subtle;
  const rowCount = merged.reduce((n, st) => n + st.rows.length + 1, 0);
  return (
    <View
      wrap={rowCount > 14}
      style={{
        flexDirection: "row",
        backgroundColor: best ? C.navy : C.card,
        border: `0.75pt solid ${best ? C.navy : C.line}`,
        borderRadius: 10,
        padding: 11,
        marginBottom: 8,
      }}
    >
      <View style={{ width: 40, alignItems: "center", marginRight: 10 }}>
        <Text style={{ ...labelStyle, color: muted }}>{t("dayShort")}</Text>
        <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 25, lineHeight: 1.05, color: best ? C.accentLight : C.accent }}>{day.n}</Text>
        {day.date && <Text style={{ fontSize: 6.5, color: muted, marginTop: 2 }}>{fmt.dayDate(day.date)}</Text>}
      </View>
      <View style={s.grow}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", marginBottom: 5 }}>
          <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 12, lineHeight: 1.25, color: best ? C.cream : C.ink, marginRight: 6 }}>{day.title}</Text>
          {best && (
            <Pill bg={C.accentLight} fg={C.ink} bold size={6.5}>
              {t("best").toUpperCase()}
            </Pill>
          )}
        </View>
        {day.stops.map((st, i) => {
          const wk = windowKind(st.from, st.to);
          const showHead = day.stops.length > 1 || st.place !== day.title || !!wk || !!st.fixed;
          return (
            <View key={i} style={{ marginTop: i > 0 ? 5 : 0, marginBottom: 2 }}>
              {showHead && (
                <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 2 }}>
                  <Text style={{ fontWeight: 700, fontSize: 8.5, color: best ? C.cream : C.navy, marginRight: 4 }}>{st.place}</Text>
                  {wk && (
                    <Pill bg={best ? C.timeBgBest : C.timeBg} fg={best ? C.cream : C.navy} bold size={7}>
                      {windowText(st.from, st.to, t)}
                    </Pill>
                  )}
                </View>
              )}
              {merged[i].rows.map((row, j) => {
                if (row.kind === "fixed") {
                  const it = row.item;
                  return (
                    <View
                      key={`f${j}`}
                      wrap={false}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        backgroundColor: best ? "#2c4d78" : C.okBg,
                        borderLeft: `2pt solid ${best ? C.okLight : C.okLine}`,
                        borderRadius: 4,
                        paddingVertical: 3,
                        paddingHorizontal: 6,
                        marginTop: 4.5,
                      }}
                    >
                      <TimePill best={best} time={timeRange(it.from, it.to)} />
                      <Text style={{ ...labelStyle, width: 60, color: best ? C.navyMuted : C.subtle }}>{t(`categories.${it.category}`)}</Text>
                      <Text style={{ ...s.grow, fontWeight: 600, color: ink }}>{it.title}</Text>
                      <StatusPill status={it.status} label={t(`statuses.${it.status}`)} />
                    </View>
                  );
                }
                const a = row.act;
                const place = a.ref ? plan.places[a.ref] : undefined;
                const alts = place ? (a.alts ?? []).flatMap((k) => (plan.places[k] ? [plan.places[k]] : [])) : [];
                const time = a.at ? `${a.at}${a.until ? `–${a.until}` : ""}` : "";
                return (
                  <View key={j} wrap={false} style={{ flexDirection: "row", marginTop: 4.5 }}>
                    <TimePill best={best} time={time} />
                    <Text style={{ ...labelStyle, width: 60, paddingTop: 1.5, color: a.kind === "sport" ? (best ? C.okLight : C.okLine) : muted }}>
                      {t(`kinds.${a.kind}`)}
                    </Text>
                    <View style={{ ...s.grow }}>
                      <Text style={{ color: ink }}>
                        {place ? <PlaceName place={place} bold color={best ? "#ffffff" : C.navy} /> : null}
                        {place ? " · " : ""}
                        {a.text}
                      </Text>
                      {alts.length > 0 && (
                        <Text style={{ fontSize: 7.5, color: muted }}>
                          {t("alternatives")}:{" "}
                          {alts.map((p, k) => (
                            <Text key={k}>
                              {k > 0 ? " · " : ""}
                              <PlaceName place={p} color={best ? C.navyMuted : C.navy} />
                            </Text>
                          ))}
                        </Text>
                      )}
                    </View>
                  </View>
                );
              })}
            </View>
          );
        })}
        {day.note && (
          <View style={{ backgroundColor: best ? "#2c4d78" : C.sunken, borderRadius: 6, padding: 6, marginTop: 3 }}>
            <Text style={{ color: ink }}>
              <Text style={{ fontWeight: 700 }}>{t("note")}: </Text>
              {day.note}
            </Text>
          </View>
        )}
        {day.warn && (
          <View style={{ backgroundColor: C.warnBg, borderRadius: 6, padding: 6, marginTop: 3 }}>
            <Text style={{ color: C.warnFg }}>
              <Text style={{ fontWeight: 700 }}>{t("warning")}: </Text>
              {day.warn}
            </Text>
          </View>
        )}
      </View>
    </View>
  );
}

function FlightsCard({ flights, t, fmt }: { flights: PlanFlights; t: PdfT; fmt: Fmt }) {
  const legs = fittingLegs(flights.legs);
  if (legs.length === 0) return null;
  return (
    <Card>
      <Text style={h2Style} minPresenceAhead={90}>{t("flights")}</Text>
      {flightGroups(legs).map((g) => (
        <View key={`${g.dir}-${g.from}-${g.to}`} style={{ marginBottom: 5 }} wrap={false}>
          <Text style={{ ...labelStyle, color: g.dir === "out" ? C.accent : C.navy, marginBottom: 2 }}>
            {t(g.dir === "out" ? "flightsOut" : "flightsBack", {
              date: fmt.dayDate(g.dir === "out" ? flights.outDate : flights.backDate),
              route: `${g.from} → ${g.to}`,
            })}
          </Text>
          {g.legs.map((l: Leg, i: number) => (
            <View key={i} style={{ flexDirection: "row", borderBottom: i < g.legs.length - 1 ? `0.5pt solid ${C.line}` : undefined, paddingVertical: 2.5 }}>
              <Text style={{ width: 56, fontWeight: 700 }}>{l.number}</Text>
              <Text style={{ width: 150 }}>
                {l.from} {l.dep} → {l.to} {l.arr}
                {l.arrDayOffset ? " +1" : ""}
              </Text>
              <Text style={{ width: 50, color: C.subtle }}>{fmt.duration(l.blockMin)}</Text>
              <Text style={{ ...s.grow, color: C.subtle }}>{l.airline ?? ""}</Text>
            </View>
          ))}
        </View>
      ))}
      <Text style={s.small}>{t("flightsNote", { date: fmt.date(flights.fetchedAt) })}</Text>
    </Card>
  );
}

function CostsCard({ doc, t, fmt }: { doc: PlanDocument; t: PdfT; fmt: Fmt }) {
  const items = doc.items?.filter((i) => i.status !== "rejected") ?? [];
  const party = doc.costs?.partySize ?? null;
  const hasNotes = items.some((i) => i.notes);
  const head = { ...labelStyle };
  // Up to ~14 rows the card moves to the next page as a whole (no orphaned heading); longer lists flow.
  return (
    <Card wrap={items.length > 14}>
      <Text style={h2Style} minPresenceAhead={90}>{t("costs")}</Text>
      {doc.costs?.currencies.map((c) => (
        <View key={c.currency} style={{ marginBottom: 8 }} wrap={false}>
          {doc.costs!.currencies.length > 1 && <Text style={{ fontWeight: 700, marginBottom: 2 }}>{c.currency}</Text>}
          <View style={{ flexDirection: "row", borderBottom: `0.75pt solid ${C.line}`, paddingBottom: 3 }}>
            <Text style={{ width: 90 }} />
            <Text style={{ ...head, width: 150 }}>{t("booked")}</Text>
            <Text style={{ ...head, ...s.grow }}>{t("expected")}</Text>
          </View>
          {(
            [
              [t("perPerson"), fmt.cents(c.booked.perPersonCents, c.currency), fmt.money(c.expected.perPerson, c.currency)],
              [t("total"), fmt.cents(c.booked.totalCents, c.currency), fmt.money(c.expected.total, c.currency)],
            ] as const
          ).map(([label, booked, expected], i) => (
            <View key={i} style={{ flexDirection: "row", paddingVertical: 3, borderBottom: i === 0 ? `0.5pt solid ${C.line}` : undefined }}>
              <Text style={{ ...head, width: 90, paddingTop: 1 }}>{label}</Text>
              <Text style={{ width: 150, fontWeight: 700 }}>{booked}</Text>
              <Text style={s.grow}>{expected}</Text>
            </View>
          ))}
        </View>
      ))}
      {items.length > 0 && (
        <View>
          <View style={{ flexDirection: "row", borderBottom: `0.75pt solid ${C.line}`, paddingBottom: 3 }}>
            <Text style={{ ...head, width: 22 }} />
            <Text style={{ ...head, width: 58 }} />
            <Text style={{ ...head, ...s.grow }}>{t("items")}</Text>
            <Text style={{ ...head, width: 56 }} />
            <Text style={{ ...head, width: 62, textAlign: "right" }}>{t("perPerson")}</Text>
            <Text style={{ ...head, width: 62, textAlign: "right" }}>{t("total")}</Text>
          </View>
          {items.map((it) => {
            const a = itemAmounts(it, party);
            const host = it.url ? hostOf(it.url) : null;
            return (
              <View key={it.id} style={{ borderBottom: `0.5pt solid ${C.line}`, paddingVertical: 3 }} wrap={false}>
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  <Text style={{ width: 22, fontWeight: 600, color: C.accent }}>{it.day ?? ""}</Text>
                  <Text style={{ ...labelStyle, width: 58 }}>{t(`categories.${it.category}`)}</Text>
                  <Text style={s.grow}>
                    {it.startTime ? `${timeRange(it.startTime, it.endTime)} · ` : ""}
                    {it.title}
                  </Text>
                  <View style={{ width: 56, alignItems: "flex-start" }}>
                    <StatusPill status={it.status} label={t(`statuses.${it.status}`)} />
                  </View>
                  <Text style={{ width: 62, textAlign: "right" }}>{a.per === null ? "–" : fmt.cents(a.per, it.currency)}</Text>
                  <Text style={{ width: 62, textAlign: "right", fontWeight: 600 }}>{a.total === null ? "–" : fmt.cents(a.total, it.currency)}</Text>
                </View>
                {(hasNotes && it.notes) || host ? (
                  <Text style={{ ...s.small, marginLeft: 80 }}>{[it.notes, host].filter(Boolean).join(" · ")}</Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}
    </Card>
  );
}

export function PlanPdf({ doc, t, fmt }: Props): ReactElement {
  const { plan } = doc;
  const h = plan.header;
  const generated = fmt.date(h.generatedAt);
  const timing =
    h.timing.kind === "date"
      ? `${fmt.date(h.timing.startDate)} – ${fmt.date(h.timing.endDate)}`
      : h.timing.kind === "months"
        ? fmt.months(h.timing.months)
        : t("datesOpen");
  const eyebrow = [h.purposeName, timing].filter((x): x is string => !!x).join(" · ");
  const g = h.group && h.group.total > 0 ? h.group : null;
  // Booked/planned items with day + start time, merged into the day rows (same as the web views).
  const fixed = doc.items ? fixedItemsOf(doc.items, plan.days.length) : [];
  const facts = plan.facts;
  const daylight = facts.daylight?.days.length ? facts.daylight.days : null;
  const rises = daylight?.map((d) => d.sunrise).filter((x): x is string => !!x) ?? [];
  const dusks = daylight?.map((d) => d.dusk).filter((x): x is string => !!x) ?? [];
  const month = (m: number) => new Intl.DateTimeFormat(plan.locale, { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2000, m - 1, 15)));
  const num = (n: number) => new Intl.NumberFormat(plan.locale, { maximumFractionDigits: 1 }).format(n);
  const hasFacts = !!facts.climate || (rises.length > 0 && dusks.length > 0) || !!facts.airports?.length;
  const flights = plan.flights;

  return (
    <Document title={h.title} language={plan.locale} creator="Travel Planner" producer="Travel Planner">
      <Page size="A4" style={s.page}>
        <Text fixed style={{ ...s.footer, left: 40 }}>
          {t("footer")} · {t("generated", { date: generated })}
        </Text>
        <Text fixed style={{ ...s.footer, left: 415, width: 140, textAlign: "right" }} render={({ pageNumber, totalPages }) => t("page", { n: pageNumber, total: totalPages })} />
        {/* No lineHeight on <Page> or around the footer: react-pdf drops fixed footers with a render Text when one is inherited. */}
        <View>
        <View style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `0.75pt solid ${C.line}` }}>
          {eyebrow && <Text style={{ ...labelStyle, fontSize: 7.5, letterSpacing: 1.6, color: C.accent, marginBottom: 4 }}>{eyebrow}</Text>}
          <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 30, lineHeight: 1.1, color: C.navy }}>{h.title}</Text>
          <Text style={{ color: C.muted, marginTop: 4 }}>
            {h.destination}
          </Text>
          {plan.summary ? (
            <Text style={{ fontFamily: SERIF, fontSize: 11.5, lineHeight: 1.5, color: "#3a4553", marginTop: 6 }}>{plan.summary}</Text>
          ) : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", marginTop: 8 }}>
            <View style={{ marginRight: 5, marginBottom: 4 }}>
              <Pill bg={C.navy} fg={C.cream} bold>
                {`${h.lengthDays} ${t("daysUnit")}`}
              </Pill>
            </View>
            {g && g.adults > 0 && (
              <View style={{ marginRight: 5, marginBottom: 4 }}>
                <Pill fg={C.navy} border={C.navy}>{plural(t, "adults", g.adults)}</Pill>
              </View>
            )}
            {g && g.children > 0 && (
              <View style={{ marginRight: 5, marginBottom: 4 }}>
                <Pill fg={C.navy} border={C.navy}>{plural(t, "children", g.children)}</Pill>
              </View>
            )}
            {g && g.toddlers > 0 && (
              <View style={{ marginRight: 5, marginBottom: 4 }}>
                <Pill fg={C.navy} border={C.navy}>{plural(t, "toddlers", g.toddlers)}</Pill>
              </View>
            )}
            {g && g.unknown > 0 && (
              <View style={{ marginRight: 5, marginBottom: 4 }}>
                <Pill fg={C.navy} border={C.navy}>{plural(t, "unknown", g.unknown)}</Pill>
              </View>
            )}
            <View style={{ marginRight: 5, marginBottom: 4 }}>
              <Pill bg={C.accentSoft} fg={C.accentSoftFg} bold>
                {t("aiNote")}
              </Pill>
            </View>
          </View>
          <Text style={{ ...s.small, marginTop: 2 }}>
            {t("aiDisclaimer", { date: generated })} · {t("version", { n: doc.versionNo })} · {fmt.date(doc.versionAt)}
          </Text>
        </View>

        <Heading>{t("days")}</Heading>
        {plan.days.map((d) => (
          <DayCard key={d.n} day={d} doc={doc} fixed={fixed} t={t} fmt={fmt} />
        ))}

        {/* Drive times are display-on-request in the web views and omitted in the PDF (spec timed-items [D15]). */}

        {flights && <FlightsCard flights={flights} t={t} fmt={fmt} />}

        {plan.notes.length > 0 && (
          <Card>
            <Text style={h2Style} minPresenceAhead={90}>{t("tips")}</Text>
            {plan.notes.map((n, i) =>
              n.kind === "warning" ? (
                <View key={i} wrap={false} style={{ backgroundColor: C.warnBg, borderRadius: 6, padding: 6, marginBottom: 3 }}>
                  <Text style={{ color: C.warnFg }}>
                    <Text style={{ fontWeight: 700 }}>{t("warning")}: </Text>
                    {n.text}
                  </Text>
                </View>
              ) : (
                <View key={i} wrap={false} style={{ ...s.row, marginBottom: 3 }}>
                  <Text style={{ width: 10, color: C.accent }}>•</Text>
                  <Text style={s.grow}>{n.text}</Text>
                </View>
              ),
            )}
          </Card>
        )}

        {plan.openItems.length > 0 && (
          <Card>
            <Text style={h2Style} minPresenceAhead={90}>{t("openItems")}</Text>
            {plan.openItems.map((o, i) => {
              const done = isDone(o.text, doc.openDone);
              return (
                <View key={i} style={{ ...s.row, marginBottom: 3 }} wrap={false}>
                  <Checkbox done={done} />
                  <Text style={{ ...s.grow, textDecoration: done ? "line-through" : "none", color: done ? C.subtle : C.ink }}>
                    {o.text}
                    {o.day ? ` (${t("day", { n: o.day })})` : ""}
                  </Text>
                </View>
              );
            })}
          </Card>
        )}

        {plan.packing.length > 0 && (
          <Card>
            <Text style={h2Style} minPresenceAhead={90}>{t("packing")}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
              {plan.packing.map((it, i) => (
                <View key={i} style={{ border: `0.75pt solid ${C.line}`, backgroundColor: C.page, borderRadius: 99, paddingVertical: 2.5, paddingHorizontal: 8, marginRight: 4, marginBottom: 4 }}>
                  <Text>{it}</Text>
                </View>
              ))}
            </View>
          </Card>
        )}

        {hasFacts && (
          <Card wrap={false}>
            <Text style={h2Style} minPresenceAhead={90}>{t("facts.title")}</Text>
            {facts.climate && (
              <Text style={{ marginBottom: 2 }}>
                <Text style={{ fontWeight: 700 }}>{t("facts.climate")}: </Text>
                {facts.climate.months
                  .map((m) => t("facts.climateMonth", { month: month(m.month), tmax: Math.round(m.tMaxC), tmin: Math.round(m.tMinC), wet: num(m.wetDays) }))
                  .join("; ")}
              </Text>
            )}
            {rises.length > 0 && dusks.length > 0 && (
              <Text style={{ marginBottom: 2 }}>
                <Text style={{ fontWeight: 700 }}>{t("facts.daylight")}: </Text>
                {t("facts.daylightRange", { sunrise: rises.reduce((a, b) => (a < b ? a : b)), dusk: dusks.reduce((a, b) => (a > b ? a : b)) })}
              </Text>
            )}
            {facts.airports && facts.airports.length > 0 && (
              <Text style={{ marginBottom: 2 }}>
                <Text style={{ fontWeight: 700 }}>{t("facts.airports")}: </Text>
                {facts.airports.map((a) => `${a.name} (${a.iata}, ${t("facts.km", { km: num(a.km) })})`).join("; ")}
              </Text>
            )}
            <Text style={{ ...s.small, marginTop: 3 }}>{t("sources")}</Text>
          </Card>
        )}

        {doc.items && doc.items.length > 0 && <CostsCard doc={doc} t={t} fmt={fmt} />}

        </View>
      </Page>
    </Document>
  );
}
