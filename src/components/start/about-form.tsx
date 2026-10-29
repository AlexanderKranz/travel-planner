"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { AirportPicker } from "@/components/settings/airport-picker";
import { ErrorBanner } from "@/components/ui/error-banner";
import { TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnPrimary, linkCls, mutedCls } from "@/components/ui/styles";
import { Link, useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import { updateProfile } from "@/lib/server/profile";

/** Step 1: home airports and birthdate, saved with the same action as the settings form. */
export function AboutForm({ airports: initialAirports, birthdate: initialBirthdate }: { airports: string[]; birthdate: string | null }) {
  const t = useTranslations("start.about");
  const ts = useTranslations("settings");
  const router = useRouter();
  const [airports, setAirports] = useState(initialAirports);
  const [birthdate, setBirthdate] = useState(initialBirthdate ?? "");
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    setSaved(false);
    start(async () => {
      const result = await updateProfile({ homeAirports: airports, birthdate: birthdate === "" ? null : birthdate });
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <p className={mutedCls}>{t("airportsWhy")}</p>
      <AirportPicker
        value={airports}
        onChange={setAirports}
        error={error === "unknown_airport" ? ts("airports.unknown") : errorAt(issues, "homeAirports", ts("fieldInvalid"))}
      />
      <p className={mutedCls}>{t("birthdateWhy")}</p>
      <TextField
        label={ts("birthdate")}
        type="date"
        min="1900-01-01"
        autoComplete="bday"
        value={birthdate}
        onChange={(e) => setBirthdate(e.target.value)}
        error={errorAt(issues, "birthdate", ts("fieldInvalid"))}
      />
      <ErrorBanner error={error === "unknown_airport" ? null : error} />
      {saved && (
        <p role="status" className="text-sm text-ok">
          {t("done")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <button type="submit" className={btnPrimary} disabled={pending}>
          {t("save")}
        </button>
        <Link href="/settings" className={`${linkCls} inline-flex min-h-11 items-center`}>
          {t("settings")}
        </Link>
      </div>
    </form>
  );
}
