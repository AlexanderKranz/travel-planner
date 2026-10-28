import { useFormatter, useTranslations } from "next-intl";
import type { PlaceCandidate, PlaceGroup, PlacesFacts } from "@/lib/domain";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { StaleBadge } from "./source-note";
import { safeUrl, wikipediaUrl } from "@/lib/facts/sources";

export { wikipediaUrl };

/** Message key suffix for an OSM tag: "leisure=golf_course" -> "leisure_golf_course". */
export function categoryKey(category: string): string {
  return category.replace(/[^A-Za-z0-9_=]/g, "_").replace("=", "_");
}

const linkSm = `${linkCls} inline-flex min-h-11 items-center`;

function PlaceItem({ place, locale }: { place: PlaceCandidate; locale: string }) {
  const t = useTranslations("facts.places");
  const tc = useTranslations("facts.category");
  const f = useFormatter();
  const key = categoryKey(place.category);
  const category = tc.has(key) ? tc(key) : place.category.split("=").pop()!.replace(/_/g, " ");
  const name = place.names[locale as "de" | "en"] ?? place.name;
  const wiki = place.wikipedia ? wikipediaUrl(place.wikipedia) : null;
  const site = safeUrl(place.website);
  const osm = safeUrl(place.osmUrl);
  const km = f.number(place.distanceKm, { maximumFractionDigits: 1 });
  const links: [string, string][] = [];
  if (osm) links.push([t("linkOsm"), osm]);
  if (wiki) links.push([t("linkWikipedia"), wiki]);
  if (site) links.push([t("linkWebsite"), site]);
  return (
    <li className="flex min-w-0 flex-col rounded-md border border-line px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 break-words font-medium">{name}</span>
        <span
          className="shrink-0 rounded-full bg-info-bg px-2 py-0.5 text-xs font-medium tabular-nums text-info-fg"
          title={t("distance", { km })}
        >
          <span aria-hidden="true">{km} km</span>
          <span className="sr-only">{t("distance", { km })}</span>
        </span>
      </div>
      <div className={`flex flex-wrap items-center gap-x-2 text-xs ${mutedCls}`}>
        <span>{category}</span>
        {links.map(([label, href]) => (
          <span key={label} className="inline-flex items-center gap-2">
            <span aria-hidden="true">·</span>
            <a href={href} target="_blank" rel="noopener noreferrer" className={linkSm}>
              {label}
            </a>
          </span>
        ))}
      </div>
    </li>
  );
}

const VISIBLE = 9;
const gridCls = "grid gap-2 sm:grid-cols-2 xl:grid-cols-3";

function Group({ group, locale, radiusKm }: { group: PlaceGroup; locale: string; radiusKm: number }) {
  const t = useTranslations("facts.places");
  const ti = useTranslations("interests");
  const title = group.interest === "general" ? t("general") : ti(group.interest);
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-semibold">
        {title}
        {group.status === "ok" && (
          <span className={`text-sm font-normal ${mutedCls}`}>
            · {t("groupMeta", { count: group.candidates.length, radius: radiusKm })}
          </span>
        )}
        {(group.status === "ok" || group.status === "empty") && group.stale && <StaleBadge />}
      </h3>
      {group.status === "ok" && (
        <>
          <ul className={gridCls}>
            {group.candidates.slice(0, VISIBLE).map((p) => (
              <PlaceItem key={`${p.osmType}${p.osmId}`} place={p} locale={locale} />
            ))}
          </ul>
          {group.candidates.length > VISIBLE && (
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus">
                {t("showMore", { count: group.candidates.length - VISIBLE })}
              </summary>
              <ul className={`${gridCls} mt-1`}>
                {group.candidates.slice(VISIBLE).map((p) => (
                  <PlaceItem key={`${p.osmType}${p.osmId}`} place={p} locale={locale} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {group.status === "empty" && <p className={`text-sm ${mutedCls}`}>{t("empty")}</p>}
      {group.status === "no_source" && <p className={`text-sm ${mutedCls}`}>{t("noSource")}</p>}
      {group.status === "error" && <p className={`text-sm ${mutedCls}`}>{t("notLoaded")}</p>}
    </section>
  );
}

export function PlacesList({ data, locale }: { data: PlacesFacts; locale: string }) {
  const t = useTranslations("facts.places");
  return (
    <div className="flex flex-col gap-5">
      <p className={`text-xs ${mutedCls}`}>{t("intro", { radius: data.radiusKm })}</p>
      {data.groups.map((g) => (
        <Group key={g.interest} group={g} locale={locale} radiusKm={data.radiusKm} />
      ))}
      {data.groups.some((g) => g.status === "error") && (
        <p role="status" className={`text-sm ${mutedCls}`}>
          {t("morePending")}
        </p>
      )}
      {data.customInterests.length > 0 && (
        <p className={`text-sm ${mutedCls}`}>
          {t("custom", { list: data.customInterests.join(", ") })}
        </p>
      )}
    </div>
  );
}
