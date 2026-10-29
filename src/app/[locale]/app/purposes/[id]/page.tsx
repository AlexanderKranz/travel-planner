import { getTranslations, setRequestLocale } from "next-intl/server";
import { PurposeEditor } from "@/components/purposes/purpose-editor";
import { getPurpose } from "@/lib/server/purposes";
import { unwrap } from "@/lib/unwrap";

export default async function EditPurposePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("purposes");
  const purpose = unwrap(await getPurpose(id), locale);
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("editTitle")}</h1>
      <PurposeEditor purpose={purpose} />
    </main>
  );
}
