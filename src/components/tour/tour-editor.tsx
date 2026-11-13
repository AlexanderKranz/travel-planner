"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ClientForm } from "@/components/ui/client-form";
import { btnPrimary, btnSecondary, cardCls, mutedCls } from "@/components/ui/styles";
import { Link, useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { MAX_TOUR_PLACES, type Tour, type TourResult, type TourSight, type TourSuggestion } from "@/lib/domain/tour";
import { computeTour, type ComputeTourResult } from "@/lib/server/tour/compute";
import { createTour, deleteTour, updateTour } from "@/lib/server/tours";
import type { TourPrefill } from "@/lib/server/tour/prefill";
import type { TourView } from "@/lib/tour/view";
import {
  applyLegSheet,
  applyProposal,
  canAddPlace,
  type FormProblem,
  draftSignature,
  emptyForm,
  formFromInput,
  formProblem,
  isOutdated,
  isTaken,
  resultFitsInput,
  issueKeys,
  openLegSheet,
  toDraft,
  type FormPoint,
  type LegSheet as SheetState,
  type Proposal,
  type TourForm,
} from "@/lib/tour/ui";
import { CityField } from "./city-field";
import { CitySuggestions } from "./city-suggestions";
import { tourTitle } from "./format";
import { LegSheet } from "./leg-sheet";
import { PastePlaces } from "./paste-places";
import { PlaceList } from "./place-list";
import { PlaceSearch } from "./place-search";
import { TourError } from "./tour-error";
import { TourOptions } from "./tour-options";
import { TourResultView } from "./tour-result";
import { TourTripLink, type TripOption } from "./tour-trip-link";

type Props = {
  /** The stored tour (owner); null on /app/tours/new. */
  tour: Tour | null;
  view: TourView | null;
  prefill: TourPrefill | null;
  mapStyleUrl: string | null;
  trips: TripOption[];
};

/** What the last computation returned beside the snapshot (not stored, spec 11 implementation notes). */
type Extras = {
  stopTimes: { arrive: string; leave: string }[] | null;
  byMin: number | null;
  proposals: Proposal[];
  droppedOverrides: number;
  sightsPending: boolean;
};

const suggestionToPoint = (s: TourSuggestion): FormPoint => ({
  key: s.key,
  ref: s.ref,
  name: s.name,
  lat: s.lat,
  lon: s.lon,
  source: s.source,
  ...(s.cat ? { cat: s.cat } : {}),
});

function initialForm(tour: Tour | null, prefill: TourPrefill | null): TourForm {
  if (tour) return formFromInput(tour.input, tour.title);
  const f = emptyForm();
  if (!prefill) return f;
  return {
    ...f,
    city: prefill.city ? { ...prefill.city, source: "geonames" } : null,
    places: prefill.places.map(suggestionToPoint),
    date: prefill.date ?? "",
    mode: "foot",
  };
}

/**
 * The tour page for the owner (spec 2.1): one form top to bottom, "Tour planen" saves and computes on the server, the
 * result shows below. Edits only mark the result outdated; nothing is recomputed per keystroke. Every save sends the
 * `updatedAt` it last saw (conditional update), so a concurrent change gives `conflict` instead of being overwritten.
 */
export function TourEditor({ tour, view, prefill, mapStyleUrl, trips }: Props) {
  const t = useTranslations("tours");
  const router = useRouter();
  const [form, setForm] = useState<TourForm>(() => initialForm(tour, prefill));
  const [saved, setSaved] = useState<Tour | null>(tour);
  const [savedSig, setSavedSig] = useState<string | null>(() => (tour ? draftSignature(toDraft(formFromInput(tour.input, tour.title))) : null));
  const [updatedAt, setUpdatedAt] = useState<string | null>(tour?.updatedAt ?? null);
  // A stored result whose points are no longer all in the input (saved, not recomputed) is withheld.
  const [result, setResult] = useState<TourResult | null>(tour?.result && resultFitsInput(tour.input, tour.result) ? tour.result : null);
  // The input the shown result belongs to (names and coordinates of its keys).
  const [resultInput, setResultInput] = useState(tour?.input ?? null);
  const [serverOutdated, setServerOutdated] = useState(tour?.outdated ?? true);
  const [extras, setExtras] = useState<Extras | null>(
    tour && view && !tour.outdated ? { stopTimes: view.stopTimes, byMin: view.byMin, proposals: [], droppedOverrides: 0, sightsPending: false } : null,
  );
  const [notRecomputed, setNotRecomputed] = useState(false);
  const [busy, setBusy] = useState<"saving" | "computing" | "deleting" | null>(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [unreachable, setUnreachable] = useState<string[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [sheet, setSheet] = useState<SheetState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const signature = useMemo(() => draftSignature(toDraft(form)), [form]);
  const outdated = isOutdated({ hasResult: result !== null, serverOutdated, savedSignature: savedSig, signature });
  const centre = form.city ?? form.places[0] ?? null;
  const taken = (key: string) => isTaken(form, key);
  const full = form.places.length >= MAX_TOUR_PLACES;
  const title = tourTitle(t, form.title || null, form.city?.name ?? null, form.places[0]?.name ?? null);

  // Edits outside the form (leg sheet, nearby sights, proposals) wait for a running save or computation too.
  function edit(next: TourForm) {
    if (busy !== null) return;
    setForm(next);
    setError(null);
  }

  /** Several places at once (pasted list): one edit, so none is lost to a stale form. */
  function addPlaces(list: FormPoint[]) {
    let next = form;
    for (const p of list) if (canAddPlace(next, p.key)) next = { ...next, places: [...next.places, p] };
    if (next === form) return;
    setUnknown((u) => u.filter((k) => !list.some((p) => p.key === k)));
    edit(next);
  }

  function addPlace(p: FormPoint) {
    if (!canAddPlace(form, p.key)) return;
    setUnknown((u) => u.filter((k) => k !== p.key));
    edit({ ...form, places: [...form.places, p] });
  }

  function addSight(s: TourSight) {
    // Sights of the stored result are known to the server: no reference needed (spec 11 implementation notes).
    addPlace({ key: s.key, name: s.name, lat: s.lat, lon: s.lon, source: "osm", cat: s.cat.slice(0, 40) });
  }

  function onComputeError(c: Extract<ComputeTourResult, { ok: false }>) {
    setError(c.error);
    if (c.error === "unreachable") setUnreachable(c.points ?? []);
    if (c.error === "ors_unavailable" && c.notRecomputed) {
      setNotRecomputed(true);
      // Only a result whose stops all exist in the input it is shown with.
      if (c.result && resultInput && resultFitsInput(resultInput, c.result)) setResult(c.result);
    }
  }

  async function plan(force = false) {
    if (busy !== null) return; // one save or computation at a time (a second click must not start another)
    const blocked = formProblem(form);
    setProblem(blocked);
    if (blocked) return;
    setError(null);
    setUnreachable([]);
    setNotRecomputed(false);
    let current = saved;
    let version = updatedAt;
    const isNew = !current;

    if (!current || signature !== savedSig) {
      setBusy("saving");
      const draft = toDraft(form);
      const r = await (current
        ? updateTour(current.id, draft, version ?? undefined)
        : createTour(draft, prefill ? { tripId: prefill.tripId, day: prefill.day } : undefined)
      ).catch(() => null);
      if (!r || !r.ok) {
        setBusy(null);
        setError(r ? r.error : "failed");
        if (r && r.error === "unknown_point") setUnknown(issueKeys(r.issues));
        return;
      }
      current = r.data;
      version = r.data.updatedAt;
      // The server may re-key points (a Geoapify result resolved to its OSM key): continue with what it stored.
      const next = formFromInput(r.data.input, r.data.title);
      setForm(next);
      setSaved(r.data);
      setSavedSig(draftSignature(toDraft(next)));
      setUpdatedAt(version);
      setServerOutdated(r.data.outdated);
      setUnknown([]);
      if (isNew) {
        // Keep this page (and the result about to come) but give it the tour's own address.
        window.history.replaceState(null, "", window.location.pathname.replace(/\/tours\/new$/, `/tours/${r.data.id}`));
      }
    }

    setBusy("computing");
    const c = await computeTour(current.id, force ? { force: true } : {}).catch((): ComputeTourResult => ({ ok: false, error: "failed" }));
    setBusy(null);
    if (!c.ok) {
      onComputeError(c);
      return;
    }
    setResult(c.data.result);
    setResultInput(current.input);
    setServerOutdated(false);
    setUpdatedAt(c.data.updatedAt);
    setExtras({
      stopTimes: c.data.stopTimes,
      byMin: c.data.byMin,
      proposals: c.data.proposals,
      droppedOverrides: c.data.droppedOverrides,
      sightsPending: c.data.sightsPending,
    });
    // From a trip day (spec 2.2): after the first successful plan (also after a retry) the user returns to the trip.
    if (prefill) {
      router.push(`/app/trips/${prefill.tripId}`);
      router.refresh();
    }
  }

  async function remove() {
    if (!saved || busy !== null) return;
    setBusy("deleting");
    const r = await deleteTour(saved.id).catch(() => null);
    setBusy(null);
    setConfirmDelete(false);
    if (!r || !r.ok) {
      setError(r ? r.error : "failed");
      return;
    }
    router.push("/app/tours");
    router.refresh();
  }

  const names = new Map<string, string>([
    ...(resultInput ? [resultInput.start, ...resultInput.places, typeof resultInput.end === "object" ? resultInput.end : undefined] : []).flatMap(
      (p): [string, string][] => (p ? [[p.key, p.name]] : []),
    ),
    ...(result?.sights ?? []).map((s): [string, string] => [s.key, s.name]),
  ]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        {prefill ? (
          <Link href={`/app/trips/${prefill.tripId}`} className="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-2">
            {t("backToTrip")}
          </Link>
        ) : (
          <Link href="/app/tours" className="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-2">
            {t("back")}
          </Link>
        )}
        <h1 className="break-words text-3xl font-bold sm:text-4xl">{form.title.trim() || form.city || form.places.length ? title : t("newTitle")}</h1>
        {prefill && <p className={`text-sm ${mutedCls}`}>{t("fromTrip", { day: prefill.day, trip: prefill.tripTitle })}</p>}
        {saved?.tripId && !prefill && (
          <Link href={`/app/trips/${saved.tripId}`} className="inline-flex min-h-11 items-center self-start text-sm underline underline-offset-2">
            {saved.tripDay ? t("linkedTo", { trip: trips.find((x) => x.id === saved.tripId)?.title ?? "", day: saved.tripDay }) : t("linkedNoDay", { trip: trips.find((x) => x.id === saved.tripId)?.title ?? "" })}
          </Link>
        )}
      </div>

      <ClientForm
        className="flex flex-col gap-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void plan();
        }}
      >
        {/* Locked while saving or computing: the response replaces the form, an edit in between would be lost. */}
        <fieldset disabled={busy !== null} className="contents min-w-0 border-0 p-0">
        <div className={`${cardCls} flex flex-col gap-4`}>
          <CityField value={form.city} onChange={(city) => edit({ ...form, city })} />

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-lg font-semibold">
              {t("places")} <span className={`text-sm font-normal ${mutedCls}`}>({form.places.length}/{MAX_TOUR_PLACES})</span>
            </legend>
            {!full ? (
              <PlaceSearch label={t("placesSearch")} centre={centre} isTaken={taken} onPick={(s) => addPlace(suggestionToPoint(s))} />
            ) : (
              <p className={`text-sm ${mutedCls}`}>{t("maxPlaces", { max: MAX_TOUR_PLACES })}</p>
            )}
            <PastePlaces
              centre={centre}
              room={MAX_TOUR_PLACES - form.places.length}
              isTaken={taken}
              onAdd={(list) => addPlaces(list.map(suggestionToPoint))}
            />
            {form.city?.key.startsWith("geo:") && (
              <CitySuggestions
                key={`${form.city.key}|${prefill?.tripId ?? saved?.tripId ?? ""}`}
                city={form.city}
                tripId={prefill?.tripId ?? saved?.tripId ?? undefined}
                isTaken={taken}
                canAdd={!full}
                onPick={(s) => addPlace(suggestionToPoint(s))}
              />
            )}
            <PlaceList
              places={form.places}
              dwellDefaultMin={form.dwellDefaultMin}
              unreachable={unreachable}
              unknown={unknown}
              onChange={(places) => edit({ ...form, places })}
            />
            {(problem === "places" || form.places.length < 2) && (
              <p className={`text-sm ${problem === "places" ? "text-danger" : mutedCls}`} role={problem === "places" ? "alert" : undefined}>
                {t("placesMin")}
              </p>
            )}
          </fieldset>
        </div>

        <TourOptions form={form} centre={centre} isTaken={taken} onChange={edit} />
        {problem === "end" && (
          <p role="alert" className="text-sm text-danger">
            {t("endMissing")}
          </p>
        )}
        {problem === "durations" && (
          <p role="alert" className="text-sm text-danger">
            {t("durationOrder")}
          </p>
        )}

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <button type="submit" className={`${btnPrimary} w-full sm:w-auto`} disabled={busy !== null} data-testid="tour-plan">
            {busy === "saving" ? t("saving") : busy === "computing" ? t("computing") : result ? t("replan") : t("plan")}
          </button>
          <p role="status" className="sr-only">
            {busy === "saving" ? t("saving") : busy === "computing" ? t("computing") : ""}
          </p>
        </div>
        </fieldset>
        <TourError error={error} onReload={() => window.location.reload()} />
      </ClientForm>

      {result && resultInput ? (
        <TourResultView
          input={resultInput}
          result={result}
          stopTimes={extras?.stopTimes ?? null}
          byMin={extras?.byMin ?? null}
          mapStyleUrl={mapStyleUrl}
          outdated={outdated}
          notRecomputed={notRecomputed}
          proposals={outdated ? [] : extras?.proposals}
          droppedOverrides={outdated ? 0 : extras?.droppedOverrides}
          sightsPending={extras?.sightsPending}
          onChangeLeg={(from, to) => setSheet(openLegSheet(from, to, form))}
          onAddSight={addSight}
          sightInTour={(key) => form.places.some((p) => p.key === key)}
          canAddMore={!full}
          onApplyProposal={(p) => edit(applyProposal(form, p))}
          tourId={saved?.id}
          title={title}
          onRecomputeForce={() => void plan(true)}
        />
      ) : (
        saved && <p className={`text-sm ${mutedCls}`}>{t("notComputed")}</p>
      )}

      {saved && (
        <div className="flex flex-col gap-4">
          <TourTripLink
            tourId={saved.id}
            tripId={saved.tripId}
            tripDay={saved.tripDay}
            trips={trips}
            onLinked={(x) => {
              setSaved((s) => (s ? { ...s, tripId: x.tripId, tripDay: x.tripDay } : s));
              setUpdatedAt(x.updatedAt);
            }}
          />
          <button type="button" className={`${btnSecondary} self-start`} disabled={busy !== null} onClick={() => setConfirmDelete(true)}>
            {t("delete")}
          </button>
        </div>
      )}

      <LegSheet
        sheet={sheet}
        fromName={sheet ? (names.get(sheet.from) ?? "") : ""}
        toName={sheet ? (names.get(sheet.to) ?? "") : ""}
        onChange={setSheet}
        onClose={() => setSheet(null)}
        onReset={() => {
          if (sheet) edit({ ...form, legOverrides: applyLegSheet(form.legOverrides, { ...sheet, mode: form.mode, route: form.route }, form) });
          setSheet(null);
        }}
        onApply={() => {
          if (sheet) edit({ ...form, legOverrides: applyLegSheet(form.legOverrides, sheet, form) });
          setSheet(null);
        }}
      />

      <ConfirmDialog
        open={confirmDelete}
        title={t("deleteTitle")}
        description={t("deleteBody", { name: title })}
        confirmLabel={t("deleteConfirm")}
        cancelLabel={t("cancel")}
        pending={busy === "deleting"}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
