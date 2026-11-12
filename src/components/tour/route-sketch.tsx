import { sketchGeometry } from "@/lib/tour/sketch";

/**
 * Route sketch without a base map (city-tour 8): the stored leg polylines (dashed for a per-leg mode) and numbered
 * stops. Presentational and decorative: the stop list next to it carries the content for screen readers.
 */
export function RouteSketch({
  legs,
  points,
  width = 320,
  height = 200,
}: {
  legs: { poly: string | null; dashed?: boolean }[];
  points: { lat: number; lon: number; n?: number }[];
  width?: number;
  height?: number;
}) {
  const g = sketchGeometry(legs, points, width, height);
  if (!g) return null;
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-auto w-full max-w-sm rounded-lg border border-line bg-sunken"
      aria-hidden="true"
      data-route-sketch
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
