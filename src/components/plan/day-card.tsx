import { useFormatter, useTranslations } from "next-intl";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { isUserBest, type Plan, type PlanActivity, type PlanDay, type PlanStop } from "@/lib/domain/plan";
import { placeHref } from "@/lib/facts/sources";
import { StatusBadge } from "@/components/items/status-badge";
import { mergeDayRows, timeRange, type FixedItem } from "@/lib/plan/fixed-items";
import { DRIVE_ONLY, windowKind } from "./helpers";
import { AltEditButtons, BestDayButton, EditableActRow, type ActEditCtx } from "./act-edit";

/** Owner-only slot: "+ item" next to a referenced place (bound to its day by DayCard). */
type QuickAdd = (place: Plan["places"][string], ref: string) => React.ReactNode;

const pill =
  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap";

/** Small uppercase category label ("GOLF", "ANREISE"); sport is the green accent of the mockup. */
const kindCls = (kind: string) =>
  `text-[0.6875rem] font-semibold uppercase tracking-[0.12em] ${kind === "sport" ? "text-sport" : "text-subtle"}`;

/** Navy-tinted time badge (stop windows and activity times), spec patch-safety [D9]. */
const timePill = "inline-flex items-center whitespace-nowrap rounded-full bg-time-bg font-semibold tabular-nums text-time-fg";

/**
 * Time + category head and body of one row (activities and fixed items). Phones: line 1 = time pill + label,
 * line 2 = body at full width. From `sm`: one grid row with fixed time and label columns, so pills align.
 */
function RowLayout({ time, label, children }: { time: string | null; label: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="min-w-0 sm:grid sm:grid-cols-[6.5rem_6.5rem_minmax(0,1fr)] sm:items-baseline sm:gap-x-2">
      <div className="flex items-center gap-2 sm:contents">
        <span className={time ? "sm:pt-px" : "hidden sm:block"}>{time && <span className={`${timePill} px-2 py-px text-[0.8125rem]`}>{time}</span>}</span>
        {label}
      </div>
      <div className="mt-0.5 min-w-0 break-words sm:mt-0">{children}</div>
    </div>
  );
}

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
      {label && <span className={`${timePill} px-2.5 py-0.5 text-xs`}>{label}</span>}
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
  edit,
}: {
  act: PlanActivity;
  places: Plan["places"];
  quickAdd?: QuickAdd;
  /** Owner's latest version: remove/promote controls (patch-safety [D7]). */
  edit?: { ctx: ActEditCtx; at: { n: number; s: number; a: number } };
}) {
  const t = useTranslations("plan");
  const f = useFormatter();
  const place = act.ref ? places[act.ref] : undefined;
  const alts = place ? (act.alts ?? []).flatMap((k) => (places[k] ? [{ key: k, place: places[k] }] : [])) : [];
  const time = act.at ? (act.until ? `${act.at}–${act.until}` : act.at) : null;
  const add = quickAdd && place && act.ref ? quickAdd(place, act.ref) : null;
  const body = RowLayout({
    time,
    label: <span className={kindCls(act.kind)}>{t(`kinds.${act.kind}`)}</span>,
    children: (
      <>
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
            {alts.map(({ key, place: p }, i) => (
              <span key={key}>
                {i > 0 && " · "}
                <PlaceLink place={p} />
                {p.drive && (
                  <>
                    {" "}
                    <DriveBadge place={p} />
                  </>
                )}
                {edit && <AltEditButtons ctx={edit.ctx} at={edit.at} alt={key} name={p.name} />}
              </span>
            ))}
          </span>
        )}
      </>
    ),
  });
  if (edit) {
    return (
      <EditableActRow ctx={edit.ctx} at={edit.at} name={place?.name ?? act.text} add={add}>
        {body}
      </EditableActRow>
    );
  }
  // The quick add sits in a reserved right column, so the text never wraps around it (spec timed-items [D14]).
  return (
    <li className={add ? "group/act grid min-w-0 grid-cols-[minmax(0,1fr)_2.75rem] items-start gap-x-1" : "min-w-0"}>
      {body}
      {add && <div className="-my-2.5 flex justify-end">{add}</div>}
    </li>
  );
}

/** A booked/planned item at its time (rendered from trip items, not from the plan JSON). */
function FixedRow({ item }: { item: FixedItem }) {
  const t = useTranslations("plan");
  const ti = useTranslations("items");
  return (
    <li className="min-w-0 rounded-lg border border-l-4 border-ok-line bg-ok-bg/60 py-1.5 pl-3 pr-2" data-fixed-item={item.id}>
      <RowLayout time={timeRange(item.from, item.to)} label={<span className={kindCls("fixed")}>{ti(`categories.${item.category}`)}</span>}>
        <span className="mr-1.5 font-medium">{item.title}</span>
        <span className="sr-only">({t("fixedItem")})</span>
        <StatusBadge status={item.status} />
      </RowLayout>
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
  edit,
}: {
  day: PlanDay;
  places: Plan["places"];
  changed?: boolean;
  /** Booked/planned trip items with day + start time; merged into this day's rows in time order. */
  fixed?: FixedItem[];
  renderQuickAdd?: (place: Plan["places"][string], ref: string, day: number) => React.ReactNode;
  /** Owner's latest, idle version: activity edits without AI. */
  edit?: ActEditCtx;
}) {
  const t = useTranslations("plan");
  const f = useFormatter();
  const used = day.stops
    .flatMap((s) => s.acts)
    .flatMap((a) => (a.ref ? [a.ref, ...(a.alts ?? [])] : []))
    .flatMap((k) => (places[k] ? [places[k]] : []));
  const fetchedAt = used.map((p) => p.fetchedAt).sort()[0];
  const hasDrive = used.some((p) => p.drive);
  // Only a user-set best day is highlighted; an AI `best` in plans before plan-5 is ignored (patch-safety [D8]).
  const best = isUserBest(day);
  const border = best ? "border-feature" : changed ? "border-info-line" : "border-line";
  return (
    <li id={`day-${day.n}`} className="scroll-mt-4">
      <article
        aria-labelledby={`day-${day.n}-title`}
        data-print-block
        className={`group/day flex min-w-0 gap-3 rounded-[14px] border p-4 sm:gap-6 sm:p-6 ${best ? "on-feature bg-feature text-ink" : "bg-card"} ${border}`}
      >
        <DateColumn day={day} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex min-w-0 items-start gap-1">
          <h3 id={`day-${day.n}-title`} className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 text-xl font-bold leading-snug sm:text-2xl">
            <span className="sr-only">{t("day", { n: day.n })}: </span>
            <span className="min-w-0 break-words">{day.title}</span>
            {best && (
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
          {edit && <BestDayButton ctx={edit} n={day.n} isBest={best} />}
          </div>
          {mergeDayRows(day, fixed).map(({ stop, rows }, i) => {
            const showHead = day.stops.length > 1 || stop.place !== day.title || windowKind(stop.from, stop.to) || stop.fixed;
            return (
              <div key={i} className="flex min-w-0 flex-col gap-1.5">
                {showHead && (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-heading">
                    <span className="min-w-0 break-words">{stop.place}</span>
                    {windowKind(stop.from, stop.to) && <span aria-hidden="true" className="text-subtle">·</span>}
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
                          edit={edit && { ctx: edit, at: { n: day.n, s: i, a: stop.acts.indexOf(r.act) } }}
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
