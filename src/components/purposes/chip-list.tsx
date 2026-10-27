"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { TextField } from "@/components/ui/fields";
import { btnSecondary } from "@/components/ui/styles";

/** Removable items plus an input to add more (used for custom interests and constraints). */
export function ChipList({
  label,
  addLabel,
  hint,
  items,
  max,
  maxLength,
  error,
  asList,
  onChange,
}: {
  label: string;
  addLabel: string;
  hint?: string;
  items: string[];
  max: number;
  maxLength: number;
  error?: string;
  asList?: boolean;
  onChange: (items: string[]) => void;
}) {
  const t = useTranslations("purposes");
  const [value, setValue] = useState("");

  function add() {
    const v = value.trim();
    if (!v || items.includes(v) || items.length >= max) return;
    onChange([...items, v]);
    setValue("");
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end gap-2">
        <div className="flex-1">
          <TextField
            label={label}
            hint={hint}
            value={value}
            maxLength={maxLength}
            error={error}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </div>
        <button type="button" className={btnSecondary} onClick={add} disabled={!value.trim()}>
          {addLabel}
        </button>
      </div>
      {items.length > 0 && (
        <ul className={asList ? "flex flex-col gap-2" : "flex flex-wrap gap-2"}>
          {items.map((item) => (
            <li
              key={item}
              className="flex items-center justify-between gap-2 rounded-md border border-neutral-400 pl-3 text-sm dark:border-neutral-500"
            >
              <span className="break-words py-2">{item}</span>
              <button
                type="button"
                className="inline-flex size-11 shrink-0 items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-blue-600"
                aria-label={t("removeItem", { item })}
                onClick={() => onChange(items.filter((i) => i !== item))}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
