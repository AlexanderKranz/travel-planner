import { Link, Path, Svg, Text, View } from "@react-pdf/renderer";
import type { Style } from "@react-pdf/types";
import type { ReactNode } from "react";
import type { PlanPlace } from "@/lib/domain/plan";
import { placeHref } from "@/lib/facts/sources";
import { C, SANS, SERIF } from "./theme";

/** Small uppercase letter-spaced label ("TAG", "GOLF", table heads). */
export const labelStyle: Style = {
  fontFamily: SANS,
  fontSize: 6.5,
  fontWeight: 600,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  color: C.subtle,
};

export const h2Style: Style = { fontFamily: SERIF, fontWeight: 700, fontSize: 15, color: C.navy, marginBottom: 9 };

export function Pill({
  children,
  bg,
  fg,
  border,
  bold = false,
  size = 7.5,
}: {
  children: ReactNode;
  bg?: string;
  fg: string;
  border?: string;
  bold?: boolean;
  size?: number;
}) {
  return (
    <View
      style={{
        borderRadius: 99,
        paddingVertical: 2.5,
        paddingHorizontal: 8,
        backgroundColor: bg,
        border: border ? `0.75pt solid ${border}` : undefined,
      }}
    >
      <Text style={{ fontSize: size, color: fg, fontWeight: bold ? 700 : 600 }}>{children}</Text>
    </View>
  );
}

/** White rounded card with the Atlas hairline border. */
export function Card({ children, wrap = true, style }: { children: ReactNode; wrap?: boolean; style?: Style }) {
  return (
    <View
      wrap={wrap}
      style={{ backgroundColor: C.card, border: `0.75pt solid ${C.line}`, borderRadius: 9, padding: 11, marginBottom: 9, ...style }}
    >
      {children}
    </View>
  );
}

/** Drawn checkbox (no glyphs): square outline, filled with a tick when done. */
export function Checkbox({ done }: { done: boolean }) {
  return (
    <View
      style={{
        width: 9,
        height: 9,
        marginTop: 1,
        marginRight: 7,
        borderRadius: 2,
        border: `1pt solid ${C.navy}`,
        backgroundColor: done ? C.navy : C.card,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {done && (
        <Svg viewBox="0 0 10 10" style={{ width: 6.5, height: 6.5 }}>
          <Path d="M1.5 5.5 L4 8 L8.5 2" stroke={C.cream} strokeWidth={1.6} fill="none" />
        </Svg>
      )}
    </View>
  );
}

/** Place name as a link (website → Wikipedia → OSM). */
export function PlaceName({ place, bold, color = C.navy }: { place: PlanPlace; bold?: boolean; color?: string }) {
  const href = placeHref(place);
  const style: Style = bold ? { fontWeight: 700 } : {};
  return href ? (
    <Link src={href} style={{ ...style, color, textDecoration: "none" }}>
      {place.name}
    </Link>
  ) : (
    <Text style={style}>{place.name}</Text>
  );
}
