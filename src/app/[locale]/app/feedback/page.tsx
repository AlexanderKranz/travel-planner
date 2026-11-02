import type { Metadata } from "next";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { FeedbackForm } from "@/components/feedback/feedback-form";
import { MyReports } from "@/components/feedback/my-reports";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { parseKind, safeFromPath } from "@/lib/feedback-client";
import { listMyFeedback } from "@/lib/server/feedback/mine";
import { getProfile } from "@/lib/server/profile";
import { getSetting } from "@/lib/server/settings";
import { unwrap } from "@/lib/unwrap";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "feedback" });
  return { title: t("title") };
}

export default async function FeedbackPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ from?: string | string[]; kind?: string | string[] }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("feedback");
  const profile = unwrap(await getProfile(), locale);

  if (profile.isDemo) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <p role="status" className={`${cardCls} ${mutedCls}`}>
          {t("demoNote")}
        </p>
        <Link href="/app" className={`${linkCls} inline-flex min-h-11 items-center self-start`}>
          {t("back")}
        </Link>
      </main>
    );
  }

  const [limit, mine] = await Promise.all([getSetting("feedback_user_daily"), listMyFeedback()]);
  const closed = Number(limit.value) === 0;

  return (
    <main className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <p className={mutedCls}>{t("intro")}</p>
      </div>
      {closed ? (
        <p role="status" className={`${cardCls} ${mutedCls}`}>
          {t("closed")}
        </p>
      ) : (
        <>
          <p className="rounded-lg border border-warn-line bg-warn-bg p-3 text-sm text-warn-fg">{t("notice")}</p>
          <FeedbackForm initialKind={parseKind(sp.kind)} from={safeFromPath(sp.from)} />
        </>
      )}
      <MyReports items={mine} />
    </main>
  );
}
