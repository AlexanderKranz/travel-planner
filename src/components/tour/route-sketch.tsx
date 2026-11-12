import { sketchGeometry, type SketchLeg, type SketchPoint } from "@/lib/tour/sketch";

/**
 * Route sketch without a base map (city-tour 8): the stored leg polylines (dashed for a per-leg mode) and numbered
 * stops. Presentational (no hooks), used by the trip day block, the tour page's map fallback and, through
 * `sketchGeometry`, the PDF. Decorative unless a `label` is given: the stop list next to it carries the content.
 * The props are a stable API shared by these views: keep changes additive.
 */
export function RouteSketch({
  legs,
  points,
  width = 320,
  height = 200,
  label,
  className,
}: {
  legs: SketchLeg[];
  points: SketchPoint[];
  width?: number;
  height?: number;
  /** Accessible name (translated by the caller); without it the sketch is hidden from assistive tech. */
  label?: string;
  className?: string;
}) {
  const g = sketchGeometry(legs, points, width, height);
  if (!g) return null;
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true };
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className ?? "h-auto w-full max-w-sm rounded-lg border border-line bg-sunken"}
      data-route-sketch
      {...a11y}
    >
      {g.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke="currentColor"
          className="text-accent-text"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={p.dashed ? "6 5" : undefined}
        />
      ))}
      {g.dots.map((d, i) => (
        <g key={i}>
          <circle cx={d.x} cy={d.y} r={8} className="fill-header" />
          {d.n !== undefined && (
            <text x={d.x} y={d.y} dy="0.35em" textAnchor="middle" fontSize={9} fontWeight={700} className="fill-header-fg">
              {d.n}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
