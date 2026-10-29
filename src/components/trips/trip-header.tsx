"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ErrorBanner } from "@/components/ui/error-banner";
import { btnDanger, btnPrimary, eyebrowCls, linkCls } from "@/components/ui/styles";
import { Link, useRouter } from "@/i18n/navigation";
import type { ActionError, Trip } from "@/lib/domain";
import { deleteTrip } from "@/lib/server/trips";
import { timingLabel, tripTitle } from "./trip-title";

export function TripHeader({
  trip,
  purposeName,
  pills,
}: {
  trip: Trip;
  purposeName: string | null;
  /** Server-rendered pills (length, group, radius). */
  pills: React.ReactNode;
}) {
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

  const eyebrow = [purposeName, timingLabel(trip.timing, locale, t)].filter(Boolean).join(" · ");
  return (
    <header className="flex flex-col gap-3 border-b border-line pb-8" data-print-block>
      <Link href="/app/trips" className={`${linkCls} inline-flex min-h-11 items-center self-start text-sm`}>
        {t("back")}
      </Link>
      <p className={eyebrowCls}>{eyebrow}</p>
      <h1 className="break-words font-serif text-4xl font-bold leading-[1.05] sm:text-5xl lg:text-6xl">{title}</h1>
      <p className="max-w-3xl font-serif text-lg leading-relaxed text-muted sm:text-xl">
        {d.name}
        {place && place !== d.name ? ` (${place})` : ""}
      </p>
      {pills}
      <ErrorBanner error={error} />
      <div className="mt-1 flex flex-col gap-2 sm:flex-row" data-no-print>
        <Link href={`/app/trips/${trip.id}/edit`} className={btnPrimary}>
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
