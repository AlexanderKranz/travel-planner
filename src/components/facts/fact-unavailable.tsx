import { useTranslations } from "next-intl";
import type { Fact } from "@/lib/domain";
import { mutedCls } from "@/components/ui/styles";

type Unavailable = Extract<Fact<unknown>, { status: "unavailable" }>;

/** Explains why a fact block is empty; never shows made-up content. */
export function FactUnavailable({ fact }: { fact: Unavailable }) {
  const t = useTranslations("facts.unavailable");
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>{t(fact.reason)}</p>
      <p className={mutedCls}>{t(`${fact.reason}Hint`)}</p>
    </div>
  );
}
