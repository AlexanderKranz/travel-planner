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
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";

/** Small uppercase category label ("GOLF", "ANREISE"); sport is the green accent of the mockup. */
const kindCls = (kind: string) =>
  `mr-2 align-baseline text-[0.6875rem] font-semibold uppercase tracking-[0.12em] ${kind === "sport" ? "text-sport" : "text-subtle"}`;

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
        <span className={`${pill} border-line-strong tabular-nums`}>{label}</span>
      )}
      {stop.fixed && (
        <span
          className={`${pill} border-info-line bg-info-bg text-info-fg`}
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
        {time && <span className="mr-2 font-semibold tabular-nums text-heading">{time}</span>}
        <span className={kindCls(act.kind)}>{t(`kinds.${act.kind}`)}</span>
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
    <li className="min-w-0 break-words rounded-lg border border-l-4 border-ok-line bg-ok-bg/60 py-1.5 pl-3 pr-2" data-fixed-item={item.id}>
      <span className="mr-2 font-semibold tabular-nums text-heading">{timeRange(item.from, item.to)}</span>
      <span className={kindCls("fixed")}>{ti(`categories.${item.category}`)}</span>
      <span className="mr-1.5 font-medium">{item.title}</span>
      <span className="sr-only">({t("fixedItem")})</span>
      <StatusBadge status={item.status} />
    </li>
  );
}

/** Left column: "TAG / n / Sa 13.03." (dated) or "TAG / n" (undated), serif number in the accent colour. */
function DateColumn({ day }: { day: PlanDay }) {
  const t = useTranslations("plan");
  const f = useFormatter();
  const d = day.date ? new Date(`${day.date}T12:00:00Z`) : null;
  return (
    <div className="flex w-12 shrink-0 flex-col items-center self-start text-center sm:w-16" aria-hidden="true">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-subtle">{t("dayShort")}</span>
      <span className="font-serif text-4xl font-bold leading-none text-accent-text sm:text-5xl">{day.n}</span>
      {d && (
        <span className="mt-1 text-xs text-subtle">
          {f.dateTime(d, { weekday: "short", timeZone: "UTC" })} {f.dateTime(d, { day: "2-digit", month: "2-digit", timeZone: "UTC" })}
        </span>
      )}
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
  const border = day.best ? "border-feature" : changed ? "border-info-line" : "border-line";
  return (
    <li id={`day-${day.n}`} className="scroll-mt-4">
      <article
        aria-labelledby={`day-${day.n}-title`}
        data-print-block
        className={`flex min-w-0 gap-3 rounded-[14px] border p-4 sm:gap-6 sm:p-6 ${day.best ? "on-feature bg-feature text-ink" : "bg-card"} ${border}`}
      >
        <DateColumn day={day} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <h3 id={`day-${day.n}-title`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-bold leading-snug sm:text-2xl">
            <span className="sr-only">{t("day", { n: day.n })}: </span>
            <span className="min-w-0 break-words">{day.title}</span>
            {day.best && (
              <span
                className="inline-flex items-center rounded-full bg-feature-accent px-3 py-1 font-sans text-xs font-bold uppercase tracking-[0.08em] text-[#1c2430]"
              >
                {t("bestDay")}
              </span>
            )}
            {changed && (
              <span
                className={`${pill} border-info-line bg-info-bg text-info-fg`}
              >
                {t("changed")}
              </span>
            )}
          </h3>
          {mergeDayRows(day, fixed).map(({ stop, rows }, i) => {
            const showHead = day.stops.length > 1 || stop.place !== day.title || windowKind(stop.from, stop.to) || stop.fixed;
            return (
              <div key={i} className="flex min-w-0 flex-col gap-1.5">
                {showHead && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-heading">
                    <span className="min-w-0 break-words">{stop.place}</span>
                    <WindowBadge stop={stop} />
                  </p>
                )}
                {rows.length > 0 && (
                  <ul className="flex flex-col gap-2 text-[0.9375rem] leading-relaxed">
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
            <p className="rounded-[10px] bg-sunken px-4 py-3 text-[0.9375rem] leading-relaxed">
              <span className="sr-only">{t("noteLabel")}: </span>
              {day.note}
            </p>
          )}
          {day.warn && (
            <p className="rounded-[10px] bg-warn-bg px-4 py-3 text-[0.9375rem] leading-relaxed text-warn-fg">
              <strong className="font-semibold">{t("warnLabel")}: </strong>
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
