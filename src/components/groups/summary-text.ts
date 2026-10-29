import { useTranslations } from "next-intl";
import { summaryFacts, type ResolvedGroup } from "@/lib/group-text";

/** "5 adults, about 46" for a resolved group (empty string when no people are known). */
export function useGroupSummaryText(): (r: ResolvedGroup) => string {
  const t = useTranslations("groups.summary");
  return (r) => {
    const { counts, age } = summaryFacts(r);
    const parts: string[] = [];
    if (counts.adults > 0) parts.push(t("adults", { count: counts.adults }));
    if (counts.children > 0) parts.push(t("children", { count: counts.children }));
    if (counts.toddlers > 0) parts.push(t("toddlers", { count: counts.toddlers }));
    if (counts.unknown > 0) parts.push(t("unknown", { count: counts.unknown }));
    if (age.kind === "aboutMe") parts.push(t("ageAboutMe"));
    else if (age.kind === "known") {
      const range = age.min !== age.max;
      parts.push(
        age.approx
          ? range
            ? t("ageApproxRange", { min: age.min, max: age.max })
            : t("ageApprox", { age: age.min })
          : range
            ? t("ageExactRange", { min: age.min, max: age.max })
            : t("ageExact", { age: age.min }),
      );
    }
    return parts.join(", ");
  };
}
