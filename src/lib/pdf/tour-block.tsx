import { Circle, Link, Path, Svg, Text, View } from "@react-pdf/renderer";
import { timeRange } from "@/lib/plan/fixed-items";
import type { TourBlock } from "@/lib/plan/tour-blocks";
import type { PdfStopInfo } from "@/lib/stop-info/pdf-lines";
import { sketchGeometry } from "@/lib/tour/sketch";
import type { Fmt } from "./format";
import type { PdfT } from "./labels";
import { labelStyle } from "./parts";
import { C } from "./theme";

const SKETCH_W = 150;
const SKETCH_H = 96;

/** "10:00–13:40 · 5 Orte · 4,2 km zu Fuß" without the label (the PDF translator has no ICU plurals). */
export function tourLine(tour: TourBlock, t: PdfT, fmt: Fmt): string {
  const parts = [
    tour.from ? timeRange(tour.from, tour.to) : null,
    tour.placeCount === 1 ? t("tour.placesOne") : t("tour.places", { count: tour.placeCount }),
    tour.km === null ? null : t("tour.km", { km: fmt.km(tour.km), mode: t(`tour.modes.${tour.mode}`) }),
  ];
  return parts.filter((p): p is string => !!p).join(" · ");
}

/** The route sketch from the stored polylines (react-pdf `Svg`, no base map; city-tour 8). */
export function TourSketchPdf({ tour, best, width = SKETCH_W, height = SKETCH_H }: { tour: TourBlock; best: boolean; width?: number; height?: number }) {
  const g = tour.sketch ? sketchGeometry(tour.sketch.legs, tour.sketch.points, width, height, 8) : null;
  if (!g) return null;
  const line = best ? C.accentLight : C.accent;
  return (
    <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ marginTop: 3 }}>
      {g.paths.map((p, i) => (
        <Path key={i} d={p.d} fill="none" stroke={line} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" strokeDasharray={p.dashed ? "4 3" : undefined} />
      ))}
      {g.dots.map((d, i) => (
        <Circle key={i} cx={d.x} cy={d.y} r={3.2} fill={best ? C.cream : C.navy} />
      ))}
    </Svg>
  );
}

const BY_SA = "https://creativecommons.org/licenses/by-sa/4.0/";

/**
 * "Ortsinfos: Wikipedia-Artikel „Stephansdom“, „Hofburg“ (en) (CC BY-SA 4.0), gekürzt; Fakten: Wikidata · geprüft am …"
 * Each article and the licence are links (city-tour-stop-info 12, PDF attribution).
 */
export function StopInfoSources({ info, t, fmt, color }: { info: PdfStopInfo; t: PdfT; fmt: Fmt; color: string }) {
  return (
    <Text style={{ fontSize: 6.5, color, marginTop: 2 }}>
      {t("tour.stopInfo.articles")}{" "}
      {info.articles.map((a, i) => (
        <Text key={a.url}>
          {i > 0 ? ", " : ""}
          <Link src={a.url} style={{ color }}>{`„${a.title}“`}</Link>
          {a.en ? " (en)" : ""}
        </Text>
      ))}{" "}
      (<Link src={BY_SA} style={{ color }}>CC BY-SA 4.0</Link>), {t("tour.stopInfo.clipped")}
      {info.checkedAt ? ` · ${t("tour.stopInfo.checked", { date: fmt.date(info.checkedAt.slice(0, 10)) })}` : ""}
    </Text>
  );
}

/** One tour in a PDF day card: label, time/places/distance, ordered stops, sketch. */
export function TourRowPdf({ tour, best, t, fmt }: { tour: TourBlock; best: boolean; t: PdfT; fmt: Fmt }) {
  const ink = best ? C.cream : C.ink;
  return (
    <View
      wrap={false}
      style={{
        backgroundColor: best ? "#2c4d78" : C.infoBg,
        borderLeft: `2pt solid ${best ? C.navyMuted : C.infoLine}`,
        borderRadius: 4,
        paddingVertical: 3,
        paddingHorizontal: 6,
        marginTop: 4.5,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Text style={{ ...labelStyle, width: 64, color: best ? C.navyMuted : C.subtle }}>{t("tour.label")}</Text>
        <Text style={{ flexGrow: 1, flexShrink: 1, fontWeight: 600, color: ink }}>{tourLine(tour, t, fmt)}</Text>
      </View>
      {tour.title ? <Text style={{ marginLeft: 64, color: ink }}>{tour.title}</Text> : null}
      {tour.info ? (
        <View style={{ marginLeft: 64 }}>
          {tour.stops.map((name, i) => (
            <Text key={i} style={{ fontSize: 7.5, color: best ? C.navyMuted : C.muted }}>
              {`${i + 1}. ${name}`}
              {tour.info?.lines[i] ? ` – ${tour.info.lines[i]}` : ""}
            </Text>
          ))}
          <StopInfoSources info={tour.info} t={t} fmt={fmt} color={best ? C.navyMuted : C.subtle} />
        </View>
      ) : (
        <Text style={{ marginLeft: 64, fontSize: 7.5, color: best ? C.navyMuted : C.muted }}>
          {tour.stops.map((name, i) => `${i + 1}. ${name}`).join("  ")}
        </Text>
      )}
      <View style={{ marginLeft: 64 }}>
        <TourSketchPdf tour={tour} best={best} />
      </View>
    </View>
  );
}
