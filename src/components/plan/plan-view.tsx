import { StopInfoProvider } from "@/components/tour/stop-info/context";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { linkCls } from "@/components/ui/styles";
import type { PlanState } from "@/lib/domain/plan";
import { DayCard } from "./day-card";
import { highlightedDays, QUICK_ADD_HOVER } from "./helpers";
import { DriveTimesScope } from "./drive-times-scope";
import { AddItemButton } from "@/components/items/add-item-button";
import { placePrefill } from "@/components/items/helpers";
import { statusTone } from "@/components/items/status-badge";
import type { SharedItem } from "@/lib/domain/items";
import { fittingLegs } from "@/lib/flights/ui";
import { fixedItemsOf, flightPrefill, flightTitle, itemForLeg } from "@/lib/plan/fixed-items";
import type { TourBlock } from "@/lib/plan/tour-blocks";
import { PlanFlights } from "./plan-flights";
import { PlanHeader } from "./plan-header";
import { PlanNotes, PlanOpenItems, PlanPacking } from "./plan-lists";
import { OpenItemsEditor } from "./open-items-editor";
import { PlanRunner } from "./plan-runner";

type Shown = NonNullable<PlanState["version"]>;

/** Read-only rendering of one plan version: header, banners, day cards, notes, facts digest. */
export function PlanView({
  state,
  shown,
  locale,
  openDone,
  items,
  tours = [],
  readOnly = false,
}: {
  state: PlanState;
  shown: Shown;
  locale: string;
  openDone: string[];
  /**
   * Trip items and the context for the code-only "+ item" quick add (latest version only). `list` feeds the fixed
   * rows of the day cards; `changed` = a timed item changed after this version.
   */
  items: { lengthDays: number; partySize: number | null; startDate: string | null; list: SharedItem[]; changed: boolean };
  /** City tours on days of the trip (city-tour 10), merged into their day cards at render time. */
  tours?: TourBlock[];
  /** Read grantee (sharing spec 4.3): no quick add, no edits, no open-item ticks, no regenerate. */
  readOnly?: boolean;
}) {
  const t = useTranslations("plan");
  const ti = useTranslations("items");
  const { plan, meta } = shown;
  const changed = new Set(highlightedDays(meta));
  const legs = plan.flights ? fittingLegs(plan.flights.legs) : [];
  const ctx = { tripId: state.tripId, lengthDays: items.lengthDays, partySize: items.partySize, startDate: items.startDate, flights: legs };
  const quick = state.isLatest && !readOnly;
  const fixed = fixedItemsOf(items.list, plan.days.length);
  // Activity edits without AI: owner's latest version only, not while a generation or patch runs.
  const editCtx = state.isLatest && !state.busy && !readOnly ? { tripId: state.tripId, baseVersion: meta.versionNo } : undefined;
  const flightAction = (leg: (typeof legs)[number]) => {
    const held = itemForLeg(leg, items.list, items.lengthDays, items.startDate);
    if (held) {
      return (
        <span className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${statusTone[held.status]}`}>
          <span aria-hidden="true">✓&nbsp;</span>
          {ti(`statuses.${held.status}`)}
          <span className="sr-only"> ({flightTitle(leg)})</span>
        </span>
      );
    }
    return quick ? (
      <AddItemButton ctx={ctx} prefill={flightPrefill(leg, items.lengthDays, items.startDate)} quickLabel={flightTitle(leg)} />
    ) : null;
  };
  const hasDrive = Object.values(plan.places).some((p) => p.drive);
  return (
    <StopInfoProvider source={{ kind: "session" }}>
    <DriveTimesScope hasDrive={hasDrive} className="flex min-w-0 flex-col gap-4" header={<PlanHeader plan={plan} uiLocale={locale} />}>
      {!state.isLatest && (
        <p role="note" className="rounded-lg border border-info-line bg-info-bg p-3 text-sm text-info-fg">
          {t("viewingOld", { n: meta.versionNo })}{" "}
          <Link href={`/app/trips/${state.tripId}`} scroll={false} className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("backToLatest")}
          </Link>
        </p>
      )}
      {state.outdated && state.isLatest && (
        <div role="note" className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg">
          <p>
            <span className="font-medium">{t("outdated.title")}</span> {t("outdated.body")}
          </p>
          {!readOnly && <PlanRunner tripId={state.tripId} locale={locale} label={t("outdated.regenerate")} secondary disabled={!state.aiEnabled} />}
        </div>
      )}
      {state.placesIncomplete && state.isLatest && !state.outdated && (
        <div role="note" className="flex flex-col gap-2 rounded-lg border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg">
          <p>{t("placesIncomplete")}</p>
          {!readOnly && <PlanRunner tripId={state.tripId} locale={locale} label={t("outdated.regenerate")} secondary disabled={!state.aiEnabled} />}
        </div>
      )}
      {items.changed && state.isLatest && !state.outdated && (
        <p role="note" className="rounded-md border border-line-strong px-3 py-2 text-sm">
          {t("itemsChanged")}
        </p>
      )}
      {state.busy && <PlanRunner tripId={state.tripId} locale={locale} watchOnly />}
      <ol className="flex flex-col gap-3" aria-label={t("daysLabel")}>
        {plan.days.map((d) => (
          <DayCard
            dayCount={plan.days.length}
            key={d.n}
            day={d}
            places={plan.places}
            changed={changed.has(d.n)}
            fixed={fixed}
            tours={tours}
            tourAccess={state.access ?? "owner"}
            // The day action is the trip owner's only (city-tour 2.2 [T15]); a grantee cannot link a tour to this trip.
            tourAction={(state.access ?? "owner") === "owner" && !readOnly ? { tripId: state.tripId } : undefined}
            edit={editCtx}
            renderQuickAdd={
              quick
                ? (place, ref, n) => <AddItemButton ctx={ctx} prefill={placePrefill(place, ref, n)} quickLabel={place.name} icon className={QUICK_ADD_HOVER} />
                : undefined
            }
          />
        ))}
      </ol>
      <PlanNotes notes={plan.notes} />
      {state.isLatest && !readOnly ? (
        <OpenItemsEditor tripId={state.tripId} items={plan.openItems} done={openDone} edit={editCtx} />
      ) : (
        <PlanOpenItems items={plan.openItems} done={openDone} />
      )}
      <PlanPacking items={plan.packing} />
      {plan.flights && (
        <PlanFlights flights={plan.flights} renderAction={flightAction} />
      )}
    </DriveTimesScope>
    </StopInfoProvider>
  );
}
