import { redirect } from "@/i18n/navigation";

/** The trips list lives at /app; keep old links and bookmarks working. */
export default async function TripsRedirectPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  redirect({ href: "/app", locale });
}
