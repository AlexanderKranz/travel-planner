/** "Costa del Sol", 2027-03-13 -> "costa-del-sol-2027-03-13.pdf" (ASCII only). */
export function pdfFileName(plan: {
  header: { title: string; destination: string; timing: { kind: string; startDate?: string } };
}): string {
  const base = plan.header.title.trim() || plan.header.destination || "trip";
  const slug = base
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const date = plan.header.timing.kind === "date" ? plan.header.timing.startDate : undefined;
  return `${[slug || "trip", date].filter(Boolean).join("-")}.pdf`;
}
