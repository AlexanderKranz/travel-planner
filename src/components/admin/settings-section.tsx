"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { btnPrimary, btnSecondary, focusCls, mutedCls, pillAccentCls, pillCls } from "@/components/ui/styles";
import { SETTING_DEFS, type SettingKey, type SettingValue } from "@/lib/settings";
import { resetSetting, saveSetting, type SettingChangeEntry, type SettingRow } from "@/lib/server/admin/settings";
import { Section } from "./parts";

const GROUPS: { id: "switches" | "ai" | "quotas"; keys: SettingKey[] }[] = [
  { id: "switches", keys: ["ai_enabled", "demo_enabled"] },
  { id: "ai", keys: ["ai_user_daily_usd", "ai_admin_daily_usd", "ai_demo_daily_usd", "ai_global_daily_usd", "ai_monthly_alert_usd"] },
  { id: "quotas", keys: ["aerodatabox_daily_units", "aerodatabox_min_remaining", "ors_daily_requests", "alert_errors_24h"] },
];
const KNOWN_ERRORS = ["forbidden", "invalid", "rate_limited"];

/** Admin-only runtime settings. Rows come from the admin-checked server page. */
export function SettingsSection({ settings, changes }: { settings: SettingRow[]; changes: SettingChangeEntry[] }) {
  const t = useTranslations("admin.settings");
  const f = useFormatter();
  const router = useRouter();
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [pending, start] = useTransition();
  const byKey = new Map(settings.map((s) => [s.key, s]));

  const show = (v: SettingValue | null) => (v === null ? t("noValue") : typeof v === "boolean" ? t(v ? "on" : "off") : f.number(v));

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) {
    setMsg(null);
    start(async () => {
      const r = await action();
      setMsg(r.ok ? { kind: "ok", text: done } : { kind: "error", text: t(`errors.${KNOWN_ERRORS.includes(r.error) ? r.error : "failed"}`) });
      router.refresh();
    });
  }
  const save = (key: SettingKey, value: SettingValue) => run(() => saveSetting({ key, value }), t("saved"));
  const reset = (key: SettingKey) => run(() => resetSetting({ key }), t("resetDone"));

  return (
    <Section id="admin-settings" title={t("title")}>
      <p className={mutedCls}>{t("intro")}</p>
      <div aria-live="polite">
        {msg && (
          <p
            role={msg.kind === "error" ? "alert" : "status"}
            className={
              msg.kind === "error"
                ? "rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg"
                : "rounded-lg border border-line bg-sunken p-3 text-sm text-ink"
            }
          >
            {msg.text}
          </p>
        )}
      </div>
      {GROUPS.map((g) => (
        <div key={g.id} className="flex flex-col gap-2">
          <h3 className="font-sans text-sm font-semibold text-heading">{t(`groups.${g.id}`)}</h3>
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {g.keys.map((key) => {
              const row = byKey.get(key);
              if (!row) return null;
              return <SettingItem key={key} row={row} pending={pending} show={show} onSave={save} onReset={reset} />;
            })}
          </ul>
        </div>
      ))}

      <h3 className="font-sans text-sm font-semibold text-heading">{t("changesTitle")}</h3>
      {changes.length === 0 ? (
        <p className={mutedCls}>{t("changesEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {changes.map((c, i) => (
            <li key={i} className="flex flex-wrap gap-x-3">
              <span className={mutedCls}>{f.dateTime(new Date(c.at), { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" })}</span>
              <span className="min-w-0">
                {t("changeLine", {
                  key: c.key in SETTING_DEFS ? t(`labels.${c.key as SettingKey}`) : c.key,
                  old: show(c.old),
                  new: show(c.new),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function SettingItem({
  row,
  pending,
  show,
  onSave,
  onReset,
}: {
  row: SettingRow;
  pending: boolean;
  show: (v: SettingValue | null) => string;
  onSave: (key: SettingKey, value: SettingValue) => void;
  onReset: (key: SettingKey) => void;
}) {
  const t = useTranslations("admin.settings");
  const id = useId();
  const def = SETTING_DEFS[row.key];
  const [draft, setDraft] = useState(String(row.value));
  const [seen, setSeen] = useState(row.value);
  if (seen !== row.value) {
    // follow the server value after a refresh
    setSeen(row.value);
    setDraft(String(row.value));
  }
  const num = draft.trim() === "" ? NaN : Number(draft);

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id={`${id}-l`} className="text-sm font-medium text-ink">
          {t(`labels.${row.key}`)}
        </p>
        <span className="flex flex-wrap items-center gap-2 text-xs">
          <span className={mutedCls}>
            {t("source")}: <span className={row.source === "admin" ? pillAccentCls : pillCls}>{t(`sources.${row.source}`)}</span>
          </span>
          {row.locked && <span className="inline-flex items-center rounded-full border border-danger-line bg-danger-bg px-3 py-0.5 font-medium text-danger-fg">{t("locked")}</span>}
        </span>
      </div>
      {row.locked ? (
        <p className={`${mutedCls} text-sm`}>
          {t("effective")}: <strong className="text-ink">{show(row.value)}</strong>. {t("lockedHint")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {def.kind === "bool" ? (
            <button
              type="button"
              role="switch"
              aria-checked={row.value === true}
              aria-labelledby={`${id}-l`}
              disabled={pending}
              onClick={() => onSave(row.key, row.value !== true)}
              className={`inline-flex min-h-11 min-w-24 items-center justify-center rounded-lg border-[1.5px] px-4 text-sm font-semibold disabled:opacity-50 ${focusCls} ${
                row.value === true ? "border-accent bg-accent text-white" : "border-heading text-heading"
              }`}
            >
              {show(row.value)}
            </button>
          ) : (
            <>
              <input
                type="number"
                inputMode="decimal"
                aria-labelledby={`${id}-l`}
                aria-describedby={`${id}-r`}
                min={def.min}
                max={def.max}
                step={def.kind === "usd" ? 0.01 : 1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className={`block min-h-11 w-32 rounded-lg border border-line-strong bg-card px-3 py-2 text-base text-ink ${focusCls}`}
              />
              <button
                type="button"
                className={btnPrimary}
                disabled={pending || !Number.isFinite(num) || num === row.value}
                onClick={() => onSave(row.key, num)}
              >
                {t("save")}
                <span className="sr-only"> {t(`labels.${row.key}`)}</span>
              </button>
            </>
          )}
          {row.source === "admin" && (
            <button type="button" className={btnSecondary} disabled={pending} onClick={() => onReset(row.key)}>
              {t("reset")}
              <span className="sr-only"> {t(`labels.${row.key}`)}</span>
            </button>
          )}
        </div>
      )}
      {def.kind !== "bool" && (
        <p id={`${id}-r`} className={`${mutedCls} text-xs`}>
          {t("effective")}: {show(row.value)}. {t("range", { min: def.min, max: def.max })}
        </p>
      )}
    </li>
  );
}
