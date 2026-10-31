"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ErrorBanner } from "@/components/ui/error-banner";
import { SelectField, TextField } from "@/components/ui/fields";
import { errorAt, type Issue } from "@/components/ui/issues";
import { btnPrimary } from "@/components/ui/styles";
import { usePathname, useRouter } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import type { ActionError, Profile } from "@/lib/domain";
import { updateProfile } from "@/lib/server/profile";
import { AirportPicker } from "./airport-picker";
import { HomeLocationPicker, type HomeLocation } from "./home-location-picker";

export function SettingsForm({ profile }: { profile: Profile }) {
  const t = useTranslations("settings");
  const currentLocale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const [displayName, setDisplayName] = useState(profile.displayName ?? "");
  const [locale, setLocale] = useState<string>(profile.locale);
  const [birthdate, setBirthdate] = useState(profile.birthdate ?? "");
  const [airports, setAirports] = useState(profile.homeAirports);
  const [home, setHome] = useState<HomeLocation | null>(
    profile.homeLocation && profile.homeTimezone ? { name: profile.homeLocation, timezone: profile.homeTimezone } : null,
  );
  const [error, setError] = useState<ActionError | null>(null);
  const [issues, setIssues] = useState<Issue[]>();
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const bad = t("fieldInvalid");

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
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <TextField
        label={t("displayName")}
        value={displayName}
        maxLength={80}
        autoComplete="name"
        onChange={(e) => setDisplayName(e.target.value)}
        error={errorAt(issues, "displayName", bad)}
      />
      <SelectField
        label={t("language")}
        value={locale}
        onChange={(e) => setLocale(e.target.value)}
        error={errorAt(issues, "locale", bad)}
      >
        {routing.locales.map((l) => (
          <option key={l} value={l} lang={l}>
            {t(`languages.${l}`)}
          </option>
        ))}
      </SelectField>
      <TextField
        label={t("birthdate")}
        hint={t("birthdateHint")}
        type="date"
        min="1900-01-01"
        autoComplete="bday"
        value={birthdate}
        onChange={(e) => setBirthdate(e.target.value)}
        error={errorAt(issues, "birthdate", bad)}
      />
      <AirportPicker
        value={airports}
        onChange={setAirports}
        error={
          error === "unknown_airport"
            ? t("airports.unknown")
            : errorAt(issues, "homeAirports", bad)
        }
      />
      <HomeLocationPicker value={home} onChange={setHome} error={errorAt(issues, "homeLocation", bad)} />
      <ErrorBanner error={error === "unknown_airport" ? null : error} />
      {saved && (
        <p role="status" className="text-sm text-ok">
          {t("saved")}
        </p>
      )}
      <div>
        <button type="submit" className={btnPrimary} disabled={pending}>
          {t("save")}
        </button>
      </div>
    </form>
  );
}
