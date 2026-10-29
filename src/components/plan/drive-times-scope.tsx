"use client";

import { useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

const KEY = "tp.showDriveTimes";
const EVENT = "tp:drive-times";

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

function write(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // private mode / storage disabled: the choice lasts until reload
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Drive times are hidden by default and shown on request (spec timed-items [D13]). The choice is per viewer
 * (localStorage). Server-rendered day cards stay server components: this wrapper only sets `data-drive` and the
 * drive badges/credit are shown with `group-data-[drive=on]/plan:` classes. Server render = off.
 */
export function DriveTimesScope({
  hasDrive,
  className,
  header,
  children,
}: {
  hasDrive: boolean;
  className?: string;
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useTranslations("plan");
  const on = useSyncExternalStore(subscribe, read, () => false);
  return (
    <div className={`group/plan ${className ?? ""}`} data-drive={on ? "on" : "off"}>
      {header}
      {hasDrive && (
        <label className="flex min-h-11 items-center gap-2 self-start text-sm">
          <input type="checkbox" className="size-4 accent-blue-700" checked={on} onChange={(e) => write(e.target.checked)} />
          {t("showDrive")}
        </label>
      )}
      {children}
    </div>
  );
}
