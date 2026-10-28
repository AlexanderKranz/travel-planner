// QA review tests for phase 2: duplicated frontend/integration code must not diverge.
// Tests named "KNOWN DEFECT" use it.fails: they pass while the defect exists and turn red when it is fixed,
// at which point drop the `.fails`.
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { INTEREST_KEYS } from "@/lib/domain/interests";
import { INTEREST_SOURCES } from "@/lib/facts/interest-sources";
import { SOURCE_IDS, SOURCES } from "@/lib/facts/sources";
import { ageReferenceDate } from "@/lib/facts/trip-timing";

describe("age date: page uses ageReferenceDate(...) ?? today", () => {
  it("falls back to today without timing", () => {
    const today = "2026-10-28";
    expect(ageReferenceDate({ timing: { kind: "none" }, lengthDays: 7 }, today) ?? today).toBe(today);
  });
});

describe("source attribution", () => {
  it("SOURCE_IDS and SOURCES cover the same ids", () => {
    expect([...SOURCE_IDS].sort()).toEqual(Object.keys(SOURCES).sort());
  });
  it("rest_countries (really mledoze/countries) is attributed as ODbL", () => {
    expect(SOURCES.rest_countries.licenseUrl).toMatch(/opendatacommons\.org\/licenses\/odbl/);
    expect(SOURCES.rest_countries.homepage).toMatch(/mledoze\/countries/);
  });
  it("rest_countries messages name mledoze/countries and ODbL (de + en)", () => {
    for (const [name, m] of [["de", de], ["en", en]] as const) {
      const item = JSON.stringify(m.sources.items.rest_countries);
      expect(item, name).toMatch(/mledoze/i);
      expect(item, name).toMatch(/ODbL/);
      expect(item, name).not.toMatch(/MPL/);
    }
  });
  it("licence links are valid-looking https URLs", () => {
    for (const [id, m] of Object.entries(SOURCES)) {
      for (const u of [m.homepage, m.licenseUrl]) if (u) expect(u, id).toMatch(/^https:\/\//);
    }
  });
  it("SOURCES (lib/facts/sources.ts) ODbL licence text URL is the canonical opendatacommons path (1-0, not 1.0)", () => {
    expect(SOURCES.osm.licenseUrl).toBe("https://opendatacommons.org/licenses/odbl/1-0/");
    expect(SOURCES.rest_countries.licenseUrl).toBe("https://opendatacommons.org/licenses/odbl/1-0/");
  });
  it("every source has label/provides/license in both locales", () => {
    for (const id of SOURCE_IDS) {
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
    const clause = /^(\["[a-z_:]+"(?:(?:=|!~|~)"[A-Za-z0-9_^$()|]*")?\])+$/;
    for (const [k, s] of Object.entries(INTEREST_SOURCES)) {
      if (s.source !== "osm") continue;
      for (const f of s.filters) expect(f, k).toMatch(clause);
    }
  });
});
