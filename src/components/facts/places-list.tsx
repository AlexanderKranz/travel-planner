import { useFormatter, useTranslations } from "next-intl";
import type { PlaceCandidate, PlaceGroup, PlacesFacts } from "@/lib/domain";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { StaleBadge } from "./source-note";
import { safeUrl } from "./source-meta";

/** "de:Passauer Dom" -> https://de.wikipedia.org/wiki/Passauer_Dom (null if malformed). */
export function wikipediaUrl(tag: string): string | null {
  const m = /^([a-z]{2,3}(?:-[a-z]+)?):(.+)$/.exec(tag);
  if (!m) return null;
  return `https://${m[1]}.wikipedia.org/wiki/${encodeURIComponent(m[2].replace(/ /g, "_"))}`;
}

/** Message key suffix for an OSM tag: "leisure=golf_course" -> "leisure_golf_course". */
export function categoryKey(category: string): string {
  return category.replace(/[^A-Za-z0-9_=]/g, "_").replace("=", "_");
}

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
  return (
    <li className="flex flex-col gap-1 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="min-w-0 break-words font-medium">{name}</span>
        <span className={`text-xs ${mutedCls}`}>
          {t("distance", { km: f.number(place.distanceKm, { maximumFractionDigits: 1 }) })}
        </span>
      </div>
      <span className={`text-xs ${mutedCls}`}>{category}</span>
      <span className="flex flex-wrap gap-x-4 text-sm">
        {osm && (
          <a href={osm} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("linkOsm")}
          </a>
        )}
        {wiki && (
          <a href={wiki} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("linkWikipedia")}
          </a>
        )}
        {site && (
          <a href={site} target="_blank" rel="noopener noreferrer" className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("linkWebsite")}
          </a>
        )}
      </span>
    </li>
  );
}

const VISIBLE = 8;

function Group({ group, locale }: { group: PlaceGroup; locale: string }) {
  const t = useTranslations("facts.places");
  const ti = useTranslations("interests");
  const title = group.interest === "general" ? t("general") : ti(group.interest);
  const divide = "divide-y divide-neutral-200 dark:divide-neutral-800";
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="flex flex-wrap items-center gap-2 font-semibold">
        {title}
        {(group.status === "ok" || group.status === "empty") && group.stale && <StaleBadge />}
      </h3>
      {group.status === "ok" && (
        <>
          <ul className={divide}>
            {group.candidates.slice(0, VISIBLE).map((p) => (
              <PlaceItem key={`${p.osmType}${p.osmId}`} place={p} locale={locale} />
            ))}
          </ul>
          {group.candidates.length > VISIBLE && (
            <details>
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-blue-600">
                {t("showMore", { count: group.candidates.length - VISIBLE })}
              </summary>
              <ul className={divide}>
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
      {group.status === "error" && <p className="text-sm">{t("error")}</p>}
    </section>
  );
}

export function PlacesList({ data, locale }: { data: PlacesFacts; locale: string }) {
  const t = useTranslations("facts.places");
  return (
    <div className="flex flex-col gap-5">
      <p className={`text-sm ${mutedCls}`}>{t("intro", { radius: data.radiusKm })}</p>
      {data.groups.map((g) => (
        <Group key={g.interest} group={g} locale={locale} />
      ))}
      {data.customInterests.length > 0 && (
        <p className={`text-sm ${mutedCls}`}>
          {t("custom", { list: data.customInterests.join(", ") })}
        </p>
      )}
    </div>
  );
}
