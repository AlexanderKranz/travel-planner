"use client";

import { useTranslations } from "next-intl";
import { CheckboxField, SelectField } from "@/components/ui/fields";
import { INTEREST_KEYS, type PurposeGuided } from "@/lib/domain";
import { ChipList } from "./chip-list";

const PACE = ["relaxed", "balanced", "packed"] as const;
const BUDGET = ["low", "mid", "high", "luxury"] as const;
const ACCOMMODATION = ["hotel", "apartment", "cruise_cabin", "camping", "any"] as const;
const FLIGHT_HOURS = [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12] as const;
const ROOMS = ["shared", "single_rooms"] as const;

export type GuidedState = {
  pace: string;
  budget: string;
  rooms: string;
  maxFlightHours: string;
  accommodation: string[];
  interests: string[];
};

export const emptyGuided: GuidedState = {
  pace: "",
  budget: "",
  rooms: "",
  maxFlightHours: "",
  accommodation: [],
  interests: [],
};

export function guidedFromStored(g: PurposeGuided): GuidedState {
  return {
    pace: g.pace ?? "",
    budget: g.budget ?? "",
    rooms: g.rooms ?? "",
    maxFlightHours: g.maxFlightHours ? String(g.maxFlightHours) : "",
    accommodation: g.accommodation ?? [],
    interests: g.interests ?? [],
  };
}

export function guidedToInput(s: GuidedState) {
  return {
    v: 1 as const,
    ...(s.pace && { pace: s.pace as (typeof PACE)[number] }),
    ...(s.budget && { budget: s.budget as (typeof BUDGET)[number] }),
    ...(s.rooms && { rooms: s.rooms as (typeof ROOMS)[number] }),
    ...(s.maxFlightHours && { maxFlightHours: Number(s.maxFlightHours) }),
    ...(s.accommodation.length && {
      accommodation: s.accommodation as (typeof ACCOMMODATION)[number][],
    }),
    ...(s.interests.length && { interests: s.interests }),
  };
}

const toggle = (list: string[], v: string) =>
  list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

export function GuidedFields({
  value,
  onChange,
  invalid,
}: {
  value: GuidedState;
  onChange: (next: GuidedState) => void;
  invalid?: boolean;
}) {
  const t = useTranslations("purposes");
  const ti = useTranslations("interests");
  const set = (p: Partial<GuidedState>) => onChange({ ...value, ...p });
  const custom = value.interests.filter((i) => !(INTEREST_KEYS as readonly string[]).includes(i));

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField label={t("pace")} value={value.pace} onChange={(e) => set({ pace: e.target.value })}>
          <option value="">{t("unset")}</option>
          {PACE.map((k) => (
            <option key={k} value={k}>
              {t(`paceOptions.${k}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t("budget")}
          value={value.budget}
          onChange={(e) => set({ budget: e.target.value })}
        >
          <option value="">{t("unset")}</option>
          {BUDGET.map((k) => (
            <option key={k} value={k}>
              {t(`budgetOptions.${k}`)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t("rooms")} value={value.rooms} onChange={(e) => set({ rooms: e.target.value })}>
          <option value="">{t("unset")}</option>
          {ROOMS.map((k) => (
            <option key={k} value={k}>
              {t(`roomsOptions.${k}`)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t("maxFlightHours.label")}
          value={value.maxFlightHours}
          onChange={(e) => set({ maxFlightHours: e.target.value })}
        >
          <option value="">{t("maxFlightHours.any")}</option>
          {FLIGHT_HOURS.map((h) => (
            <option key={h} value={String(h)}>
              {t("maxFlightHours.hours", { h })}
            </option>
          ))}
        </SelectField>
      </div>

      <fieldset className="flex flex-col">
        <legend className="mb-1 text-sm font-medium">{t("accommodation")}</legend>
        <div className="grid sm:grid-cols-2">
          {ACCOMMODATION.map((k) => (
            <CheckboxField
              key={k}
              label={t(`accommodationOptions.${k}`)}
              checked={value.accommodation.includes(k)}
              onChange={() => set({ accommodation: toggle(value.accommodation, k) })}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("interests")}</legend>
        <ul className="flex flex-wrap gap-2">
          {INTEREST_KEYS.map((k) => {
            const on = value.interests.includes(k);
            return (
              <li key={k}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ interests: toggle(value.interests, k) })}
                  className={`min-h-11 rounded-full border px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                    on
                      ? "border-accent bg-accent text-white"
                      : "border-line-strong"
                  }`}
                >
                  {ti(k)}
                </button>
              </li>
            );
          })}
        </ul>
        <ChipList
          label={t("customInterest")}
          addLabel={t("add")}
          items={custom}
          max={20}
          maxLength={40}
          error={invalid ? t("fieldInvalid") : undefined}
          onChange={(c) =>
            set({
              interests: [
                ...value.interests.filter((i) => (INTEREST_KEYS as readonly string[]).includes(i)),
                ...c,
              ],
            })
          }
        />
      </fieldset>
    </div>
  );
}
