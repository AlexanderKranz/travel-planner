import { useTranslations } from "next-intl";
import { cardCls, mutedCls } from "@/components/ui/styles";

export function DemoDeleteNote() {
  const t = useTranslations("settings.delete");
  return (
    <section aria-labelledby="delete-title" className={`${cardCls} flex flex-col gap-2`}>
      <h2 id="delete-title" className="font-semibold">
        {t("title")}
      </h2>
      <p className={`text-sm ${mutedCls}`}>{t("demoUnavailable")}</p>
    </section>
  );
}
