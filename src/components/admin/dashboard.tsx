import { getFormatter, getTranslations } from "next-intl/server";
import { labelCls, mutedCls, pillAccentCls } from "@/components/ui/styles";
import { microToUsd, type Dashboard, type Meter } from "@/lib/server/admin/shape";
import type { getHealthInfo } from "@/lib/server/admin/stats";
import { Bar, LevelText, Section, Stat, Stats } from "./parts";

type Health = Awaited<ReturnType<typeof getHealthInfo>>;

/** Server component: the whole admin page body. Receives aggregates only (see src/lib/server/admin/shape.ts). */
export async function AdminDashboard({ data, health }: { data: Dashboard; health: Health }) {
  const t = await getTranslations("admin");
  const f = await getFormatter();
  const usd = (micro: number) => f.number(microToUsd(micro), { style: "currency", currency: "USD" });
  const num = (n: number) => f.number(n);
  const pct = (n: number | null) => (n === null ? "-" : `${f.number(n, { maximumFractionDigits: 1 })} %`);
  const ms = (n: number | null) => (n === null ? "-" : `${f.number(n)} ms`);
  const when = (iso: string) => f.dateTime(new Date(iso), { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Berlin" });
  const day = (iso: string) => f.dateTime(new Date(`${iso}T12:00:00Z`), { day: "2-digit", month: "2-digit", timeZone: "UTC" });
  const levelText = (m: Meter) => t(`level.${m.level}`);

  const { users, usage, ai, providers, adb, ors, geoapify, overpass, events } = data;

  return (
    <div className="flex flex-col gap-4">
      <Section id="admin-users" title={t("users.title")}>
        <Stats>
          <Stat label={t("users.total")} value={num(users.total)} hint={t("users.admins") + ": " + num(users.admins)} />
          <Stat label={t("users.active7")} value={num(users.active7)} />
          <Stat label={t("users.active30")} value={num(users.active30)} />
          <Stat label={t("users.newMonth")} value={num(users.newThisMonth)} />
        </Stats>
        <h3 className={labelCls}>{t("users.demoTitle")}</h3>
        <Stats>
          <Stat label={t("users.demoLogins7")} value={num(users.demoLogins7)} />
          <Stat label={t("users.demoLogins30")} value={num(users.demoLogins30)} />
          <Stat label={t("users.demoAiCalls")} value={num(users.demoAiCallsMonth)} />
          <Stat label={t("users.demoAiCost")} value={usd(users.demoAiMicroUsdMonth)} />
        </Stats>
        <p className={`${mutedCls} text-xs`}>{t("users.note")}</p>
      </Section>

      <Section id="admin-usage" title={t("usage.title")}>
        <Stats>
          <Stat label={t("usage.trips")} value={num(usage.trips)} hint={`${t("usage.tripsMonth")}: ${num(usage.tripsThisMonth)}`} />
          <Stat label={t("usage.plans")} value={num(usage.plans)} />
          <Stat label={t("usage.generated")} value={num(usage.generatedThisMonth)} hint={`${t("usage.versionsGenerate")}: ${num(usage.versionsGenerate)}`} />
          <Stat label={t("usage.patched")} value={num(usage.patchedThisMonth)} hint={`${t("usage.versionsPatch")}: ${num(usage.versionsPatch)}`} />
          <Stat label={t("usage.shares")} value={num(usage.shareLinksActive)} />
        </Stats>
        <h3 className={labelCls}>{t("usage.perDay")}</h3>
        <ul className="flex flex-col gap-2">
          {usage.perDay.map((d) => (
            <li key={d.day}>
              <Bar
                label={day(d.day)}
                valueText={`${num(d.generated)} ${t("usage.generatedLabel")}, ${num(d.patched)} ${t("usage.patchedLabel")}`}
                widthPct={d.widthPct}
              />
            </li>
          ))}
        </ul>
      </Section>

      <Section id="admin-ai" title={t("ai.title")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Bar
              label={t("ai.today")}
              valueText={t("ofCap", { used: usd(ai.today.used), cap: usd(ai.today.cap) })}
              widthPct={ai.today.pct}
              level={ai.today.level}
              aria={t("ai.today")}
            />
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs">
              <span className={mutedCls}>{t("ai.todayHint")}</span>
              <LevelText level={ai.today.level} text={levelText(ai.today)} />
            </p>
          </div>
          <div>
            <Bar
              label={t("ai.month")}
              valueText={t("ofCap", { used: usd(ai.month.used), cap: usd(ai.month.cap) })}
              widthPct={ai.month.pct}
              level={ai.month.level}
              aria={t("ai.month")}
            />
            <p className="mt-1 flex flex-wrap gap-x-2 text-xs">
              <span className={mutedCls}>{t("ai.monthHint")}</span>
              <LevelText level={ai.month.level} text={levelText(ai.month)} />
            </p>
          </div>
        </div>
        <Stats>
          <Stat label={t("ai.calls")} value={num(ai.callsMonth)} />
          <Stat label={t("ai.failed")} value={num(ai.failedMonth)} />
          <Stat label={t("ai.cacheShare")} value={pct(ai.cacheHitSharePct)} />
        </Stats>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className={labelCls}>{t("ai.byTask")}</h3>
            {ai.byTask.map((x) => (
              <Bar
                key={x.key}
                label={t.has(`ai.tasks.${x.key}`) ? t(`ai.tasks.${x.key}`) : x.key}
                valueText={`${usd(x.microUsd)}, ${t("ai.calls_n", { count: num(x.calls) })}`}
                widthPct={x.widthPct}
              />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className={labelCls}>{t("ai.byModel")}</h3>
            {ai.byModel.length === 0 ? <p className={mutedCls}>{t("noData")}</p> : null}
            {ai.byModel.map((x) => (
              <Bar key={x.key} label={x.key} valueText={`${usd(x.microUsd)}, ${t("ai.calls_n", { count: num(x.calls) })}`} widthPct={x.widthPct} />
            ))}
          </div>
        </div>
      </Section>

      <Section id="admin-api" title={t("api.title")}>
        {providers.length === 0 ? (
          <p className={mutedCls}>{t("noData")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead>
                <tr className={labelCls}>
                  <th scope="col" className="py-2 pr-3 font-semibold">{t("api.provider")}</th>
                  <th scope="col" className="px-2 text-right font-semibold">{t("api.callsToday")}</th>
                  <th scope="col" className="px-2 text-right font-semibold">{t("api.callsMonth")}</th>
                  <th scope="col" className="px-2 text-right font-semibold">{t("api.hitShare")}</th>
                  <th scope="col" className="px-2 text-right font-semibold">{t("api.errorRate")}</th>
                  <th scope="col" className="px-2 text-right font-semibold">{t("api.p50")}</th>
                  <th scope="col" className="pl-2 text-right font-semibold">{t("api.p95")}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {providers.map((p) => (
                  <tr key={p.provider} className="border-t border-line">
                    <th scope="row" className="py-2 pr-3 font-medium">{p.provider}</th>
                    <td className="px-2 text-right">{num(p.callsToday)}</td>
                    <td className="px-2 text-right">{num(p.callsMonth)}</td>
                    <td className="px-2 text-right">{pct(p.hitSharePct)}</td>
                    <td className="px-2 text-right">{pct(p.errorRatePct)}</td>
                    <td className="px-2 text-right">{ms(p.p50Ms)}</td>
                    <td className="pl-2 text-right">{ms(p.p95Ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className={`${mutedCls} text-xs`}>{t("api.note")}</p>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <h3 className={labelCls}>{t("api.adbTitle")}</h3>
            <Bar
              label={t("api.adbToday")}
              valueText={t("ofCap", { used: num(adb.unitsToday.used), cap: num(adb.unitsToday.cap) })}
              widthPct={adb.unitsToday.pct}
              level={adb.unitsToday.level}
              aria={t("api.adbToday")}
            />
            <p className="text-sm">
              {t("api.adbMonth")}: <span className="tabular-nums">{num(adb.unitsMonth)}</span>
            </p>
            <p className="text-sm">
              {t("api.adbRemaining")}: <span className="tabular-nums">{adb.remaining === null ? t("api.adbUnknown") : num(adb.remaining)}</span>{" "}
              <LevelText level={adb.level} text={t(`level.${adb.level}`)} />
            </p>
            <p className={`${mutedCls} text-xs`}>{t("api.adbMargin", { margin: num(adb.minRemaining) })}</p>
          </div>
          <div className="flex flex-col gap-2">
            <h3 className={labelCls}>{t("api.orsTitle")}</h3>
            <Bar
              label={t("api.orsToday")}
              valueText={t("ofCap", { used: num(ors.requestsToday.used), cap: num(ors.requestsToday.cap) })}
              widthPct={ors.requestsToday.pct}
              level={ors.requestsToday.level}
              aria={t("api.orsTitle")}
            />
            <h3 className={`${labelCls} mt-2`}>{t("api.geoapifyTitle")}</h3>
            <Bar
              label={t("api.geoapifyToday")}
              valueText={t("ofCap", { used: num(geoapify.creditsToday.used), cap: num(geoapify.creditsToday.cap) })}
              widthPct={geoapify.creditsToday.pct}
              level={geoapify.creditsToday.level}
              aria={t("api.geoapifyTitle")}
            />
            <h3 className={`${labelCls} mt-2`}>{t("api.overpassTitle")}</h3>
            {overpass.length === 0 ? <p className={mutedCls}>{t("noData")}</p> : null}
            <ul className="flex flex-col gap-1 text-sm">
              {overpass.map((v) => (
                <li key={v.variant} className="flex flex-wrap justify-between gap-x-3">
                  <span>{v.variant === "unknown" ? t("api.overpassUnknown") : v.variant}</span>
                  <span className="tabular-nums text-muted">{t("api.overpassCalls", { calls: num(v.calls), errors: num(v.errors) })}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      <Section id="admin-health" title={t("health.title")}>
        <Stats>
          <Stat
            label={t("health.db")}
            value={health.db.ok ? t("health.up") : t("health.down")}
            hint={t("health.latency", { ms: num(health.db.latencyMs) })}
          />
          <Stat label={t("health.aiEnabled")} value={health.aiEnabled ? t("health.on") : t("health.off")} />
          <Stat label={t("health.demoEnabled")} value={health.demoEnabled ? t("health.on") : t("health.off")} />
          <Stat label={t("health.lastCron")} value={health.lastCronAt ? when(health.lastCronAt) : t("health.never")} />
          <Stat label={t("health.commit")} value={health.commit} />
        </Stats>
        <h3 className={labelCls}>{t("health.keys")}</h3>
        <ul className="flex flex-wrap gap-2">
          {(Object.keys(health.keys) as (keyof Health["keys"])[]).map((k) => (
            <li key={k} className={health.keys[k] ? pillAccentCls : "inline-flex items-center rounded-full border border-danger-line bg-danger-bg px-3 py-0.5 text-xs font-medium text-danger-fg"}>
              {t(`health.keyNames.${k}`)}: {health.keys[k] ? t("health.set") : t("health.missing")}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="admin-events" title={t("events.title")}>
        {events.length === 0 ? (
          <p className={mutedCls}>{t("events.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[30rem] text-left text-sm">
              <thead>
                <tr className={labelCls}>
                  <th scope="col" className="py-2 pr-3 font-semibold">{t("events.time")}</th>
                  <th scope="col" className="px-2 font-semibold">{t("events.event")}</th>
                  <th scope="col" className="px-2 font-semibold">{t("events.route")}</th>
                  <th scope="col" className="pl-2 font-semibold">{t("events.code")}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.at}-${i}`} className="border-t border-line align-top">
                    <td className="whitespace-nowrap py-2 pr-3 tabular-nums">{when(e.at)}</td>
                    <td className="px-2 break-all">
                      <span className={e.level === "error" ? "font-semibold text-danger" : "font-semibold text-warn-fg"}>{t(`events.${e.level}`)}</span>{" "}
                      {e.event}
                    </td>
                    <td className="px-2 break-all">{e.route ?? "-"}</td>
                    <td className="pl-2 break-all">{e.code ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
