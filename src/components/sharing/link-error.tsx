"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import type { ActionError } from "@/lib/domain";
import { shareErrorKey } from "./helpers";

/**
 * The last failed link action. Kept outside the buttons on purpose: after `already_*` the page is refreshed, the fresh data
 * offers no button on that entry any more, and a message held by the button would vanish with it. One alert per page
 * (`LinkErrorAlert`) shows it; the next action clears it.
 */
let current: ActionError | null = null;
const listeners = new Set<() => void>();

export function setLinkError(error: ActionError | null) {
  current = error;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function LinkErrorAlert() {
  const t = useTranslations("sharing");
  const error = useSyncExternalStore(subscribe, () => current, () => null);
  // Leaving the page drops the message; a refresh keeps the component mounted and so keeps it.
  useEffect(() => () => setLinkError(null), []);
  if (!error) return null;
  return (
    <p role="alert" className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
      {t(`errors.${shareErrorKey(error)}`, { max: 0 })}
    </p>
  );
}
