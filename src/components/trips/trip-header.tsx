"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnDanger, btnSecondary, mutedCls } from "@/components/ui/styles";
import { Link, useRouter } from "@/i18n/navigation";
import type { ActionError, Trip } from "@/lib/domain";
import { deleteTrip } from "@/lib/server/trips";
import { timingLabel, tripTitle } from "./trip-title";

export function TripHeader({ trip }: { trip: Trip }) {
  const t = useTranslations("trips");
  const locale = useLocale();
  const router = useRouter();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<ActionError | null>(null);
  const [pending, start] = useTransition();
  const title = tripTitle(trip, t, locale);
  const d = trip.destination;
  const place = d.kind === "freetext" ? null : [d.placeName, d.admin1].filter(Boolean).join(", ");

  function onDelete() {
    start(async () => {
      const result = await deleteTrip(trip.id);
      if (result.ok) {
        router.push("/app/trips");
        router.refresh();
      } else {
        setConfirm(false);
        setError(result.error);
      }
    });
  }

  return (
    <header className="flex flex-col gap-3">
      <Link href="/app/trips" className="inline-flex min-h-11 items-center text-sm underline underline-offset-2">
        {t("back")}
      </Link>
      <h1 className="break-words text-2xl font-bold">{title}</h1>
      <p className={mutedCls}>
        {d.name}
        {place && place !== d.name ? ` (${place})` : ""}
        {" · "}
        {timingLabel(trip.timing, locale, t)}
        {" · "}
        {t("days", { count: trip.lengthDays })}
        {d.kind === "region" ? ` · ${t("detail.radius", { km: d.radiusKm })}` : ""}
      </p>
      <ErrorBanner error={error} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href={`/app/trips/${trip.id}/edit`} className={btnSecondary}>
          {t("edit")}
        </Link>
        <button type="button" className={btnDanger} onClick={() => setConfirm(true)}>
          {t("delete")}
        </button>
      </div>
      <ConfirmDialog
        open={confirm}
        title={t("deleteTitle")}
        description={t("deleteBody", { name: title })}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        pending={pending}
        onConfirm={onDelete}
        onCancel={() => setConfirm(false)}
      />
    </header>
  );
}
