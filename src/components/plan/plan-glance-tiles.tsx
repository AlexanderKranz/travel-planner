import { useFormatter, useTranslations } from "next-intl";
import { Tile } from "@/components/facts/glance-tile";
import { mutedCls } from "@/components/ui/styles";
import type { PlanDocument } from "@/lib/domain/share";
import { planGlanceChecked, planGlanceTiles, type GlanceChip } from "@/lib/facts/plan-glance";

const ICON: Record<GlanceChip["key"], string> = { currency: "💱", callingCode: "📞", driving: "🚗", timezone: "🕒" };

const chipCls =
  "inline-flex max-w-full items-center gap-1 break-all rounded-full border border-line bg-page px-2.5 py-1 text-xs text-ink";

/** "At a glance" tiles of the share page: the trip page's tiles, built from the plan document. */
export function PlanGlanceTiles({ doc, locale }: { doc: PlanDocument; locale: string }) {
  const t = useTranslations("pdf.glance");
  const f = useFormatter();
  const tiles = planGlanceTiles(doc, locale, (k, v) => t(k as "title", v));
  if (tiles.length === 0) return null;
  const checked = planGlanceChecked(doc.plan);
  return (
    <section aria-labelledby="plan-glance" className="flex min-w-0 flex-col gap-3">
      <h2 id="plan-glance" className="sr-only">
        {t("title")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-2">
        {tiles.map((tile) => (
          <Tile
            key={tile.key}
            label={tile.label}
            value={
              <>
                {tile.flag && <span aria-hidden="true">{tile.flag} </span>}
                {tile.value}
              </>
            }
          >
            {tile.lines.map((l) => (
              <p key={l} className="text-sm text-muted">
                {l}
              </p>
            ))}
            {tile.chips.length > 0 && (
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {tile.chips.map((c) => (
                  <li key={c.id} className={chipCls}>
                    <span aria-hidden="true">{ICON[c.key]}</span>
                    <span className="sr-only">{t(c.key)}: </span>
                    {c.text}
                  </li>
                ))}
              </ul>
            )}
          </Tile>
        ))}
      </div>
      <p className={`text-xs ${mutedCls}`}>
        {t("sources")}
        {checked && <> · {t("checked", { date: f.dateTime(new Date(checked), { dateStyle: "medium" }) })}</>}
      </p>
    </section>
  );
}
