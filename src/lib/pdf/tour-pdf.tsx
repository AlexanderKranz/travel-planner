import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import type { ReactElement } from "react";
import type { StopTime } from "@/lib/tour/timing";
import type { TourBlock } from "@/lib/plan/tour-blocks";
import type { Fmt } from "./format";
import type { PdfT } from "./labels";
import { labelStyle } from "./parts";
import { C, SANS, SERIF } from "./theme";
import { StopInfoSources, TourSketchPdf, tourLine } from "./tour-block";

const s = StyleSheet.create({
  page: { fontFamily: SANS, fontSize: 9, color: C.ink, backgroundColor: C.page, paddingTop: 37, paddingHorizontal: 40, paddingBottom: 54 },
  footer: { position: "absolute", bottom: 20, fontSize: 7, color: C.subtle },
});

export type TourPdfProps = {
  block: TourBlock;
  /** Display title (own title or the default "Wien"). */
  title: string;
  /** Tour date (ISO), when set. */
  date: string | null;
  /** Arrive/leave per stop in visiting order, when the tour has a start time. */
  stopTimes: StopTime[] | null;
  generatedAt: string;
  locale: string;
  t: PdfT;
  fmt: Fmt;
};

/**
 * Standalone city tour as PDF (city-tour 9.3, spec 10 "PDF"): header, time/places/distance, ordered stops with times,
 * the route sketch from the stored polylines, sources. With "Ortsinfos aufnehmen", one stop-info line per stop and the
 * article attribution (city-tour-stop-info 6).
 */
export function TourPdf({ block, title, date, stopTimes, generatedAt, locale, t, fmt }: TourPdfProps): ReactElement {
  return (
    <Document title={title} language={locale} creator="Travel Planner" producer="Travel Planner">
      <Page size="A4" style={s.page}>
        <Text fixed style={{ ...s.footer, left: 40 }}>
          {t("footer")} · {t("generated", { date: fmt.date(generatedAt.slice(0, 10)) })}
        </Text>
        <View>
          <View style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `0.75pt solid ${C.line}` }}>
            <Text style={{ ...labelStyle, fontSize: 7.5, letterSpacing: 1.6, color: C.accent, marginBottom: 4 }}>
              {[t("tour.label"), date ? fmt.date(date) : null].filter(Boolean).join(" · ")}
            </Text>
            <Text style={{ fontFamily: SERIF, fontWeight: 700, fontSize: 26, lineHeight: 1.1, color: C.navy }}>{title}</Text>
            <Text style={{ color: C.muted, marginTop: 4 }}>{tourLine(block, t, fmt)}</Text>
          </View>
          <View>
            {block.stops.map((name, i) => (
              <View key={i} wrap={false} style={{ flexDirection: "row", marginBottom: 4 }}>
                <Text style={{ width: 22, fontWeight: 700, color: C.navy }}>{`${i + 1}.`}</Text>
                <View style={{ flexGrow: 1, flexShrink: 1 }}>
                  <Text style={{ fontWeight: 600 }}>
                    {name}
                    {stopTimes?.[i] ? `  ${stopTimes[i].arrive}${stopTimes[i].leave !== stopTimes[i].arrive ? `–${stopTimes[i].leave}` : ""}` : ""}
                  </Text>
                  {block.info?.lines[i] ? <Text style={{ fontSize: 8, color: C.muted }}>{block.info.lines[i]}</Text> : null}
                </View>
              </View>
            ))}
          </View>
          <View style={{ marginTop: 8 }}>
            <TourSketchPdf tour={block} best={false} width={360} height={230} />
          </View>
          <View style={{ marginTop: 10, borderTop: `0.75pt solid ${C.line}`, paddingTop: 6 }}>
            <Text style={{ fontSize: 7, color: C.subtle }}>{t("tour.sources")}</Text>
            {block.info ? <StopInfoSources info={block.info} t={t} fmt={fmt} color={C.subtle} /> : null}
          </View>
        </View>
      </Page>
    </Document>
  );
}
