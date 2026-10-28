// QA review tests for phase 2: duplicated frontend/integration code must not diverge.
// Tests named "KNOWN DEFECT" use it.fails: they pass while the defect exists and turn red when it is fixed,
// at which point drop the `.fails`.
import { describe, expect, it } from "vitest";
import countriesFile from "@/data/countries.json";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { INTEREST_KEYS } from "@/lib/domain/interests";
import { INTEREST_SOURCES } from "@/lib/facts/interest-sources";
import { SOURCES } from "@/lib/facts/sources";
import { ageReferenceDate } from "@/lib/facts/trip-timing";
import { ageDateFor } from "@/components/trips/age-date";
import { COUNTRY_CODES } from "@/components/trips/country-codes";
import { SOURCE_META } from "@/components/facts/source-meta";
import type { TripTiming } from "@/lib/domain";

const dataset = Object.keys((countriesFile as { countries: Record<string, unknown> }).countries);

describe("age date: components/trips/age-date.ts vs lib/facts/trip-timing.ts", () => {
  const today = "2026-10-28";
  const cases: TripTiming[] = [
    { kind: "none" },
    { kind: "date", startDate: "2027-03-02" },
    { kind: "months", months: [12] },
    { kind: "months", months: [3, 12] },
    { kind: "months", months: [10] },
    { kind: "months", months: [9] }, // already past this year -> next year
    { kind: "months", months: [9, 11] },
  ];
  it.each(cases)("agree for %j", (timing) => {
    expect(ageDateFor(timing, today)).toBe(ageReferenceDate({ timing, lengthDays: 7 }, today) ?? today);
  });
});

describe("country list: COUNTRY_CODES (client) vs src/data/countries.json", () => {
  it("every code offered in the picker has country facts", () => {
    const missing = COUNTRY_CODES.filter((c) => !dataset.includes(c));
    expect(missing).toEqual([]);
  });
  it("no duplicates", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
  });
  it.fails("KNOWN DEFECT: dataset countries the picker cannot select (hand-maintained list drifts)", () => {
    const notSelectable = dataset.filter((c) => !COUNTRY_CODES.includes(c));
    // listCountries() exists server-side; the picker should derive its list from the dataset.
    expect(notSelectable).toEqual([]);
  });
});

describe("source attribution", () => {
  it("SOURCE_META and SOURCES cover the same ids", () => {
    expect(Object.keys(SOURCE_META).sort()).toEqual(Object.keys(SOURCES).sort());
  });
  it.fails("KNOWN DEFECT: homepage and licence URL agree between SOURCE_META and SOURCES", () => {
    for (const id of Object.keys(SOURCES) as (keyof typeof SOURCES)[]) {
      expect(SOURCE_META[id].homepage, `${id} homepage`).toBe(SOURCES[id].homepage);
      expect(SOURCE_META[id].licenseUrl, `${id} licenseUrl`).toBe(SOURCES[id].licenseUrl);
    }
  });
  it.fails("KNOWN DEFECT: rest_countries (really mledoze/countries) is attributed as ODbL in SOURCE_META", () => {
    expect(SOURCE_META.rest_countries.licenseUrl).toMatch(/opendatacommons\.org\/licenses\/odbl/);
    expect(SOURCE_META.rest_countries.homepage).toMatch(/mledoze\/countries/);
  });
  it.fails("KNOWN DEFECT: rest_countries messages name mledoze/countries and ODbL (de + en)", () => {
    for (const [name, m] of [["de", de], ["en", en]] as const) {
      const item = JSON.stringify(m.sources.items.rest_countries);
      expect(item, name).toMatch(/mledoze/i);
      expect(item, name).toMatch(/ODbL/);
      expect(item, name).not.toMatch(/MPL/);
    }
  });
  it("licence links are valid-looking https URLs", () => {
    for (const [id, m] of Object.entries(SOURCE_META)) {
      for (const u of [m.homepage, m.licenseUrl]) if (u) expect(u, id).toMatch(/^https:\/\//);
    }
  });
  it.fails("KNOWN DEFECT: SOURCES (lib/facts/sources.ts) ODbL licence text URL is the canonical opendatacommons path (1-0, not 1.0)", () => {
    expect(SOURCE_META.osm.licenseUrl).toBe("https://opendatacommons.org/licenses/odbl/1-0/");
    expect(SOURCES.osm.licenseUrl).toBe("https://opendatacommons.org/licenses/odbl/1-0/");
    expect(SOURCES.rest_countries.licenseUrl).toBe("https://opendatacommons.org/licenses/odbl/1-0/");
  });
  it("every source has label/provides/license in both locales", () => {
    for (const id of Object.keys(SOURCE_META)) {
      for (const m of [de, en]) {
        const item = (m.sources.items as Record<string, Record<string, string>>)[id];
        expect(item?.label, id).toBeTruthy();
        expect(item?.provides, id).toBeTruthy();
        expect(item?.license, id).toBeTruthy();
      }
    }
  });
});

describe("interest mapping", () => {
  it("every interest key has a source mapping and de/en labels", () => {
    for (const k of INTEREST_KEYS) {
      expect(INTEREST_SOURCES[k], k).toBeDefined();
      expect((de.interests as Record<string, string>)[k], `de ${k}`).toBeTruthy();
      expect((en.interests as Record<string, string>)[k], `en ${k}`).toBeTruthy();
    }
  });
  it("OSM filters only use the restricted Overpass QL shape (no injection surface)", () => {
    const clause = /^(\["[a-z_:]+"(?:(?:=|~)"[A-Za-z0-9_^$()|]*")?\])+$/;
    for (const [k, s] of Object.entries(INTEREST_SOURCES)) {
      if (s.source !== "osm") continue;
      for (const f of s.filters) expect(f, k).toMatch(clause);
    }
  });
});
