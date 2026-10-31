"use client";

import { useFormatter, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { btnSecondary, mutedCls, pillAccentCls, pillCls } from "@/components/ui/styles";
import type { ActionError, AdminUserEntry } from "@/lib/domain";
import { deleteUserAsAdmin, disableUser, enableUser } from "@/lib/server/admin/users";
import { Section } from "./parts";

const KNOWN = ["forbidden", "invalid", "protected", "not_found"] as const;
type Pending = { kind: "disable" | "delete"; user: AdminUserEntry };

/** Admin-only user list. Account facts only (email, status, last sign-in); never trips, groups or plans. */
export function UsersSection({ entries }: { entries: AdminUserEntry[] }) {
  const t = useTranslations("admin.users");
  const f = useFormatter();
  const router = useRouter();
  const [confirm, setConfirm] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const errorText = (e: ActionError) => t(`errors.${(KNOWN as readonly string[]).includes(e) ? e : "failed"}`);

  function run(action: (i: { userId: string }) => Promise<{ ok: boolean; error?: ActionError }>, user: AdminUserEntry) {
    setError(null);
    start(async () => {
      const r = await action({ userId: user.id });
      setConfirm(null);
      if (!r.ok && r.error) setError(errorText(r.error));
      router.refresh();
    });
  }

  return (
    <Section id="admin-users" title={t("title")}>
      <p className={mutedCls}>{t("intro")}</p>
      <div aria-live="polite">
        {error && (
          <p role="alert" className="rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg">
            {error}
          </p>
        )}
      </div>
      {entries.length === 0 ? (
        <p className={mutedCls}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {entries.map((u) => (
            <li key={u.id} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="break-all text-sm font-medium text-ink">{u.email}</p>
                <p className={`${mutedCls} text-xs`}>
                  {t("lastSignIn")}:{" "}
                  {u.lastSignInAt
                    ? f.dateTime(new Date(u.lastSignInAt), { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" })
                    : t("never")}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={u.status === "disabled" ? pillCls : pillAccentCls}>{t(u.status)}</span>
                {u.isSelf && <span className={pillCls}>{t("you")}</span>}
                {u.isAdmin && !u.isSelf && <span className={pillCls}>{t("admin")}</span>}
                {u.isDemo && <span className={pillCls}>{t("demo")}</span>}
                {u.manageable && (
                  <>
                    {u.status === "disabled" ? (
                      <button type="button" className={btnSecondary} disabled={pending} onClick={() => run(enableUser, u)}>
                        {t("enable")}
                        <span className="sr-only"> {u.email}</span>
                      </button>
                    ) : (
                      <button type="button" className={btnSecondary} disabled={pending} onClick={() => setConfirm({ kind: "disable", user: u })}>
                        {t("disable")}
                        <span className="sr-only"> {u.email}</span>
                      </button>
                    )}
                    <button type="button" className={btnSecondary} disabled={pending} onClick={() => setConfirm({ kind: "delete", user: u })}>
                      {t("delete")}
                      <span className="sr-only"> {u.email}</span>
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "delete" ? t("deleteTitle") : t("disableTitle")}
        description={confirm?.kind === "delete" ? t("deleteBody") : t("disableBody")}
        confirmLabel={confirm?.kind === "delete" ? t("delete") : t("disable")}
        cancelLabel={t("cancel")}
        pending={pending}
        onConfirm={() => confirm && run(confirm.kind === "delete" ? deleteUserAsAdmin : disableUser, confirm.user)}
        onCancel={() => setConfirm(null)}
      >
        {confirm && <p className="break-all text-sm font-medium">{confirm.user.email}</p>}
      </ConfirmDialog>
    </Section>
  );
}
