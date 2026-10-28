import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import type { SharedItem } from "@/lib/domain/items";
import type { PlanDocument } from "@/lib/domain/share";
import { openItemKey } from "@/lib/plan/open-items";
import type { Fmt } from "./format";
import type { PdfT } from "./labels";

const ACCENT = "#1d4ed8";
const s = StyleSheet.create({
  page: { fontFamily: "NotoSans", fontSize: 9.5, color: "#111", padding: "15mm 15mm 20mm 15mm", lineHeight: 1.35 },
  h1: { fontSize: 20, fontWeight: 700, color: ACCENT, lineHeight: 1.25, marginBottom: 2 },
  meta: { color: "#444", marginTop: 3 },
  small: { fontSize: 8, color: "#555" },
  h2: { fontSize: 13, fontWeight: 700, color: ACCENT, marginTop: 14, marginBottom: 5, borderBottom: "0.75pt solid #ccc", paddingBottom: 2 },
  bold: { fontWeight: 700 },
  day: { marginBottom: 8 },
  dayHead: { fontWeight: 700, fontSize: 10.5, marginBottom: 2 },
  stop: { marginTop: 2, fontWeight: 700 },
  row: { flexDirection: "row", marginTop: 1 },
  time: { width: 62, color: "#444" },
  grow: { flexGrow: 1, flexShrink: 1 },
  tr: { flexDirection: "row", borderBottom: "0.5pt solid #ddd", paddingVertical: 2 },
  note: { color: "#444", marginTop: 2 },
  warn: { color: "#b91c1c", marginTop: 2 },
  footer: { position: "absolute", bottom: "8mm", left: "15mm", right: "15mm", flexDirection: "row", justifyContent: "space-between", fontSize: 7.5, color: "#666" },
});

type Props = { doc: PlanDocument; t: PdfT; fmt: Fmt };

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

const Bullet = ({ children }: { children: string }) => (
  <View style={s.row}>
    <Text style={{ width: 10 }}>•</Text>
    <Text style={s.grow}>{children}</Text>
  </View>
);

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
  const metaParts = [
    h.destination,
    timing,
    `${h.lengthDays} ${t("days")}`,
    h.group ? `${h.group.total} ${t("persons")}` : null,
    h.purposeName,
  ].filter((x): x is string => !!x);
  const items = doc.items?.filter((i) => i.status !== "rejected") ?? [];
  const party = doc.costs?.partySize ?? null;
  const hasNotes = items.some((i) => i.notes);

  return (
    <Document title={h.title} language={plan.locale} creator="Travel Planner" producer="Travel Planner">
      <Page size="A4" style={s.page}>
        <View>
          <Text style={s.h1}>{h.title}</Text>
          <Text style={s.meta}>{metaParts.join(" · ")}</Text>
          <Text style={s.small}>
            {t("aiNote")} · {t("version", { n: doc.versionNo })} · {fmt.date(doc.versionAt)}
          </Text>
        </View>
        <Text style={{ marginTop: 8 }}>{plan.summary}</Text>

        {plan.flights && plan.flights.legs.length > 0 && (
          <View>
            <Text style={s.h2}>{t("flights")}</Text>
            {plan.flights.legs.map((l, i) => (
              <View key={i} style={s.tr} wrap={false}>
                <Text style={{ width: 62 }}>{fmt.date(l.date)}</Text>
                <Text style={{ width: 70 }}>{l.from} → {l.to}</Text>
                <Text style={{ width: 52 }}>{l.number}</Text>
                <Text style={{ width: 80 }}>
                  {l.dep} – {l.arr}
                  {l.arrDayOffset ? " +1" : ""}
                </Text>
                <Text style={{ width: 44 }}>{fmt.duration(l.blockMin)}</Text>
                <Text style={s.grow}>{l.airline ?? ""}</Text>
              </View>
            ))}
            <Text style={[s.small, { marginTop: 3 }]}>{t("flightsNote", { date: fmt.date(plan.flights.fetchedAt) })}</Text>
          </View>
        )}

        {doc.items && doc.items.length > 0 && (
          <View>
            <Text style={s.h2}>{t("costs")}</Text>
            {doc.costs?.currencies.map((c) => (
              <View key={c.currency} style={{ marginBottom: 4 }} wrap={false}>
                <Text>
                  <Text style={s.bold}>{t("booked")}: </Text>
                  {fmt.cents(c.booked.totalCents, c.currency)} ({fmt.cents(c.booked.perPersonCents, c.currency)} {t("perPerson")})
                </Text>
                <Text>
                  <Text style={s.bold}>{t("expected")}: </Text>
                  {fmt.money(c.expected.total, c.currency)} ({fmt.money(c.expected.perPerson, c.currency)} {t("perPerson")})
                </Text>
              </View>
            ))}
            <View style={[s.tr, s.bold, { marginTop: 6 }]} fixed>
              <Text style={{ width: 28 }}></Text>
              <Text style={{ width: 62 }}></Text>
              <Text style={s.grow}>{t("items")}</Text>
              <Text style={{ width: 56 }}></Text>
              <Text style={{ width: 66, textAlign: "right" }}>{t("perPerson")}</Text>
              <Text style={{ width: 66, textAlign: "right" }}>{t("total")}</Text>
            </View>
            {items.map((it) => {
              const a = itemAmounts(it, party);
              const host = it.url ? hostOf(it.url) : null;
              return (
                <View key={it.id} style={{ borderBottom: "0.5pt solid #ddd", paddingVertical: 2 }} wrap={false}>
                  <View style={{ flexDirection: "row" }}>
                    <Text style={{ width: 28 }}>{it.day ?? ""}</Text>
                    <Text style={{ width: 62 }}>{t(`categories.${it.category}`)}</Text>
                    <Text style={s.grow}>{it.title}</Text>
                    <Text style={{ width: 56 }}>{t(`statuses.${it.status}`)}</Text>
                    <Text style={{ width: 66, textAlign: "right" }}>{a.per === null ? "–" : fmt.cents(a.per, it.currency)}</Text>
                    <Text style={{ width: 66, textAlign: "right" }}>{a.total === null ? "–" : fmt.cents(a.total, it.currency)}</Text>
                  </View>
                  {(hasNotes && it.notes) || host ? (
                    <Text style={[s.small, { marginLeft: 90 }]}>{[it.notes, host].filter(Boolean).join(" · ")}</Text>
                  ) : null}
                </View>
              );
            })}
          </View>
        )}

        <Text style={s.h2}>{t("days")}</Text>
        {plan.days.map((d) => (
          <View key={d.n} style={s.day} wrap={d.stops.reduce((n, st) => n + st.acts.length + 1, 0) > 14}>
            <Text style={s.dayHead} minPresenceAhead={60}>
              {t("day", { n: d.n })}
              {d.date ? ` · ${fmt.dayDate(d.date)}` : ""} · {d.title}
              {d.best ? `  (${t("best")})` : ""}
            </Text>
            {d.stops.map((st, i) => (
              <View key={i}>
                <Text style={s.stop}>
                  {st.place}
                  {st.from ? ` (${st.from}${st.to ? `–${st.to}` : ""})` : ""}
                </Text>
                {st.acts.map((a, j) => {
                  const place = a.ref ? plan.places[a.ref]?.name : undefined;
                  return (
                    <View key={j} style={s.row}>
                      <Text style={s.time}>{a.at ? `${a.at}${a.until ? `–${a.until}` : ""}` : ""}</Text>
                      <Text style={s.grow}>
                        {a.text}
                        {place ? ` (${place})` : ""}
                      </Text>
                    </View>
                  );
                })}
              </View>
            ))}
            {d.note && <Text style={s.note}>{t("note")}: {d.note}</Text>}
            {d.warn && <Text style={s.warn}>{t("warning")}: {d.warn}</Text>}
          </View>
        ))}

        {plan.openItems.length > 0 && (
          <View>
            <Text style={s.h2}>{t("openItems")}</Text>
            {plan.openItems.map((o, i) => (
              <View key={i} style={s.row} wrap={false}>
                <Text style={{ width: 20 }}>{isDone(o.text, doc.openDone) ? "[x]" : "[ ]"}</Text>
                <Text style={s.grow}>
                  {o.text}
                  {o.day ? ` (${t("day", { n: o.day })})` : ""}
                </Text>
              </View>
            ))}
          </View>
        )}

        {plan.notes.length > 0 && (
          <View>
            <Text style={s.h2}>{t("tips")}</Text>
            {plan.notes.map((n, i) => (
              <Bullet key={i}>{n.kind === "warning" ? `${t("warning")}: ${n.text}` : n.text}</Bullet>
            ))}
          </View>
        )}

        {plan.packing.length > 0 && (
          <View>
            <Text style={s.h2}>{t("packing")}</Text>
            <Text>{plan.packing.join(" · ")}</Text>
          </View>
        )}

        <View fixed style={s.footer}>
          <Text>
            {t("sources")} · {t("generated", { date: generated })}
          </Text>
          <Text render={({ pageNumber, totalPages }) => t("page", { n: pageNumber, total: totalPages })} />
        </View>
      </Page>
    </Document>
  );
}
