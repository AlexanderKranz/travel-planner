import { getTranslations, setRequestLocale } from "next-intl/server";
import { DemoLogin } from "@/components/auth/demo-login";
import { isDemoEnabled } from "@/lib/server/demo";
import { LoginForm } from "@/components/auth/login-form";
import { Link } from "@/i18n/navigation";
import { linkCls } from "@/components/ui/styles";

export default async function LoginPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { locale } = await params;
  const { error } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("login");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-12">
      <h1 className="text-3xl font-bold">{t("title")}</h1>
      <LoginForm linkInvalid={error === "link_invalid"} />
      {isDemoEnabled() && <DemoLogin />}
      <Link href="/" className={`text-sm ${linkCls}`}>
        {t("home")}
      </Link>
    </main>
  );
}
