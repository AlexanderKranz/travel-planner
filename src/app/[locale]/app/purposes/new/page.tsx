import { getTranslations, setRequestLocale } from "next-intl/server";
import { PurposeEditor } from "@/components/purposes/purpose-editor";

export default async function NewPurposePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("purposes");
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("newTitle")}</h1>
      <PurposeEditor />
    </main>
  );
}
