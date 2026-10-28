import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SharedPlanView } from "@/components/share/shared-plan-view";
import { mutedCls } from "@/components/ui/styles";
import { clientIp } from "@/lib/server/client-ip";
import { getSharedPlanDocument } from "@/lib/server/plan-document";
import { rateLimit } from "@/lib/server/rate-limit";
import { hashShareToken, isShareTokenFormat } from "@/lib/server/share-token";

// Never cached: revoking or expiring a link must take effect at once.
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ locale: string; token: string }> };

/** One read per request: metadata and page share it (so a view is counted once). */
const load = cache(async (token: string) => {
  if (!isShareTokenFormat(token)) return { status: "missing" as const };
  const ip = clientIp(await headers());
  const byIp = ip ? rateLimit(`share-ip:${ip}`, 60, 60_000) : { ok: true };
  const byToken = rateLimit(`share-tok:${hashShareToken(token).slice(0, 16)}`, 120, 60_000);
  if (!byIp.ok || !byToken.ok) return { status: "limited" as const };
  const doc = await getSharedPlanDocument(token, "page");
  return doc ? { status: "ok" as const, doc } : { status: "missing" as const };
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, token } = await params;
  const t = await getTranslations({ locale, namespace: "shared" });
  const res = await load(token);
  return {
    title: res.status === "ok" ? res.doc.plan.header.title : t("metaTitle"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default async function SharedPlanPage({ params }: Props) {
  const { locale, token } = await params;
  setRequestLocale(locale);
  const res = await load(token);
  if (res.status === "missing") notFound();
  if (res.status === "limited") {
    const t = await getTranslations("shared");
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <p role="alert" className={mutedCls}>
          {t("rateLimited")}
        </p>
      </main>
    );
  }
  return (
    <main>
      <SharedPlanView doc={res.doc} token={token} uiLocale={locale} />
    </main>
  );
}
