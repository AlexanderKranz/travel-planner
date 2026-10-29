"use client";

import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TextField } from "@/components/ui/fields";
import { btnPrimary, btnSecondary, mutedCls, pillAccentCls, pillCls } from "@/components/ui/styles";
import type { ActionError, InviteEntry } from "@/lib/domain";
import { inviteUser, revokeInvite } from "@/lib/server/admin/invites";
import { Section } from "./parts";

const KNOWN = ["forbidden", "invalid", "rate_limited", "already_member", "email_failed", "conflict", "not_found"] as const;

/** Admin-only invite form and list. The entries come from the server page (admin-checked); emails are fine here. */
export function InvitesSection({ entries }: { entries: InviteEntry[] }) {
  const t = useTranslations("admin.invites");
  const f = useFormatter();
  const locale = useLocale();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [revoking, setRevoking] = useState<InviteEntry | null>(null);
  const [pending, start] = useTransition();

  const errorText = (e: ActionError) => t(`errors.${(KNOWN as readonly string[]).includes(e) ? e : "failed"}`);

  function onInvite(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    start(async () => {
      const r = await inviteUser({ email, locale });
      if (r.ok) {
        setMsg({ kind: "ok", text: t("sent") });
        setEmail("");
      } else {
        setMsg({ kind: "error", text: errorText(r.error) });
      }
      router.refresh(); // an email-failed invite is still on the list
    });
  }

  function onRevoke() {
    if (!revoking) return;
    const target = revoking;
    start(async () => {
      const r = await revokeInvite({ id: target.id });
      setRevoking(null);
      setMsg(r.ok ? null : { kind: "error", text: errorText(r.error) });
      router.refresh();
    });
  }

  return (
    <Section id="admin-invites" title={t("title")}>
      <p className={mutedCls}>{t("intro")}</p>
      <form onSubmit={onInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <TextField
            label={t("emailLabel")}
            type="email"
            name="invite-email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
            required
          />
        </div>
        <button type="submit" className={btnPrimary} disabled={pending || !email}>
          {t("submit")}
        </button>
      </form>
      <div aria-live="polite">
        {msg && (
          <p
            role={msg.kind === "error" ? "alert" : "status"}
            className={
              msg.kind === "error"
                ? "rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg"
                : "rounded-lg border border-line bg-sunken p-3 text-sm text-ink"
            }
          >
            {msg.text}
          </p>
        )}
      </div>
      <p className={`${mutedCls} text-xs`}>{t("mailNote")}</p>

      <h3 className="font-sans text-sm font-semibold text-heading">{t("listTitle")}</h3>
      {entries.length === 0 ? (
        <p className={mutedCls}>{t("empty")}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="break-all text-sm font-medium text-ink">{e.email}</p>
                <p className={`${mutedCls} text-xs`}>
                  {t("addedOn")} {f.dateTime(new Date(e.createdAt), { dateStyle: "short", timeZone: "Europe/Berlin" })}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={e.status === "accepted" ? pillAccentCls : pillCls}>{t(e.status)}</span>
                {e.revocable && (
                  <button type="button" className={btnSecondary} onClick={() => setRevoking(e)} disabled={pending}>
                    {t("revoke")}
                    <span className="sr-only"> {e.email}</span>
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={revoking !== null}
        title={t("revokeTitle")}
        description={t("revokeBody")}
        confirmLabel={t("revoke")}
        cancelLabel={t("cancel")}
        pending={pending}
        onConfirm={onRevoke}
        onCancel={() => setRevoking(null)}
      >
        {revoking && <p className="break-all text-sm font-medium">{revoking.email}</p>}
      </ConfirmDialog>
    </Section>
  );
}
