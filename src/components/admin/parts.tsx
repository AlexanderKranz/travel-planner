import type { ReactNode } from "react";
import { cardCls, labelCls, mutedCls } from "@/components/ui/styles";
import type { Level } from "@/lib/server/admin/shape";

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className={`${cardCls} flex flex-col gap-4`}>
      <h2 id={id} className="font-serif text-xl font-bold text-heading">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Responsive grid of label + number tiles (2 columns at 360 px). */
export function Stats({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{children}</dl>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-lg border border-line bg-sunken p-3">
      <dt className={labelCls}>{label}</dt>
      <dd className="mt-1 font-serif text-2xl font-bold text-ink">{value}</dd>
      {hint ? <dd className={`${mutedCls} mt-1 text-xs`}>{hint}</dd> : null}
    </div>
  );
}

const FILL: Record<Level, string> = { ok: "bg-accent", warn: "bg-warn-line", over: "bg-danger-solid" };

/**
 * Horizontal bar with a label and a value text. The text carries the information (colour is only a hint),
 * and the bar is a progressbar for assistive tech when `aria` is given.
 */
export function Bar({ label, valueText, widthPct, level = "ok", aria }: { label: string; valueText: string; widthPct: number; level?: Level; aria?: string }) {
  const w = Math.max(0, Math.min(100, widthPct));
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="text-ink">{label}</span>
        <span className="tabular-nums text-muted">{valueText}</span>
      </div>
      <div
        className="mt-1 h-2.5 overflow-hidden rounded-full bg-sunken"
        role={aria ? "progressbar" : undefined}
        aria-label={aria}
        aria-valuemin={aria ? 0 : undefined}
        aria-valuemax={aria ? 100 : undefined}
        aria-valuenow={aria ? w : undefined}
      >
        <div className={`h-full rounded-full ${FILL[level]}`} style={{ width: `${w}%` }} />
      </div>
    </div>
  );
}

export function LevelText({ level, text }: { level: Level; text: string }) {
  const cls = level === "over" ? "text-danger" : level === "warn" ? "text-warn-fg" : "text-muted";
  return <span className={`text-xs font-medium ${cls}`}>{text}</span>;
}
