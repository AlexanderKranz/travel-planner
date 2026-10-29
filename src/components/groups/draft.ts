import type { AgeMode, GroupParse, TripGroupEntry, StatedAge, StoredEntry, TraitKey, TravelGroupInput, TravellerRole } from "@/lib/domain";
import { resolveTravellerAge } from "@/lib/group-text";
import type { AgeSource } from "@/lib/group";

export const MOBILITY = ["none", "limited", "wheelchair", "stroller"] as const;

/** Form state of one group entry; everything is a string so inputs stay controlled. */
export type EntryDraft = {
  key: string;
  id?: string;
  kind: "composition" | "member";
  isSelf: boolean;
  count: string;
  label: string;
  name: string;
  birthdate: string;
  ageMode: "" | AgeMode;
  age: string;
  ageAsOf?: string;
  notes: string;
  mobility: "" | (typeof MOBILITY)[number];
  diet: string;
  golfHandicap: string;
  needsNap: boolean;
};

let counter = 0;
export const newKey = () => `n${Date.now().toString(36)}${counter++}`;

export function emptyDraft(kind: EntryDraft["kind"], isSelf = false): EntryDraft {
  return {
    key: newKey(),
    kind,
    isSelf,
    count: "1",
    label: "",
    name: "",
    birthdate: "",
    ageMode: "",
    age: "",
    notes: "",
    mobility: "",
    diet: "",
    golfHandicap: "",
    needsNap: false,
  };
}

export function fromStored(entry: StoredEntry, index: number): EntryDraft {
  const traits = entry.traits ?? {};
  const stated = entry.age;
  return {
    key: entry.id ?? `e${index}`,
    id: entry.id,
    kind: entry.kind,
    isSelf: entry.kind === "member" ? entry.isSelf : false,
    count: entry.kind === "composition" ? String(entry.count) : "1",
    label: entry.label ?? "",
    name: entry.kind === "member" ? (entry.name ?? "") : "",
    birthdate: entry.kind === "member" ? (entry.birthdate ?? "") : "",
    ageMode: stated?.ageMode ?? "",
    age: stated && stated.ageMode !== "relativeToMe" ? String(stated.age) : "",
    ageAsOf: entry.ageAsOf,
    notes: entry.notes ?? "",
    mobility: traits.mobility ?? "",
    diet: traits.diet?.join(", ") ?? "",
    golfHandicap: traits.golfHandicap === undefined ? "" : String(traits.golfHandicap),
    needsNap: traits.needsNap ?? false,
  };
}

/** Age is ignored for "me" and for members with a birthdate (the birthdate wins). */
function ageAllowed(d: EntryDraft): boolean {
  return !d.isSelf && !(d.kind === "member" && d.birthdate !== "");
}

function buildAge(d: EntryDraft): StatedAge | undefined {
  if (!ageAllowed(d) || d.ageMode === "") return undefined;
  if (d.ageMode === "relativeToMe") return { ageMode: "relativeToMe" };
  return {
    ageMode: d.ageMode,
    age: d.age.trim() === "" ? Number.NaN : Number(d.age),
  };
}

export type InputEntry = TravelGroupInput["entries"] extends (infer E)[] | undefined ? E : never;

/** True when the entry holds a value for the given trait. */
export function hasTraitValue(d: EntryDraft, key: TraitKey): boolean {
  switch (key) {
    case "mobility":
      return d.mobility !== "";
    case "diet":
      return d.diet.trim() !== "";
    case "golfHandicap":
      return d.golfHandicap.trim() !== "";
    case "needsNap":
      return d.needsNap;
  }
}

/** Only traits selected for the group are sent; the rest are dropped. */
export function draftToInput(d: EntryDraft, traitKeys: readonly TraitKey[] = []): InputEntry {
  const traits: Record<string, unknown> = {};
  if (traitKeys.includes("mobility") && d.mobility) traits.mobility = d.mobility;
  const diet = d.diet
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (traitKeys.includes("diet") && diet.length) traits.diet = diet;
  if (traitKeys.includes("golfHandicap") && d.golfHandicap.trim() !== "")
    traits.golfHandicap = Number(d.golfHandicap);
  if (traitKeys.includes("needsNap") && d.needsNap) traits.needsNap = true;

  const base = {
    ...(d.id ? { id: d.id } : {}),
    label: d.label,
    notes: d.notes,
    traits,
    age: buildAge(d),
  };
  if (d.kind === "composition") {
    return { ...base, kind: "composition", count: Number(d.count) };
  }
  return {
    ...base,
    kind: "member",
    isSelf: d.isSelf,
    name: d.isSelf ? undefined : d.name,
    birthdate: d.isSelf || d.birthdate === "" ? undefined : d.birthdate,
  };
}

/** Entry for live age preview. Editing the age restarts "stated on" at today (ageAsOf cleared). */
export function draftToAgeSource(d: EntryDraft): AgeSource {
  const age = buildAge(d);
  const valid = age && (age.ageMode === "relativeToMe" || Number.isFinite(age.age));
  return {
    id: d.key,
    kind: d.kind,
    count: Math.max(1, Math.floor(Number(d.count)) || 1),
    label: d.label || undefined,
    name: d.name || undefined,
    isSelf: d.isSelf,
    birthdate: d.birthdate && !d.isSelf ? d.birthdate : undefined,
    age: valid ? age : undefined,
    ageAsOf: d.ageAsOf,
  };
}

/**
 * Haiku parse -> composition drafts for the structured editor ("Adjust"). Ages are stated ages as of today:
 * "relative to me" with an offset becomes an approximate age when the profile has a birthdate (else it stays
 * relative and loses the offset); a role without an age becomes the label.
 */
export function parseToDrafts(
  parse: GroupParse,
  opts: { today: string; profileBirthdate: string | null; roleLabel: (role: TravellerRole) => string },
): EntryDraft[] {
  return parse.travellers.map((t) => {
    const d = emptyDraft("composition");
    d.count = String(t.count);
    d.label = t.label ?? (t.role && t.ageMode === undefined ? opts.roleLabel(t.role) : "");
    if (t.ageMode === "relativeToMe") {
      const age = resolveTravellerAge(t, opts.today, opts.profileBirthdate);
      if (age.status === "known" && (t.ageOffset ?? 0) !== 0) {
        d.ageMode = "approx";
        d.age = String(age.age);
      } else {
        d.ageMode = "relativeToMe";
      }
    } else if ((t.ageMode === "exact" || t.ageMode === "approx") && t.age !== undefined) {
      d.ageMode = t.ageMode;
      d.age = String(t.age);
    }
    return d;
  });
}

/** Stored entry of a trip's one-off group -> composition draft. */
export function tripEntryToDraft(e: TripGroupEntry): EntryDraft {
  const d = emptyDraft("composition");
  d.count = String(e.count);
  d.label = e.label ?? "";
  d.notes = e.notes ?? "";
  d.ageMode = e.age?.ageMode ?? "";
  d.age = e.age && e.age.ageMode !== "relativeToMe" ? String(e.age.age) : "";
  d.ageAsOf = e.ageAsOf;
  return d;
}

/** Composition draft -> input entry without traits (the one-off group of a trip has no trait selection). */
export function draftToCompositionInput(d: EntryDraft): Extract<InputEntry, { kind: "composition" }> {
  return draftToInput({ ...d, kind: "composition" }) as Extract<InputEntry, { kind: "composition" }>;
}
