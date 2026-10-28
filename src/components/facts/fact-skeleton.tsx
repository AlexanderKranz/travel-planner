import { useTranslations } from "next-intl";

export function FactSkeleton() {
  const t = useTranslations("facts");
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      <span className="sr-only">{t("loading")}</span>
      <div aria-hidden="true" className="h-4 w-3/4 animate-pulse rounded bg-sunken" />
      <div aria-hidden="true" className="h-4 w-full animate-pulse rounded bg-sunken" />
      <div aria-hidden="true" className="h-4 w-2/3 animate-pulse rounded bg-sunken" />
    </div>
  );
}
