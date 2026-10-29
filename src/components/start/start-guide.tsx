import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { btnPrimary, cardCls, eyebrowCls, linkCls, mutedCls, pillAccentCls, pillCls } from "@/components/ui/styles";
import { deriveSteps, doneCount, ONBOARDING_STEPS, type OnboardingFacts, type OnboardingStep } from "@/lib/onboarding";
import { AboutForm } from "./about-form";
import { FinishButton } from "./finish-button";
import { GroupForm } from "./group-form";
import { PurposeForm } from "./purpose-form";
import { StepToggle } from "./step-toggle";

function Examples({ title, items }: { title: string; items: string[] }) {
  return (
    <figure className="rounded-lg border-l-4 border-accent bg-sunken px-4 py-3">
      <figcaption className="text-xs font-semibold uppercase tracking-[0.12em] text-subtle">{title}</figcaption>
      <ul className="mt-1 flex flex-col gap-1 font-serif text-base italic text-ink">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </figure>
  );
}

/** The getting-started page body. Pure rendering from facts, so it can be previewed with mock data. */
export async function StartGuide({ facts, displayName }: { facts: OnboardingFacts; displayName: string | null }) {
  const t = await getTranslations("start");
  const steps = deriveSteps(facts);
  const done = doneCount(steps);
  const total = ONBOARDING_STEPS.length;
  const summary = t("progress.summary", { done, total });

  const card = (step: OnboardingStep, index: number, title: string, children: React.ReactNode) => (
    <li key={step}>
      <section className={`${cardCls} flex flex-col gap-4`} aria-labelledby={`start-${step}`}>
        <div className="flex items-start gap-4">
          <span aria-hidden className="font-serif text-5xl font-bold leading-none text-accent-text">
            {index + 1}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h2 id={`start-${step}`} className="font-serif text-2xl font-bold sm:text-3xl">
                {title}
              </h2>
              <span className={steps[step] ? pillAccentCls : pillCls}>
                {steps[step] ? t("status.done") : t("status.open")}
              </span>
            </div>
          </div>
        </div>
        {children}
      </section>
    </li>
  );

  return (
    <main className="flex flex-col gap-6">
      <header className="flex flex-col gap-3">
        <p className={eyebrowCls}>{t("eyebrow")}</p>
        <h1 className="break-words font-serif text-4xl font-bold leading-[1.05] sm:text-5xl">
          {displayName ? `${t("title")}, ${displayName}` : t("title")}
        </h1>
        <p className="max-w-3xl font-serif text-lg leading-relaxed text-muted sm:text-xl">{t("lead")}</p>
        <div className="flex flex-col gap-2">
          <div
            role="progressbar"
            aria-label={t("progress.label")}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={done}
            aria-valuetext={summary}
            className="grid grid-cols-4 gap-1.5"
          >
            {ONBOARDING_STEPS.map((s) => (
              <span key={s} className={`h-2 rounded-full ${steps[s] ? "bg-accent" : "bg-line-strong/50"}`} />
            ))}
          </div>
          <p role="status" className={`text-sm ${mutedCls}`}>
            {summary}
          </p>
        </div>
        <div>
          <FinishButton variant="skip" />
        </div>
      </header>

      <ol className="flex flex-col gap-4">
        {card(
          "about",
          0,
          t("about.title"),
          <StepToggle
            defaultOpen={!steps.about}
            closedLabel={steps.about ? t("about.edit") : t("fillIn")}
            closedNote={steps.about ? t("about.done") : t("skippedNote")}
          >
            <AboutForm airports={[...facts.homeAirports]} birthdate={facts.birthdate} />
          </StepToggle>,
        )}
        {card(
          "group",
          1,
          t("group.title"),
          <>
            <p>{t("group.why")}</p>
            <Examples title={t("group.examples")} items={[t("group.example1"), t("group.example2")]} />
            <StepToggle
              defaultOpen={!steps.group}
              closedLabel={steps.group ? t("group.another") : t("fillIn")}
              closedNote={steps.group ? t("group.doneExisting") : t("skippedNote")}
            >
              <GroupForm />
            </StepToggle>
            {steps.group && (
              <Link href="/app/groups" className={`${linkCls} inline-flex min-h-11 items-center self-start`}>
                {t("group.manage")}
              </Link>
            )}
          </>,
        )}
        {card(
          "purpose",
          2,
          t("purpose.title"),
          <>
            <p>{t("purpose.why")}</p>
            <Examples title={t("purpose.examples")} items={[t("purpose.example1"), t("purpose.example2")]} />
            <StepToggle
              defaultOpen={!steps.purpose}
              closedLabel={steps.purpose ? t("purpose.another") : t("fillIn")}
              closedNote={steps.purpose ? t("purpose.doneExisting") : t("skippedNote")}
            >
              <PurposeForm />
            </StepToggle>
            {steps.purpose && (
              <Link href="/app/purposes" className={`${linkCls} inline-flex min-h-11 items-center self-start`}>
                {t("purpose.manage")}
              </Link>
            )}
          </>,
        )}
        {card(
          "trip",
          3,
          t("trip.title"),
          <>
            <p>{t("trip.why")}</p>
            {steps.trip && <p className={`text-sm ${mutedCls}`}>{t("trip.done")}</p>}
            <div className="flex flex-wrap gap-3">
              <Link href="/app/trips/new" className={btnPrimary}>
                {t("trip.button")}
              </Link>
            </div>
          </>,
        )}
      </ol>

      <footer className="flex flex-col items-start gap-2 border-t border-line pt-5">
        <FinishButton variant="finish" />
        <p className={`text-sm ${mutedCls}`}>{t("finishHint")}</p>
      </footer>
    </main>
  );
}
