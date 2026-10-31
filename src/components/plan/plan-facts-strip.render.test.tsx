import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import cruise from "@/lib/server/__fixtures__/plan-document-cruise.json";
import { planTimeDifference } from "@/lib/facts/plan-time-difference";
import type { PlanDocument } from "@/lib/domain/share";
import { PlanFactsStrip } from "./plan-facts-strip";

vi.mock("@/i18n/navigation", () => ({ Link: (p: { href: string; children: unknown }) => <a href={String(p.href)}>{p.children as never}</a> }));

const LONG = "Frankfurt am Main, Hessen, Deutschland";

// Writes static HTML for a browser screenshot when STRIP_DIR is set; always checks the text.
describe("PlanFactsStrip with a time difference", () => {
  it("renders de and en", () => {
    const dir = process.env.STRIP_DIR;
    const out: string[] = [];
    for (const [loc, msgs] of [["de", de], ["en", en]] as const) {
      const doc = structuredClone(cruise) as unknown as PlanDocument;
      const cases: [string, string | null, string | null][] = [
        ["long", LONG, "Europe/Berlin"],
        ["nospace", "Frankfurtamm".repeat(10), "Europe/Berlin"],
        ["default", null, null],
      ];
      for (const [name, home, tz] of cases) {
        doc.plan.facts.daylight = { ...(doc.plan.facts.daylight as object), timezone: "Asia/Bangkok" } as never;
        doc.plan.header.timing = { kind: "none" } as never;
        const td = planTimeDifference(doc.plan, home ? { name: home, timezone: tz } : null, "2026-10-31");
        const html = renderToStaticMarkup(
          <NextIntlClientProvider locale={loc} messages={msgs}>
            <PlanFactsStrip facts={doc.plan.facts} timeDifference={td} />
          </NextIntlClientProvider>,
        );
        expect(html).toContain(loc === "de" ? "Zeitverschiebung" : "Time difference");
        out.push(`<h4>${loc} ${name}</h4><div class="wrap">${html}</div>`);
      }
    }
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "body.html"), out.join("\n"));
    }
  });
});
