"use client";

import { useTranslations } from "next-intl";
import type { ActionError } from "@/lib/domain";
import { btnSecondary } from "@/components/ui/styles";

/** Error of a tour action: the tour wording when there is one (`tours.errors.*`), else the general one. */
export function TourError({ error, onReload }: { error: ActionError | null; onReload?: () => void }) {
  const t = useTranslations("tours");
  const general = useTranslations("errors");
  if (!error) return null;
  const text = t.has(`errors.${error}`) ? t(`errors.${error}`) : general(error);
  return (
    <div role="alert" className="flex flex-col gap-2 rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg" data-testid="tour-error">
      <p>{text}</p>
      {error === "conflict" && onReload && (
        <button type="button" className={`${btnSecondary} self-start`} onClick={onReload}>
          {t("reload")}
        </button>
      )}
    </div>
  );
}
