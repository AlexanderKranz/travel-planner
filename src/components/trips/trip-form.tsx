"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { AirportPicker } from "@/components/settings/airport-picker";
import { ErrorBanner } from "@/components/ui/error-banner";
import { CheckboxField, SelectField, TextAreaField, TextField } from "@/components/ui/fields";
import { hasIssue, type Issue } from "@/components/ui/issues";
import { btnPrimary, btnSecondary, inputCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import { MAX_TRIP_DAYS, type ActionError, type Trip } from "@/lib/domain";
import { createTrip, updateTrip } from "@/lib/server/trips";
import { DestinationPicker } from "./destination-picker";
import { TimingField } from "./timing-field";
import {
  draftFromTrip,
  draftProblems,
  draftToInput,
  emptyTripDraft,
  type TripDraft,
} from "./trip-draft";

type Option = { id: string; name: string };

export function TripForm({
  trip,
  groups,
  purposes,
  hasHomeAirports,
  countryCodes,
}: {
  trip?: Trip;
  groups: Option[];
  purposes: Option[];
  /** Profile has home airports; if not, "show flights" starts unchecked for new trips. */
  hasHomeAirports: boolean;
  /** ISO country codes for the free-text destination picker (from the server dataset). */
  countryCodes: string[];
}) {
  const t = useTranslations("trips.form");
  const router = useRouter();
  const [draft, setDraft] = useState<TripDraft>(() =>
    trip ? draftFromTrip(trip) : emptyTripDraft(hasHomeAirports),
  );
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [local, setLocal] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const set = (patch: Partial<TripDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const bad = (path: string) => (hasIssue(issues, path) || local.includes(path) ? t("invalid") : undefined);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    const problems = draftProblems(draft);
    setLocal(problems);
    if (problems.length > 0) {
      document.getElementById(`field-${problems[0]}`)?.scrollIntoView({ block: "center" });
      return;
    }
    const input = draftToInput(draft);
    start(async () => {
      const result = trip ? await updateTrip(trip.id, input) : await createTrip(input);
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
        return;
      }
      router.push(`/app/trips/${result.data.id}`);
      router.refresh();
    });
  }

  const titleHint = t("titleHint");

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6" noValidate>
      <div id="field-destination">
        <DestinationPicker
          countryCodes={countryCodes}
          value={draft.destination}
          onChange={(destination) => set({ destination })}
          error={
            bad("destination")
              ? draft.destination.mode === "none"
                ? t("destination.required")
                : t("invalid")
              : undefined
          }
        />
      </div>

      <div className="flex flex-col gap-1" id="field-lengthDays">
        <label htmlFor="trip-length" className="text-sm font-medium">
          {t("length")}
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`${btnSecondary} min-w-11`}
            aria-label={t("lengthLess")}
            disabled={draft.lengthDays <= 1}
            onClick={() => set({ lengthDays: Math.max(1, draft.lengthDays - 1) })}
          >
            <span aria-hidden="true">−</span>
          </button>
          <input
            id="trip-length"
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_TRIP_DAYS}
            step={1}
            required
            value={Number.isFinite(draft.lengthDays) ? draft.lengthDays : ""}
            onChange={(e) => set({ lengthDays: e.target.value === "" ? NaN : Number(e.target.value) })}
            aria-invalid={bad("lengthDays") ? true : undefined}
            aria-describedby="trip-length-hint"
            className={`${inputCls} w-24 text-center`}
          />
          <button
            type="button"
            className={`${btnSecondary} min-w-11`}
            aria-label={t("lengthMore")}
            disabled={draft.lengthDays >= MAX_TRIP_DAYS}
            onClick={() => set({ lengthDays: Math.min(MAX_TRIP_DAYS, (draft.lengthDays || 0) + 1) })}
          >
            <span aria-hidden="true">+</span>
          </button>
          <span className="text-sm">{t("lengthUnit")}</span>
        </div>
        <p id="trip-length-hint" className={bad("lengthDays") ? "text-sm text-red-700 dark:text-red-400" : "text-sm text-neutral-600 dark:text-neutral-400"}>
          {bad("lengthDays") ? t("lengthInvalid", { max: MAX_TRIP_DAYS }) : t("lengthHint", { max: MAX_TRIP_DAYS })}
        </p>
      </div>

      <div id="field-timing">
        <TimingField
          value={draft.timing}
          onChange={(timing) => set({ timing })}
          error={
            bad("timing")
              ? draft.timing.mode === "date"
                ? t("timing.dateRequired")
                : t("timing.monthsRequired")
              : undefined
          }
        />
      </div>

      <TextField
        label={t("title")}
        hint={titleHint}
        value={draft.title}
        maxLength={120}
        onChange={(e) => set({ title: e.target.value })}
        error={bad("title")}
      />

      <SelectField
        label={t("group")}
        hint={t("groupHint")}
        value={draft.groupId}
        onChange={(e) => set({ groupId: e.target.value })}
      >
        <option value="">{t("none")}</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </SelectField>

      <SelectField
        label={t("purpose")}
        hint={t("purposeHint")}
        value={draft.purposeId}
        onChange={(e) => set({ purposeId: e.target.value })}
      >
        <option value="">{t("none")}</option>
        {purposes.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>

      <section aria-labelledby="flights-title" className="flex flex-col gap-2">
        <h2 id="flights-title" className="sr-only">
          {t("flights.title")}
        </h2>
        <CheckboxField
          label={t("flights.want")}
          checked={draft.wantsFlights}
          onChange={(e) => set({ wantsFlights: e.target.checked })}
        />
        <p className="text-sm text-neutral-600 dark:text-neutral-400">{t("flights.hint")}</p>
        {draft.wantsFlights && (
          <>
            <CheckboxField
              label={t("flights.useHome")}
              checked={draft.useHomeAirports}
              onChange={(e) => set({ useHomeAirports: e.target.checked })}
            />
            {!draft.useHomeAirports && (
              <AirportPicker
                value={draft.originAirports}
                onChange={(originAirports) => set({ originAirports })}
                error={bad("originAirports") ? t("flights.invalid") : undefined}
              />
            )}
          </>
        )}
      </section>

      <details className="rounded-lg border border-neutral-300 p-4 dark:border-neutral-700" open={!!trip?.notes}>
        <summary className="flex min-h-11 cursor-pointer items-center font-semibold focus-visible:outline-2 focus-visible:outline-blue-600">
          {t("notes")}
        </summary>
        <TextAreaField
          label={t("notesLabel")}
          hint={t("notesHint")}
          rows={4}
          maxLength={2000}
          value={draft.notes}
          onChange={(e) => set({ notes: e.target.value })}
          error={bad("notes")}
        />
      </details>

      <ErrorBanner error={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" className={btnSecondary} onClick={() => router.back()}>
          {t("cancel")}
        </button>
        <button type="submit" className={btnPrimary} disabled={pending}>
          {pending ? t("saving") : trip ? t("save") : t("create")}
        </button>
      </div>
    </form>
  );
}
