import { z } from "zod";
import { BirthDate, optionalText } from "./common";

export const AgeMode = z.enum(["exact", "approx", "relativeToMe"]);
export type AgeMode = z.infer<typeof AgeMode>;

export const MAX_ENTRIES_PER_GROUP = 30;

/** Optional per-entry details a group can enable. Keys equal the EntryTraits property names. */
export const TRAIT_KEYS = ["mobility", "diet", "golfHandicap", "needsNap"] as const;
export type TraitKey = (typeof TRAIT_KEYS)[number];

export const EntryTraits = z
  .object({
    mobility: z.enum(["none", "limited", "wheelchair", "stroller"]).optional(),
    diet: z.array(z.string().max(40)).max(10).optional(),
    golfHandicap: z.number().min(-10).max(54).optional(),
    needsNap: z.boolean().optional(),
  })
  .strict();
export type EntryTraits = z.infer<typeof EntryTraits>;

const Age = z.number().int().min(0).max(120);

/** Stated age. `ageAsOf` is set by the server on save, never by the form. */
export const StatedAge = z.discriminatedUnion("ageMode", [
  z.object({ ageMode: z.literal("exact"), age: Age }),
  z.object({ ageMode: z.literal("approx"), age: Age }),
  z.object({ ageMode: z.literal("relativeToMe") }),
]);
export type StatedAge = z.infer<typeof StatedAge>;

const EntryBase = {
  id: z.string().uuid().optional(),
  label: optionalText(60),
  notes: optionalText(1000),
  traits: EntryTraits.default({}),
};

/** Quick composition ("5 adults ~45"). An age is optional. */
export const CompositionEntry = z.object({
  ...EntryBase,
  kind: z.literal("composition"),
  count: z.number().int().min(1).max(50),
  age: StatedAge.optional(),
});
export type CompositionEntry = z.infer<typeof CompositionEntry>;

/** Named member, or the user themself (`isSelf`: name/birthdate come from the profile). */
export const MemberEntry = z
  .object({
    ...EntryBase,
    kind: z.literal("member"),
    isSelf: z.boolean().default(false),
    name: optionalText(80),
    birthdate: BirthDate.optional(),
    age: StatedAge.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.isSelf) {
      if (entry.name) ctx.addIssue({ code: "custom", path: ["name"], message: "Not allowed for self" });
      if (entry.birthdate) ctx.addIssue({ code: "custom", path: ["birthdate"], message: "Not allowed for self" });
      if (entry.age) ctx.addIssue({ code: "custom", path: ["age"], message: "Not allowed for self" });
    } else if (!entry.name) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "Name required" });
    }
    if (entry.birthdate && entry.age) {
      ctx.addIssue({ code: "custom", path: ["age"], message: "Use either birthdate or age" });
    }
  });
export type MemberEntry = z.infer<typeof MemberEntry>;

/** Entry position is the array index; the server renumbers on save. */
export const GroupEntry = z.discriminatedUnion("kind", [CompositionEntry, MemberEntry]);
export type GroupEntry = z.infer<typeof GroupEntry>;

/** Create/update payload. A group may be only a name. */
export const TravelGroupInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    notes: optionalText(2000),
    /** Which optional details are relevant for this group (ordered, duplicates dropped). */
    traitKeys: z
      .array(z.enum(TRAIT_KEYS))
      .max(TRAIT_KEYS.length)
      .default([])
      .transform((keys) => [...new Set(keys)]),
    entries: z.array(GroupEntry).max(MAX_ENTRIES_PER_GROUP).default([]),
  })
  .superRefine((group, ctx) => {
    const selfCount = group.entries.filter((e) => e.kind === "member" && e.isSelf).length;
    if (selfCount > 1) {
      ctx.addIssue({ code: "custom", path: ["entries"], message: "Only one self entry" });
    }
  });
export type TravelGroupInput = z.input<typeof TravelGroupInput>;
export type TravelGroupParsed = z.output<typeof TravelGroupInput>;

/** Entry as read from the DB (ordered, with server-set ageAsOf). */
export type StoredEntry = GroupEntry & { id: string; position: number; ageAsOf?: string };

export type TravelGroup = {
  id: string;
  name: string;
  notes?: string;
  traitKeys: TraitKey[];
  createdAt: string;
  updatedAt: string;
  entries: StoredEntry[];
};

export type TravelGroupSummary = {
  id: string;
  name: string;
  notes?: string;
  entryCount: number;
  updatedAt: string;
};
