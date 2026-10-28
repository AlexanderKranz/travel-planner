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
  const tn = await getTranslations("nav");

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center gap-6 px-4 py-12">
      <Link href="/" className={`self-start font-serif text-xl font-bold tracking-wide ${linkCls} no-underline`}>
        {tn("appName")}
      </Link>
      <div className="flex flex-col gap-6 rounded-[14px] border border-line bg-card p-5 sm:p-8">
        <h1 className="text-3xl font-bold sm:text-4xl">{t("title")}</h1>
        <LoginForm linkInvalid={error === "link_invalid"} />
        {isDemoEnabled() && <DemoLogin />}
      </div>
      <Link href="/" className={`text-sm ${linkCls}`}>
        {t("home")}
      </Link>
    </main>
  );
}
