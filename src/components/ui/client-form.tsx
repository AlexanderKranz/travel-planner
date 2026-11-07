"use client";

import type { FormHTMLAttributes } from "react";
import { useHydrated } from "@/lib/hooks/use-hydrated";

/**
 * Form for submit handlers that run in JS (onSubmit + preventDefault, server actions called from code).
 * Before hydration there is no handler, so a click or Enter would submit natively and reload the page
 * (with the field values in the URL). Every control is disabled until React has hydrated; the fieldset
 * uses `display: contents`, so layout does not change and assistive tech announces the disabled state.
 */
export function ClientForm({ children, ...props }: FormHTMLAttributes<HTMLFormElement>) {
  const hydrated = useHydrated();
  return (
    <form {...props}>
      <fieldset disabled={!hydrated} className="contents min-w-0 border-0 p-0" data-hydrated={hydrated}>
        {children}
      </fieldset>
    </form>
  );
}
