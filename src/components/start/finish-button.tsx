"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { btnGhost, btnPrimary, focusCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import { markOnboardingDone } from "@/lib/server/profile";

/** Finishing and skipping both set profiles.onboarding_done_at and continue to the trips list. */
export function FinishButton({ variant }: { variant: "finish" | "skip" }) {
  const t = useTranslations("start");
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();

  function onClick() {
    setFailed(false);
    start(async () => {
      const result = await markOnboardingDone();
      if (!result.ok) {
        setFailed(true);
        return;
      }
      router.push("/app");
    });
  }

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        className={variant === "finish" ? btnPrimary : `${btnGhost} text-muted underline underline-offset-2 hover:text-heading ${focusCls}`}
      >
        {variant === "finish" ? t("finish") : t("skipAll")}
      </button>
      {failed && (
        <span role="alert" className="text-sm text-danger">
          {t("failed")}
        </span>
      )}
    </span>
  );
}
