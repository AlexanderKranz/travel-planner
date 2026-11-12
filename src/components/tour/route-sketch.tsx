import { sketchGeometry, type SketchLeg, type SketchPoint } from "@/lib/tour/sketch";

/**
 * Route sketch of a city tour (spec 8): leg lines from the stored polylines and numbered stops, no base map. Pure and
 * presentational (no hooks, no client code), so the tour page, the trip day block and the share page can all render
 * it; the PDF draws the same `sketchGeometry` with react-pdf. Dashed legs = a per-leg mode override.
 *
 * Props are a stable API used by other views: keep them additive.
 */
export type RouteSketchProps = {
  legs: SketchLeg[];
  points: SketchPoint[];
  width?: number;
  height?: number;
  /** Accessible name of the drawing (the caller's translated text); without it the sketch is decorative. */
  label?: string;
  className?: string;
};

export function RouteSketch({ legs, points, width, height, label, className }: RouteSketchProps) {
  const g = sketchGeometry({ legs, points, width, height });
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg
      viewBox={`0 0 ${g.width} ${g.height}`}
      className={className ?? "h-auto w-full"}
      preserveAspectRatio="xMidYMid meet"
      {...a11y}
    >
      <rect x="0" y="0" width={g.width} height={g.height} rx="10" className="fill-sunken" />
      {g.paths.map((p) => (
        <path
          key={p.leg}
          d={p.d}
          fill="none"
          className="stroke-accent"
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={p.dashed ? "6 5" : undefined}
        />
      ))}
      {g.points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={p.n !== undefined ? 9 : 4} className="fill-heading stroke-card" strokeWidth={2} />
          {p.n !== undefined && (
            <text x={p.x} y={p.y} dy="0.35em" textAnchor="middle" fontSize="10" fontWeight="700" className="fill-page">
              {p.n}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
