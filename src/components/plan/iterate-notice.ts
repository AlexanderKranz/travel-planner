/** Notice codes of docs/specs/port-places.md section 5 (`notice` of the iterate response). */
export const ITERATE_NOTICES = [
  "places_not_loadable",
  "stops_not_found",
  "stops_unchecked",
  "stops_capped",
  "stops_unknown",
] as const;
export type IterateNoticeCode = (typeof ITERATE_NOTICES)[number];

/** Message key under `plan.iterate` per code. */
export const NOTICE_KEY: Record<IterateNoticeCode, string> = {
  places_not_loadable: "placesNotLoadable",
  stops_not_found: "stopsNotFound",
  stops_unchecked: "stopsUnchecked",
  stops_capped: "stopsCapped",
  stops_unknown: "stopsUnknown",
};

export type IterateNotice = { code: IterateNoticeCode; places: string[] };

/** Reads the response field: the object form `{ code, places }` (a bare code string is tolerated). Unknown = none. */
export function readNotice(raw: unknown): IterateNotice | null {
  const code = typeof raw === "string" ? raw : (raw as { code?: unknown } | null)?.code;
  if (typeof code !== "string" || !(ITERATE_NOTICES as readonly string[]).includes(code)) return null;
  const places = typeof raw === "object" && raw !== null && Array.isArray((raw as { places?: unknown }).places)
    ? (raw as { places: unknown[] }).places.filter((p): p is string => typeof p === "string" && p.trim() !== "").slice(0, 3)
    : [];
  return { code: code as IterateNoticeCode, places };
}

/**
 * What the user reads when a patch changed nothing: the specific notice when there is one, else "nothing changed"
 * followed by the model's reply (port-places [P9]). `t` and `list` come from next-intl and `Intl.ListFormat`.
 */
export function unchangedMessage(
  res: { notice?: unknown; reply?: unknown },
  t: (key: string, values?: Record<string, string>) => string,
  list: (items: string[]) => string,
): string {
  const notice = readNotice(res.notice);
  if (notice) return t(NOTICE_KEY[notice.code], { places: list(notice.places) });
  const reply = typeof res.reply === "string" ? res.reply.trim() : "";
  return reply ? `${t("noChange")} ${reply}` : t("noChange");
}
