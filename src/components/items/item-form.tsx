"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { SelectField, TextAreaField, TextField } from "@/components/ui/fields";
import { btnPrimary, btnSecondary, focusCls, mutedCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { ITEM_CATEGORIES, ITEM_STATUSES, type ItemCategory, type ItemStatus, type TripItem } from "@/lib/domain/items";
import { parseMoney } from "@/lib/items/money";
import { createItem, updateItem } from "@/lib/server/items";
import { flightPrefill } from "@/lib/plan/fixed-items";
import { centsToInput, CURRENCIES, type FlightLegOption, type Prefill } from "./helpers";
import { ItemError } from "./item-error";

type Basis = "total" | "per_person";

/** Add/edit dialog: full-screen sheet below sm, centred dialog above. Native <dialog> gives focus trap + Escape. */
export function ItemForm({
  tripId,
  lengthDays,
  partySize,
  startDate = null,
  flights = [],
  item,
  prefill,
  onClose,
}: {
  tripId: string;
  lengthDays: number;
  partySize: number | null;
  startDate?: string | null;
  flights?: FlightLegOption[];
  item?: TripItem;
  prefill?: Prefill;
  onClose: () => void;
}) {
  const t = useTranslations("items");
  const locale = useLocale();
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [category, setCategory] = useState<ItemCategory>(item?.category ?? prefill?.category ?? "activity");
  const [title, setTitle] = useState(item?.title ?? prefill?.title ?? "");
  const [status, setStatus] = useState<ItemStatus>(item?.status ?? "option");
  const [price, setPrice] = useState(centsToInput(item?.priceCents ?? null, locale));
  const [basis, setBasis] = useState<Basis>(item?.priceBasis ?? "total");
  const [persons, setPersons] = useState(item?.persons ? String(item.persons) : "");
  const [currency, setCurrency] = useState(item?.currency ?? "EUR");
  const [day, setDay] = useState(String(item?.day ?? prefill?.day ?? ""));
  const [startTime, setStartTime] = useState(item?.startTime ?? prefill?.startTime ?? "");
  const [endTime, setEndTime] = useState(item?.endTime ?? prefill?.endTime ?? "");
  const [leg, setLeg] = useState("");
  const [url, setUrl] = useState(item?.url ?? "");
  const [notes, setNotes] = useState(item?.notes ?? "");
  const [priceError, setPriceError] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = parseMoney(price, locale);
    if (cents === "invalid") {
      setPriceError(true);
      return;
    }
    setPriceError(false);
    setError(null);
    setIssues({});
    const input = {
      category,
      title,
      status,
      priceCents: cents,
      priceBasis: basis,
      persons: persons.trim() === "" ? null : Number(persons),
      currency,
      day: day === "" ? null : Number(day),
      startTime: startTime === "" ? null : startTime,
      endTime: endTime === "" || startTime === "" ? null : endTime,
      ref: item?.ref ?? prefill?.ref ?? null,
      url: url.trim() === "" ? null : url.trim(),
      notes: notes.trim() === "" ? null : notes,
    };
    start(async () => {
      const r = item ? await updateItem(item.id, input) : await createItem(tripId, input);
      if (r.ok) {
        onClose();
        router.refresh();
      } else {
        setError(r.error);
        setIssues(Object.fromEntries((r.issues ?? []).map((i) => [i.path, i.message])));
      }
    });
  }

  function pickLeg(v: string) {
    setLeg(v);
    const l = v === "" ? undefined : flights[Number(v)];
    if (!l) return;
    const p = flightPrefill(l, lengthDays, startDate);
    setTitle(p.title);
    setDay(String(p.day));
    setStartTime(p.startTime);
    setEndTime(p.endTime);
  }
  const legLabel = (l: FlightLegOption) =>
    `${t(`flightDir.${l.dir}`)} · ${l.number} ${l.from} → ${l.to} · ${l.dep}–${l.arr}${l.arrDayOffset ? " +1" : ""}`;

  const currencies = CURRENCIES.includes(currency as (typeof CURRENCIES)[number]) ? CURRENCIES : [...CURRENCIES, currency];
  const radio = (v: Basis, label: string) => (
    <label className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-line-strong px-3 text-sm has-[:checked]:border-info-line has-[:checked]:bg-info-bg has-[:checked]:font-semibold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus">
      <input type="radio" name="basis" value={v} checked={basis === v} onChange={() => setBasis(v)} className="size-4 accent-accent" />
      {label}
    </label>
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto bg-card p-4 text-ink backdrop:bg-black/50 sm:m-auto sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-lg sm:border sm:border-line-strong sm:p-5"
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <h2 id={titleId} className="text-lg font-semibold">
          {item ? t("edit") : t("add")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label={t("fields.category")} value={category} onChange={(e) => setCategory(e.target.value as ItemCategory)}>
            {ITEM_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </SelectField>
          <SelectField label={t("fields.status")} value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
            {ITEM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`statuses.${s}`)}
              </option>
            ))}
          </SelectField>
        </div>
        {category === "flight" && flights.length > 0 && (
          <SelectField label={t("fields.verifiedFlight")} hint={t("fields.verifiedFlightHint")} value={leg} onChange={(e) => pickLeg(e.target.value)}>
            <option value="">{t("fields.manualFlight")}</option>
            {flights.map((l, i) => (
              <option key={`${l.dir}-${l.number}-${l.date}-${l.dep}`} value={i}>
                {legLabel(l)}
              </option>
            ))}
          </SelectField>
        )}
        <TextField
          label={t("fields.title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={120}
          required
          autoFocus
          error={issues["title"]}
        />
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <TextField
            label={t("fields.price")}
            inputMode="decimal"
            autoComplete="off"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            error={priceError ? t("priceInvalid") : issues["priceCents"]}
          />
          <SelectField label={t("fields.currency")} value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </SelectField>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">{t("fields.basis")}</legend>
          <div className="flex gap-2">
            {radio("total", t("fields.total"))}
            {radio("per_person", t("fields.perPerson"))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label={t("fields.persons")}
            hint={t("fields.personsHint")}
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            placeholder={partySize ? String(partySize) : undefined}
            value={persons}
            onChange={(e) => setPersons(e.target.value)}
            error={issues["persons"]}
          />
          <SelectField label={t("fields.day")} value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">{t("noDayOption")}</option>
            {Array.from({ length: Math.max(lengthDays, Number(day) || 0) }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {t("dayHeading", { n })}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t("fields.startTime")}
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            error={issues["startTime"]}
          />
          <TextField
            label={t("fields.endTime")}
            type="time"
            value={endTime}
            onChange={(e) => setEndTime(e.target.value)}
            disabled={startTime === ""}
            error={issues["endTime"]}
          />
        </div>
        <p className={`-mt-2 text-sm ${mutedCls}`}>{t("fields.timesHint")}</p>
        <TextField
          label={t("fields.link")}
          type="url"
          inputMode="url"
          placeholder="https://"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={500}
          error={issues["url"]}
        />
        <TextAreaField
          label={t("fields.notes")}
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1000}
          error={issues["notes"]}
        />
        <div aria-live="polite">
          <ItemError error={error} />
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className={`${btnSecondary} ${focusCls}`} onClick={onClose}>
            {t("cancel")}
          </button>
          <button type="submit" className={btnPrimary} disabled={pending}>
            {t("save")}
          </button>
        </div>
      </form>
    </dialog>
  );
}
