import { useTranslations } from "next-intl";

/** Shown while a signed-in page loads on the server (navigation inside the shell). Motion only if allowed. */
export default function AppLoading() {
  const t = useTranslations("errorPage");
  return (
    <main aria-busy="true" className="flex w-full flex-col gap-4 py-4">
      <p role="status" className="sr-only">
        {t("loading")}
      </p>
      <div aria-hidden="true" className="flex flex-col gap-4 motion-safe:animate-pulse">
        <div className="h-9 w-2/3 max-w-sm rounded-lg bg-sunken" />
        <div className="h-24 rounded-[14px] border border-line bg-card" />
        <div className="h-24 rounded-[14px] border border-line bg-card" />
      </div>
    </main>
  );
}
