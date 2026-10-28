"use client";

import { useTranslations } from "next-intl";
import { TextAreaField } from "@/components/ui/fields";
import { btnSecondary, mutedCls } from "@/components/ui/styles";
import { GROUP_TEXT_MAX, type GroupParse } from "@/lib/domain";
import { resolveGroup } from "@/lib/group-text";
import { useGroupSummaryText } from "./summary-text";

type Props = {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** What is saved: the text the parse belongs to, and the parse (undefined = none for that text). */
  saved?: { text?: string; parse?: GroupParse };
  /** The user has exact/corrected structure (it wins over the parse). */
  hasStructure: boolean;
  /** The structure may be replaced by the parse (no named members would be lost). */
  canAccept: boolean;
  /** Open the structured editor prefilled from the parse. */
  onAdjust: (parse: GroupParse) => void;
  date: string;
  profileBirthdate: string | null;
  rows?: number;
};

/** Free-text group description with the parsed result ("Recognised: 5 adults, about 46") underneath. */
export function GroupTextField({
  label,
  hint,
  value,
  onChange,
  error,
  saved,
  hasStructure,
  canAccept,
  onAdjust,
  date,
  profileBirthdate,
  rows = 3,
}: Props) {
  const t = useTranslations("groups.text");
  const summary = useGroupSummaryText();
  const text = value.trim();
  const parse = saved?.parse;
  const unchanged = text !== "" && text === (saved?.text ?? "").trim();
  const recognised = parse && parse.travellers.length > 0
    ? summary(resolveGroup({ entries: [], traitKeys: [], description: text, parse }, date, profileBirthdate))
    : "";

  let status: React.ReactNode = null;
  if (text !== "" && !unchanged) {
    status = <p className={`text-sm ${mutedCls}`}>{t("pending")}</p>;
  } else if (unchanged && parse) {
    status = (
      <div className="flex flex-col gap-2">
        <p className="text-sm">
          {recognised ? t("recognised", { summary: recognised }) : t("nothingRecognised")}
        </p>
        {parse.notes.length > 0 && <p className={`text-sm ${mutedCls}`}>{t("notes", { notes: parse.notes.join("; ") })}</p>}
        {hasStructure ? (
          <>
            <p className={`text-sm ${mutedCls}`}>{t("structureWins")}</p>
            {canAccept && parse.travellers.length > 0 && (
              <div>
                <button type="button" className={btnSecondary} onClick={() => onAdjust(parse)}>
                  {t("accept")}
                </button>
              </div>
            )}
          </>
        ) : (
          parse.travellers.length > 0 && (
            <div>
              <button type="button" className={btnSecondary} onClick={() => onAdjust(parse)}>
                {t("adjust")}
              </button>
            </div>
          )
        )}
      </div>
    );
  } else if (unchanged) {
    status = <p className={`text-sm ${mutedCls}`}>{t("notParsed")}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <TextAreaField
        label={label}
        hint={hint}
        rows={rows}
        value={value}
        maxLength={GROUP_TEXT_MAX}
        onChange={(e) => onChange(e.target.value)}
        error={error}
      />
      <div role="status" aria-live="polite">
        {status}
      </div>
    </div>
  );
}
