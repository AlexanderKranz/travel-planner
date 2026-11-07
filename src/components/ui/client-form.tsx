"use client";

import { useEffect, useRef, type FormHTMLAttributes } from "react";
import { useHydrated } from "@/lib/hooks/use-hydrated";

type Props = FormHTMLAttributes<HTMLFormElement> & {
  /**
   * `all` (default): every control is disabled until hydration.
   * `submit`: fields stay enabled (password managers can fill them); the form's submit buttons must be
   * disabled by the caller with `useHydrated()`. Implicit submission (Enter) is skipped by browsers while the
   * default submit button is disabled, so nothing submits natively either way.
   */
  gate?: "all" | "submit";
};

/**
 * Form for submit handlers that run in JS (onSubmit + preventDefault, server actions called from code).
 * Before hydration there is no handler, so a click or Enter would submit natively and reload the page
 * (with the field values in the URL). The fieldset uses `display: contents`, so layout does not change and
 * assistive tech announces the disabled state. Elements marked `data-autofocus` get focus once the form is enabled
 * (React's `autoFocus` cannot focus a disabled control).
 */
export function ClientForm({ children, gate = "all", ...props }: Props) {
  const hydrated = useHydrated();
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!hydrated) return;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [hydrated]);
  return (
    <form {...props} ref={ref} data-hydrated={hydrated}>
      <fieldset disabled={gate === "all" && !hydrated} className="contents min-w-0 border-0 p-0">
        {children}
      </fieldset>
    </form>
  );
}
