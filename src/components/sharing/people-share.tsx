"use client";

import { ClientForm } from "@/components/ui/client-form";
import { useId, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { btnPrimary, errorCls, inputCls, mutedCls } from "@/components/ui/styles";
import { useRouter } from "@/i18n/navigation";
import type { ActionError } from "@/lib/domain";
import {
  MAX_SHARES_PER_RESOURCE,
  SHARE_ACCESS,
  type Grant,
  type ShareAccess,
  type ShareCandidate,
  type ShareResource,
} from "@/lib/domain/sharing";
import { shareWith } from "@/lib/server/sharing";
import { GrantRow } from "./grant-row";
import { shareErrorKey } from "./helpers";

/**
 * "People" box (owner only): add by email (admins pick from a list), choose the access, list of grants.
 * `disabledReason` (demo) turns the form off with a visible text.
 */
export function PeopleShare({
  resource,
  resourceId,
  grants,
  candidates,
  disabledReason,
}: {
  resource: ShareResource;
  resourceId: string;
  grants: Grant[];
  /** Admins only: the user picker replaces the email field. */
  candidates: ShareCandidate[] | null;
  disabledReason: string | null;
}) {
  const t = useTranslations("sharing");
  const router = useRouter();
  const uid = useId();
  const [email, setEmail] = useState("");
  const [userId, setUserId] = useState("");
  const [access, setAccess] = useState<ShareAccess>("read");
  const [error, setError] = useState<ActionError | null>(null);
  const [status, setStatus] = useState("");
  const [pending, start] = useTransition();
  const full = grants.length >= MAX_SHARES_PER_RESOURCE;
  const off = !!disabledReason;
  const target = candidates ? userId : email.trim();

  function add(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    setStatus("");
    start(async () => {
      const r = await shareWith({
        resource,
        resourceId,
        target: candidates ? { userId } : { email: email.trim() },
        access,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setEmail("");
      setUserId("");
      setStatus(t(r.data.created ? "added" : "accessChanged"));
      router.refresh();
    });
  }

  return (
    <section aria-labelledby={`${uid}-title`} className="flex min-w-0 flex-col gap-3" data-testid="people-share">
      <h3 id={`${uid}-title`} className="text-base font-semibold">
        {t("people")}
      </h3>
      <p className={`text-sm ${mutedCls}`}>{t("intro")}</p>
      {off ? (
        <p className={`text-sm ${mutedCls}`}>{disabledReason}</p>
      ) : (
        <ClientForm onSubmit={add} className="flex flex-col gap-3" noValidate>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {candidates ? (
                <>
                  <label htmlFor={`${uid}-user`} className="text-sm font-medium">
                    {t("pickUser")}
                  </label>
                  <select id={`${uid}-user`} value={userId} onChange={(e) => setUserId(e.target.value)} className={inputCls}>
                    <option value="">{t("pickUserNone")}</option>
                    {candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name ? `${c.email} (${c.name})` : c.email}
                      </option>
                    ))}
                  </select>
                </>
              ) : (
                <>
                  <label htmlFor={`${uid}-email`} className="text-sm font-medium">
                    {t("email")}
                  </label>
                  <input
                    id={`${uid}-email`}
                    type="email"
                    inputMode="email"
                    autoComplete="off"
                    maxLength={254}
                    placeholder={t("emailPlaceholder")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    aria-invalid={error === "no_account" || error === "self_share" || error === "invalid" ? true : undefined}
                    aria-describedby={error ? `${uid}-err` : undefined}
                    className={inputCls}
                  />
                </>
              )}
            </div>
          </div>
          <fieldset className="min-w-0">
            <legend className="mb-1 text-sm font-medium">{t("accessLabel")}</legend>
            <div className="grid grid-cols-2 gap-2">
              {SHARE_ACCESS.map((a) => (
                <label
                  key={a}
                  className="flex min-h-11 cursor-pointer items-center justify-center rounded-lg border-[1.5px] border-line-strong px-3 py-2 text-center text-sm font-semibold has-[:checked]:border-heading has-[:checked]:bg-heading has-[:checked]:text-page has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus"
                >
                  <input
                    type="radio"
                    name={`${uid}-access`}
                    value={a}
                    checked={access === a}
                    onChange={() => setAccess(a)}
                    className="sr-only"
                  />
                  {t(`access.${a}`)}
                </label>
              ))}
            </div>
          </fieldset>
          <p className={`text-sm ${mutedCls}`}>{t(resource === "trip" ? "groupNotice" : resource === "group" ? "groupShareNotice" : "purposeNotice")}</p>
          <div>
            <button type="submit" className={`${btnPrimary} w-full sm:w-auto`} disabled={pending || full || !target}>
              {pending ? t("adding") : t("add")}
            </button>
          </div>
        </ClientForm>
      )}
      {error && (
        <p id={`${uid}-err`} role="alert" className={`rounded-lg border border-danger-line bg-danger-bg p-3 text-sm text-danger-fg`}>
          {t(`errors.${shareErrorKey(error)}`, { max: MAX_SHARES_PER_RESOURCE })}
        </p>
      )}
      <p role="status" aria-live="polite" className={`min-h-5 text-sm font-medium ${status ? "text-ok-fg" : errorCls}`}>
        {status}
      </p>
      <p className={`text-sm ${mutedCls}`}>{t("count", { n: grants.length, max: MAX_SHARES_PER_RESOURCE })}</p>
      {grants.length === 0 && !off && <p className={`text-sm ${mutedCls}`}>{t("noGrants")}</p>}
      {grants.length > 0 && (
        <ul className="flex flex-col gap-2">
          {grants.map((g) => (
            <GrantRow
              key={`${g.id}-${g.access}`}
              resource={resource}
              grant={g}
              onChanged={(kind) => {
                setError(null);
                setStatus(t(kind));
                router.refresh();
              }}
              onError={setError}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
