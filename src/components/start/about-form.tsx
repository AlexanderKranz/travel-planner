"use client";

import { ClientForm } from "@/components/ui/client-form";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { AirportPicker } from "@/components/settings/airport-picker";
import { HomeLocationPicker, type HomeLocation } from "@/components/settings/home-location-picker";
import { HomeSuggestionButton } from "@/components/settings/home-suggestion";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SelectField, TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnPrimary, linkCls, mutedCls } from "@/components/ui/styles";
import { Link, usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import type { ActionError, Profile } from "@/lib/domain";
import { updateProfile } from "@/lib/server/profile";

export type AboutValues = Pick<Profile, "displayName" | "locale" | "homeAirports" | "birthdate"> & { home: HomeLocation | null };

/** Step 1: name, language, home airports, home place and birthdate, saved with the same action as the settings form. */
export function AboutForm({ initial }: { initial: AboutValues }) {
  const t = useTranslations("start.about");
  const ts = useTranslations("settings");
  const currentLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState(initial.displayName ?? "");
  const [locale, setLocale] = useState<string>(initial.locale);
  const [airports, setAirports] = useState(initial.homeAirports);
  const [home, setHome] = useState<HomeLocation | null>(initial.home);
  const [birthdate, setBirthdate] = useState(initial.birthdate ?? "");
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const bad = ts("fieldInvalid");

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIssues(undefined);
    setSaved(false);
    start(async () => {
      const result = await updateProfile({
        displayName,
        locale: locale as Profile["locale"],
        homeAirports: airports,
        birthdate: birthdate === "" ? null : birthdate,
        homeLocation: home?.name ?? null,
        homeTimezone: home?.timezone ?? null,
        homeGeoId: home?.geoId ?? null,
      });
      if (!result.ok) {
        setError(result.error);
        setIssues(result.issues);
        return;
      }
      setSaved(true);
      if (result.data.locale !== currentLocale) {
        router.replace(pathname, { locale: result.data.locale });
      } else {
        router.refresh();
      }
    });
  }

  return (
    <ClientForm onSubmit={onSubmit} className="flex flex-col gap-5">
      <TextField
        hint={t("nameWhy")}
        label={ts("displayName")}
        value={displayName}
        maxLength={80}
        autoComplete="name"
        onChange={(e) => setDisplayName(e.target.value)}
        error={errorAt(issues, "displayName", bad)}
      />
      <SelectField
        hint={t("languageWhy")}
        label={ts("language")}
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        error={errorAt(issues, "locale", bad)}
      >
        {routing.locales.map((l) => (
          <option key={l} value={l} lang={l}>
            {ts(`languages.${l}`)}
          </option>
        ))}
      </SelectField>
      <div className="flex flex-col gap-2">
        <p className={`text-sm ${mutedCls}`}>{t("airportsWhy")}</p>
        <AirportPicker
          value={airports}
          onChange={setAirports}
          error={error === "unknown_airport" ? ts("airports.unknown") : errorAt(issues, "homeAirports", bad)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <p className={`text-sm ${mutedCls}`}>{t("homeWhy")}</p>
        <HomeSuggestionButton airports={airports} home={home} onAccept={setHome} />
        <HomeLocationPicker value={home} onChange={setHome} error={errorAt(issues, "homeLocation", bad)} />
      </div>
      <TextField
        hint={t("birthdateWhy")}
        label={ts("birthdate")}
        type="date"
        min="1900-01-01"
        autoComplete="bday"
        value={birthdate}
        onChange={(e) => setBirthdate(e.target.value)}
        error={errorAt(issues, "birthdate", bad)}
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
    </ClientForm>
  );
}
