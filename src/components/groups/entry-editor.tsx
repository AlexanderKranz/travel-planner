"use client";

import { useTranslations } from "next-intl";
import { CheckboxField, SelectField, TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnSecondary, cardCls, mutedCls } from "@/components/ui/styles";
import type { TraitKey } from "@/lib/domain";
import { MOBILITY, type EntryDraft } from "./draft";

type Props = {
  draft: EntryDraft;
  index: number;
  traitKeys: readonly TraitKey[];
  issues?: Issue[];
  onChange: (patch: Partial<EntryDraft>) => void;
  onRemove: () => void;
};

export function EntryEditor({ draft, index, traitKeys, issues, onChange, onRemove }: Props) {
  const t = useTranslations("groups.entry");
  const bad = t("fieldInvalid");
  const at = (path: string) => errorAt(issues, `entries.${index}.${path}`, bad);
  const show = (k: TraitKey) => traitKeys.includes(k);
  const isMember = draft.kind === "member";
  const ageDisabled = draft.isSelf || (isMember && draft.birthdate !== "");
  const title = draft.isSelf ? t("selfTitle") : isMember ? t("memberTitle") : t("compositionTitle");

  return (
    <li className={`${cardCls} flex flex-col gap-4`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">
          {index + 1}. {title}
        </h3>
        <div className="flex gap-1">
          <button type="button" className={btnSecondary} onClick={onRemove}>
            {t("remove")}
          </button>
        </div>
      </div>

      {draft.isSelf && <p className={`text-sm ${mutedCls}`}>{t("selfHint")}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        {!isMember && (
          <TextField
            label={t("count")}
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            value={draft.count}
            onChange={(e) => onChange({ count: e.target.value })}
            error={at("count")}
          />
        )}
        {isMember && !draft.isSelf && (
          <TextField
            label={t("name")}
            value={draft.name}
            maxLength={80}
            onChange={(e) => onChange({ name: e.target.value })}
            error={at("name")}
            required
          />
        )}
        <TextField
          label={t("label")}
          hint={t("labelHint")}
          value={draft.label}
          maxLength={60}
          onChange={(e) => onChange({ label: e.target.value })}
          error={at("label")}
        />
        {isMember && !draft.isSelf && (
          <TextField
            label={t("birthdate")}
            type="date"
            min="1900-01-01"
            value={draft.birthdate}
            onChange={(e) => onChange({ birthdate: e.target.value })}
            error={at("birthdate")}
          />
        )}
      </div>

      {!draft.isSelf && (
        <fieldset className="grid gap-4 sm:grid-cols-2" disabled={ageDisabled}>
          <legend className="sr-only">{t("ageGroup")}</legend>
          <SelectField
            label={t("ageMode")}
            value={draft.ageMode}
            onChange={(e) =>
              onChange({
                ageMode: e.target.value as EntryDraft["ageMode"],
                ageAsOf: undefined,
              })
            }
            error={at("age")}
            hint={ageDisabled ? t("ageIgnored") : undefined}
          >
            <option value="">{t("ageNone")}</option>
            <option value="exact">{t("ageExact")}</option>
            <option value="approx">{t("ageApprox")}</option>
            <option value="relativeToMe">{t("ageRelative")}</option>
          </SelectField>
          {(draft.ageMode === "exact" || draft.ageMode === "approx") && (
            <TextField
              label={t("age")}
              type="number"
              inputMode="numeric"
              min={0}
              max={120}
              value={draft.age}
              onChange={(e) => onChange({ age: e.target.value, ageAsOf: undefined })}
              error={at("age")}
            />
          )}
        </fieldset>
      )}

      {traitKeys.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2">
          {show("mobility") && (
            <SelectField
              label={t("mobility")}
              value={draft.mobility}
              onChange={(e) => onChange({ mobility: e.target.value as EntryDraft["mobility"] })}
              error={at("traits.mobility")}
            >
              <option value="">{t("mobilityUnset")}</option>
              {MOBILITY.map((m) => (
                <option key={m} value={m}>
                  {t(`mobilityOptions.${m}`)}
                </option>
              ))}
            </SelectField>
          )}
          {show("diet") && (
            <TextField
              label={t("diet")}
              hint={t("dietHint")}
              value={draft.diet}
              onChange={(e) => onChange({ diet: e.target.value })}
              error={at("traits.diet")}
            />
          )}
          {show("golfHandicap") && (
            <TextField
              label={t("golfHandicap")}
              type="number"
              step="0.1"
              min={-10}
              max={54}
              value={draft.golfHandicap}
              onChange={(e) => onChange({ golfHandicap: e.target.value })}
              error={at("traits.golfHandicap")}
            />
          )}
          {show("needsNap") && (
            <CheckboxField
              label={t("needsNap")}
              checked={draft.needsNap}
              onChange={(e) => onChange({ needsNap: e.target.checked })}
            />
          )}
        </div>
      )}

      <TextField
        label={t("notes")}
        value={draft.notes}
        maxLength={1000}
        onChange={(e) => onChange({ notes: e.target.value })}
        error={at("notes")}
      />
    </li>
  );
}
