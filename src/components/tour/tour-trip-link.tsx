"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { SelectField } from "@/components/ui/fields";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import type { ActionError } from "@/lib/domain";
import type { Tour } from "@/lib/domain/tour";
import { linkTourToTrip } from "@/lib/server/tours";
import { TourError } from "./tour-error";

export type TripOption = { id: string; title: string; lengthDays: number };

/** "Zu einer Reise hinzufügen" (spec 2.2): trip select and day select; own trips only ([T15]). */
export function TourTripLink({
  tourId,
  tripId,
  tripDay,
  trips,
  onLinked,
}: {
  tourId: string;
  tripId: string | null;
  tripDay: number | null;
  trips: TripOption[];
  onLinked: (t: Tour) => void;
}) {
  const t = useTranslations("tours");
  const [trip, setTrip] = useState(tripId ?? "");
  const [day, setDay] = useState(tripDay === null ? "" : String(tripDay));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const selected = trips.find((x) => x.id === trip);
  const changed = trip !== (tripId ?? "") || day !== (tripDay === null ? "" : String(tripDay));

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const r = await linkTourToTrip(tourId, trip || null, trip && day ? Number(day) : null).catch(() => null);
    setBusy(false);
    if (!r) return setError("failed");
    if (!r.ok) return setError(r.error);
    setSaved(true);
    onLinked(r.data);
  }

  return (
    <details className="rounded-[14px] border border-line bg-card">
      <summary className="flex min-h-11 cursor-pointer items-center px-4 font-semibold">{t("addToTrip")}</summary>
      <div className="flex flex-col gap-3 px-4 pb-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label={t("tripSelect")}
            value={trip}
            onChange={(e) => {
              setTrip(e.target.value);
              setDay("");
              setSaved(false);
            }}
          >
            <option value="">{t("tripNone")}</option>
            {trips.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t("daySelect")}
            value={day}
            disabled={!selected}
            onChange={(e) => {
              setDay(e.target.value);
              setSaved(false);
            }}
          >
            <option value="">{t("noDay")}</option>
            {Array.from({ length: selected?.lengthDays ?? 0 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {t("dayOption", { day: i + 1 })}
              </option>
            ))}
          </SelectField>
        </div>
        <button type="button" className={`${btnSecondary} self-start`} disabled={busy || !changed} onClick={save}>
          {t("linkSave")}
        </button>
        {saved && (
          <p role="status" className={`text-sm ${mutedCls}`}>
            {t("linkSaved")}
          </p>
        )}
        <TourError error={error} />
      </div>
    </details>
  );
}
