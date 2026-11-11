"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { btnPrimary, btnSecondary, errorCls, mutedCls } from "@/components/ui/styles";
import { MAX_TRIP_STOPS, type TripStop } from "@/lib/domain/trip-stops";
import { derivedTripStops } from "@/lib/server/itinerary";
import { StopRowEditor } from "./stop-row-editor";
import {
  datesOffer,
  emptyRow,
  fillMissingRows,
  remapRowsToStart,
  rowDate,
  rowsFromExtracted,
  rowsFromStops,
  rowsHaveProblems,
  type StopRow,
} from "./stops-draft";
import { StopsUpload, type UploadResult } from "./stops-upload";

type Patch = { multiStop?: boolean; stops?: StopRow[]; lengthDays?: number; startDate?: string };

/** A new extraction waiting for the user's choice (shown below saved or typed stops). */
type Proposal = { rows: StopRow[]; truncatedTo?: number };

/**
 * Section "Stopps & Zeiten" ([D1], [D7]): the upload, the editable list and the take-over rows. Always mounted so
 * it can tick the checkbox for derived stops; shows nothing while `multiStop` is off.
 * UI state only: nothing is saved before the trip form's "Speichern".
 */
export function StopsSection({
  multiStop,
  rows,
  lengthDays,
  startDate,
  notes,
  tripId,
  savedNotes,
  canEdit,
  showProblems,
  onChange,
}: {
  multiStop: boolean;
  rows: StopRow[];
  lengthDays: number;
  /** The start date in the form right now (empty = none). */
  startDate: string;
  notes: string;
  /** null while the trip is not saved yet. */
  tripId: string | null;
  /** The notes as saved: stops derived from the notes ([D10]) belong to exactly this text. */
  savedNotes: string;
  /** `canEdit(access)`; a read grantee sees the list read-only. */
  canEdit: boolean;
  showProblems: boolean;
  onChange: (patch: Patch) => void;
}) {
  const t = useTranslations("trips.stops");
  const f = useFormatter();
  const [derived, setDerived] = useState<TripStop[]>([]);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [info, setInfo] = useState<{ count: number; truncatedTo?: number } | null>(null);
  const ctx = { startDate: startDate || null, lengthDays: Number.isFinite(lengthDays) && lengthDays >= 1 ? lengthDays : 1 };

  // Stops the server derived from the saved notes: ticks the box so an existing trip opens with the section.
  useEffect(() => {
    if (!tripId) return;
    let live = true;
    void derivedTripStops(tripId)
      .then((stops) => {
        if (!live || stops.length === 0) return;
        setDerived(stops);
        onChange({ multiStop: true });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // Once per opened trip; onChange only patches the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId]);

  const derivedShown = derived.length > 0 && rows.length === 0 && notes.trim() === savedNotes.trim();
  const fmt = (iso: string) => f.dateTime(new Date(`${iso}T00:00:00Z`), { day: "2-digit", month: "2-digit", timeZone: "UTC" });

  function onResult(r: UploadResult) {
    const incoming = rowsFromExtracted(r.stops);
    if (rows.length === 0) {
      // Nothing typed yet: the proposal is the editable list, to be checked and saved.
      onChange({ stops: incoming });
      setProposal(null);
      setInfo({ count: incoming.length, truncatedTo: r.truncatedTo });
    } else {
      setProposal({ rows: incoming, truncatedTo: r.truncatedTo });
      setInfo(null);
    }
  }

  const offerRows = proposal ? [...rows, ...proposal.rows] : rows;
  const offer = datesOffer(offerRows, ctx);

  function takeDates() {
    if (!offer) return;
    onChange({ startDate: offer.startDate, lengthDays: offer.days, stops: remapRowsToStart(rows, offer.startDate) });
    if (proposal) setProposal({ ...proposal, rows: remapRowsToStart(proposal.rows, offer.startDate) });
  }

  const updateRow = (key: string, patch: Partial<StopRow>) =>
    onChange({ stops: rows.map((r) => (r.key === key ? { ...r, ...patch } : r)) });

  return (
    <section aria-label={t("title")} id="field-stops" className="flex flex-col gap-3">
      {multiStop && (
        <div className="flex flex-col gap-4 rounded-[14px] border border-line bg-card p-4">
          <div>
            <h3 className="text-lg font-semibold">{t("title")}</h3>
            <p className={`text-sm ${mutedCls}`}>{t("hint")}</p>
          </div>

          {!canEdit && <p className={`text-sm ${mutedCls}`}>{t("readOnly")}</p>}

          {canEdit && (
            <StopsUpload
              tripId={tripId}
              ctx={ctx}
              notes={notes}
              hasNotes={notes.trim() !== ""}
              showFromNotes={!derivedShown}
              onResult={onResult}
            />
          )}

          {info && (
            <div role="status" className="flex flex-col gap-1 rounded-lg border border-info-line bg-info-bg p-3 text-sm text-info-fg">
              <p>{t("proposal", { count: info.count })}</p>
              {info.truncatedTo && <p>{t("error.tooManyPages", { pages: info.truncatedTo })}</p>}
            </div>
          )}

          {derivedShown && canEdit && (
            <div className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <p className="text-sm font-medium">{t("derived", { count: derived.length })}</p>
              <button
                type="button"
                className={`${btnSecondary} self-start`}
                onClick={() => {
                  onChange({ stops: rowsFromStops(derived) });
                  setInfo({ count: derived.length });
                }}
              >
                {t("takeOver")}
              </button>
            </div>
          )}

          {rows.length > 0 ? (
            canEdit ? (
              <ol className="flex flex-col gap-3">
                {rows.map((r, i) => (
                  <StopRowEditor
                    key={r.key}
                    row={r}
                    index={i}
                    startDate={ctx.startDate}
                    lengthDays={lengthDays}
                    showProblems={showProblems}
                    onChange={(p) => updateRow(r.key, p)}
                    onRemove={() => onChange({ stops: rows.filter((x) => x.key !== r.key) })}
                  />
                ))}
              </ol>
            ) : (
              <ol className="flex flex-col gap-1 text-sm">
                {rows.map((r) => {
                  const date = rowDate(ctx.startDate, r.day);
                  return (
                    <li key={r.key}>
                      {date ? t("dayOption", { n: r.day, date: fmt(date) }) : t("dayOptionNoDate", { n: r.day })}: {r.sea ? t("sea") : r.place}
                      {(r.arr || r.dep) && ` · ${r.arr || "–"}–${r.dep || "–"}`}
                    </li>
                  );
                })}
              </ol>
            )
          ) : (
            !derivedShown && <p className={`text-sm ${mutedCls}`}>{t("empty")}</p>
          )}

          {canEdit && showProblems && rowsHaveProblems(rows, lengthDays) && (
            <p role="alert" className={errorCls}>
              {t("invalidList")}
            </p>
          )}

          {proposal && canEdit && (
            <div role="group" aria-label={t("proposalBelow", { count: proposal.rows.length })} className="flex flex-col gap-3 rounded-lg border border-accent p-3">
              <p className="text-sm font-medium">{t("proposalBelow", { count: proposal.rows.length })}</p>
              {proposal.truncatedTo && <p className="text-sm">{t("error.tooManyPages", { pages: proposal.truncatedTo })}</p>}
              <ol className="flex flex-col gap-1 text-sm">
                {proposal.rows.map((r) => (
                  <li key={r.key}>
                    {t("dayOptionNoDate", { n: r.day })}: {r.sea ? t("sea") : r.place}
                    {(r.arr || r.dep) && ` · ${r.arr || "–"}–${r.dep || "–"}`}
                  </li>
                ))}
              </ol>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={() => {
                    onChange({ stops: proposal.rows });
                    setInfo({ count: proposal.rows.length, truncatedTo: proposal.truncatedTo });
                    setProposal(null);
                  }}
                >
                  {t("replace")}
                </button>
                <button
                  type="button"
                  className={btnSecondary}
                  onClick={() => {
                    onChange({ stops: fillMissingRows(rows, proposal.rows) });
                    setProposal(null);
                  }}
                >
                  {t("fillMissing")}
                </button>
                <button type="button" className={btnSecondary} onClick={() => setProposal(null)}>
                  {t("discard")}
                </button>
              </div>
            </div>
          )}

          {canEdit && offer && (
            <button type="button" className={`${btnSecondary} self-start text-left`} onClick={takeDates}>
              {t("takeDates", { range: `${fmt(offer.startDate)}–${fmt(offer.endDate)}`, days: offer.days })}
            </button>
          )}

          {canEdit && (
            <button
              type="button"
              className={`${btnSecondary} self-start`}
              disabled={rows.length >= MAX_TRIP_STOPS}
              onClick={() => onChange({ stops: [...rows, emptyRow(Math.min(rows.at(-1)?.day ?? 1, ctx.lengthDays))] })}
            >
              <span aria-hidden="true">+ </span>
              {t("add")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
