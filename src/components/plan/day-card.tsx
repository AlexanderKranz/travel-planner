import { useFormatter, useTranslations } from "next-intl";
import { linkCls, mutedCls } from "@/components/ui/styles";
import type { Plan, PlanActivity, PlanDay, PlanStop } from "@/lib/domain/plan";
import { placeHref } from "@/lib/facts/sources";
import { StatusBadge } from "@/components/items/status-badge";
import { mergeDayRows, timeRange, type FixedItem } from "@/lib/plan/fixed-items";
import { DRIVE_ONLY, windowKind } from "./helpers";

/** Owner-only slot: "+ item" next to a referenced place (bound to its day by DayCard). */
type QuickAdd = (place: Plan["places"][string], ref: string) => React.ReactNode;

const pill =
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap";

function WindowBadge({ stop }: { stop: PlanStop }) {
  const t = useTranslations("plan");
  const kind = windowKind(stop.from, stop.to);
  if (!kind && !stop.fixed) return null;
  const label =
    kind === "both"
      ? t("windowBoth", { from: stop.from!, to: stop.to! })
      : kind === "from"
        ? t("windowFrom", { time: stop.from! })
        : kind === "to"
          ? t("windowUntil", { time: stop.to! })
          : null;
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {label && (
        <span className={`${pill} border-neutral-400 tabular-nums dark:border-neutral-500`}>{label}</span>
      )}
      {stop.fixed && (
        <span
          className={`${pill} border-blue-700 bg-blue-50 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100`}
        >
          {t("fromNotes")}
        </span>
      )}
    </span>
  );
}

function PlaceLink({ place, strong }: { place: Plan["places"][string]; strong?: boolean }) {
  const t = useTranslations("plan");
  const href = placeHref(place);
  const cls = strong ? "font-medium" : "";
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${linkCls} ${cls}`}>
      {place.name}
      <span className="sr-only"> ({t("opensExternal")})</span>
    </a>
  ) : (
    <span className={cls}>{place.name}</span>
  );
}

function DriveBadge({ place }: { place: Plan["places"][string] }) {
  const t = useTranslations("plan");
  const f = useFormatter();
  if (!place.drive) return null;
  const title = t("driveTitle", {
    km: f.number(place.drive.km, { maximumFractionDigits: 1 }),
    date: f.dateTime(new Date(place.drive.fetchedAt), { dateStyle: "medium" }),
  });
  return (
    <span className={`${DRIVE_ONLY} whitespace-nowrap text-xs tabular-nums ${mutedCls}`} title={title}>
      {t("drive", { min: place.drive.min })}
      <span className="sr-only"> ({title})</span>
    </span>
  );
}

function Activity({
  act,
  places,
  quickAdd,
}: {
  act: PlanActivity;
  places: Plan["places"];
  quickAdd?: QuickAdd;
}) {
  const t = useTranslations("plan");
  const f = useFormatter();
  const place = act.ref ? places[act.ref] : undefined;
  const alts = place ? (act.alts ?? []).flatMap((k) => (places[k] ? [places[k]] : [])) : [];
  const time = act.at ? (act.until ? `${act.at}–${act.until}` : act.at) : null;
  const add = quickAdd && place && act.ref ? quickAdd(place, act.ref) : null;
  // The quick add sits in a reserved right column, so the text never wraps around it (spec timed-items [D14]).
  return (
    <li className={add ? "group/act grid min-w-0 grid-cols-[minmax(0,1fr)_2.75rem] items-start gap-x-1" : "min-w-0"}>
      <div className="min-w-0 break-words">
        {time && <span className="mr-1.5 font-medium tabular-nums">{time}</span>}
        <span
          className={`mr-1.5 rounded bg-neutral-100 px-1.5 py-px align-middle text-[0.7rem] font-medium uppercase tracking-wide dark:bg-neutral-800 ${mutedCls}`}
        >
          {t(`kinds.${act.kind}`)}
        </span>
        {place && (
          <>
            <PlaceLink place={place} strong />
            {" · "}
          </>
        )}
        {act.text}
        {place &&
          (place.drive ? (
            <>
              {" "}
              <DriveBadge place={place} />
            </>
          ) : (
            <span className={`ml-1 text-xs ${mutedCls}`}>({t("distance", { km: f.number(place.distanceKm, { maximumFractionDigits: 1 }) })})</span>
          ))}
        {alts.length > 0 && (
          <span className={`block text-xs ${mutedCls}`}>
            {t("alternatives")}{" "}
            {alts.map((p, i) => (
              <span key={i}>
                {i > 0 && " · "}
                <PlaceLink place={p} />
                {p.drive && (
                  <>
                    {" "}
                    <DriveBadge place={p} />
                  </>
                )}
              </span>
            ))}
          </span>
        )}
      </div>
      {add && <div className="-my-2.5 flex justify-end">{add}</div>}
    </li>
  );
}

/** A booked/planned item at its time (rendered from trip items, not from the plan JSON). */
function FixedRow({ item }: { item: FixedItem }) {
  const t = useTranslations("plan");
  const ti = useTranslations("items");
  return (
    <li className="min-w-0 break-words rounded-md border-l-4 border-green-700 bg-green-50/60 py-1 pl-2 pr-1 dark:border-green-400 dark:bg-green-950/40" data-fixed-item={item.id}>
      <span className="mr-1.5 font-medium tabular-nums">{timeRange(item.from, item.to)}</span>
      <span
        className={`mr-1.5 rounded bg-neutral-100 px-1.5 py-px align-middle text-[0.7rem] font-medium uppercase tracking-wide dark:bg-neutral-800 ${mutedCls}`}
      >
        {ti(`categories.${item.category}`)}
      </span>
      <span className="mr-1.5 font-medium">{item.title}</span>
      <span className="sr-only">({t("fixedItem")})</span>
      <StatusBadge status={item.status} />
    </li>
  );
}

/** Left column: weekday + dd.MM. for dated trips, "Day n" otherwise. */
function DateColumn({ day }: { day: PlanDay }) {
  const t = useTranslations("plan");
  const f = useFormatter();
  const box =
    "flex w-14 shrink-0 flex-col items-center justify-center self-start rounded-md bg-neutral-100 px-1 py-2 text-center dark:bg-neutral-800";
  if (!day.date) {
    return (
      <div className={box} aria-hidden="true">
        <span className={`text-xs uppercase ${mutedCls}`}>{t("dayShort")}</span>
        <span className="text-xl font-bold leading-none">{day.n}</span>
      </div>
    );
  }
  const d = new Date(`${day.date}T12:00:00Z`);
  return (
    <div className={box} aria-hidden="true">
      <span className={`text-xs uppercase ${mutedCls}`}>{f.dateTime(d, { weekday: "short", timeZone: "UTC" })}</span>
      <span className="text-sm font-bold leading-tight">
        {f.dateTime(d, { day: "2-digit", month: "2-digit", timeZone: "UTC" })}
      </span>
    </div>
  );
}

export function DayCard({
  day,
  places,
  changed,
  fixed = [],
  renderQuickAdd,
}: {
  day: PlanDay;
  places: Plan["places"];
  changed?: boolean;
  /** Booked/planned trip items with day + start time; merged into this day's rows in time order. */
  fixed?: FixedItem[];
  renderQuickAdd?: (place: Plan["places"][string], ref: string, day: number) => React.ReactNode;
}) {
  const t = useTranslations("plan");
  const f = useFormatter();
  const used = day.stops
    .flatMap((s) => s.acts)
    .flatMap((a) => (a.ref ? [a.ref, ...(a.alts ?? [])] : []))
    .flatMap((k) => (places[k] ? [places[k]] : []));
  const fetchedAt = used.map((p) => p.fetchedAt).sort()[0];
  const hasDrive = used.some((p) => p.drive);
  const border = day.best
    ? "border-amber-500 dark:border-amber-400"
    : changed
      ? "border-blue-600 dark:border-blue-400"
      : "border-neutral-300 dark:border-neutral-700";
  return (
    <li id={`day-${day.n}`} className="scroll-mt-4">
      <article
        aria-labelledby={`day-${day.n}-title`}
        className={`flex min-w-0 gap-3 rounded-lg border p-3 sm:gap-4 sm:p-4 ${day.best ? "border-2" : ""} ${border}`}
      >
        <DateColumn day={day} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h3 id={`day-${day.n}-title`} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base font-semibold">
            <span className="sr-only">{t("day", { n: day.n })}: </span>
            <span className="min-w-0 break-words">{day.title}</span>
            {day.best && (
              <span
                className={`${pill} border-amber-700 bg-amber-100 text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100`}
              >
                {t("bestDay")}
              </span>
            )}
            {changed && (
              <span
                className={`${pill} border-blue-700 bg-blue-50 text-blue-950 dark:border-blue-400 dark:bg-blue-950 dark:text-blue-100`}
              >
                {t("changed")}
              </span>
            )}
          </h3>
          {mergeDayRows(day, fixed).map(({ stop, rows }, i) => {
            const showHead = day.stops.length > 1 || stop.place !== day.title || windowKind(stop.from, stop.to) || stop.fixed;
            return (
              <div key={i} className="flex min-w-0 flex-col gap-1">
                {showHead && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                    <span className="min-w-0 break-words">{stop.place}</span>
                    <WindowBadge stop={stop} />
                  </p>
                )}
                {rows.length > 0 && (
                  <ul className="flex flex-col gap-1 text-sm">
                    {rows.map((r, j) =>
                      r.kind === "fixed" ? (
                        <FixedRow key={`f-${r.item.id}`} item={r.item} />
                      ) : (
                        <Activity
                          key={j}
                          act={r.act}
                          places={places}
                          quickAdd={renderQuickAdd && ((p, ref) => renderQuickAdd(p, ref, day.n))}
                        />
                      ),
                    )}
                  </ul>
                )}
              </div>
            );
          })}
          {day.note && (
            <p className={`rounded-md bg-neutral-100 px-2.5 py-1.5 text-sm dark:bg-neutral-800`}>
              <span className="sr-only">{t("noteLabel")}: </span>
              {day.note}
            </p>
          )}
          {day.warn && (
            <p className="rounded-md border border-amber-600 bg-amber-50 px-2.5 py-1.5 text-sm text-amber-950 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-100">
              <span className="font-medium">{t("warnLabel")}: </span>
              {day.warn}
            </p>
          )}
          {fetchedAt && (
            <p className={`text-xs ${mutedCls}`}>
              <a
                href="https://www.openstreetmap.org/copyright"
                target="_blank"
                rel="noopener noreferrer"
                className={linkCls}
              >
                {t("osmCredit")}
              </a>{" "}
              · {t("checked", { date: f.dateTime(new Date(fetchedAt), { dateStyle: "medium" }) })}
              {hasDrive && (
                <span className={DRIVE_ONLY}>
                  {" · "}
                  <a href="https://openrouteservice.org/" target="_blank" rel="noopener noreferrer" className={linkCls}>
                    {t("driveCredit")}
                  </a>
                </span>
              )}
            </p>
          )}
        </div>
      </article>
    </li>
  );
}
