import { DEFAULT_RADIUS_KM, type Trip, type TripInput } from "@/lib/domain";

export type DestinationDraft =
  | { mode: "none" }
  | {
      mode: "geo";
      geoKind: "city" | "region";
      geoId: number;
      /** Anchor place as shown to the user, e.g. "Marbella, Andalusia, Spain". */
      placeLabel: string;
      placeName: string;
      /** Display name; may be renamed ("Costa del Sol"). */
      name: string;
      /** null = server default for the kind. */
      radiusKm: number | null;
    }
  | { mode: "freetext"; name: string; countryCode: string };

export type TimingDraft = {
  mode: "none" | "date" | "months";
  startDate: string;
  months: number[];
};

export type TripDraft = {
  title: string;
  destination: DestinationDraft;
  lengthDays: number;
  timing: TimingDraft;
  groupId: string;
  purposeId: string;
  wantsFlights: boolean;
  useHomeAirports: boolean;
  originAirports: string[];
  notes: string;
};

export const emptyTripDraft = (wantsFlights = true): TripDraft => ({
  title: "",
  destination: { mode: "none" },
  lengthDays: 7,
  timing: { mode: "none", startDate: "", months: [] },
  groupId: "",
  purposeId: "",
  wantsFlights,
  useHomeAirports: true,
  originAirports: [],
  notes: "",
});

export function draftFromTrip(trip: Trip): TripDraft {
  const d = trip.destination;
  const destination: DestinationDraft =
    d.kind === "freetext"
      ? { mode: "freetext", name: d.name, countryCode: d.countryCode ?? "" }
      : {
          mode: "geo",
          geoKind: d.kind,
          geoId: d.geoId,
          placeName: d.placeName,
          placeLabel: [d.placeName, d.admin1].filter(Boolean).join(", "),
          name: d.name,
          radiusKm: d.radiusKm === DEFAULT_RADIUS_KM[d.kind] ? null : d.radiusKm,
        };
  return {
    title: trip.title ?? "",
    destination,
    lengthDays: trip.lengthDays,
    timing: {
      mode: trip.timing.kind,
      startDate: trip.timing.kind === "date" ? trip.timing.startDate : "",
      months: trip.timing.kind === "months" ? trip.timing.months : [],
    },
    groupId: trip.groupId ?? "",
    purposeId: trip.purposeId ?? "",
    wantsFlights: trip.wantsFlights,
    useHomeAirports: trip.originAirports.length === 0,
    originAirports: trip.originAirports,
    notes: trip.notes ?? "",
  };
}

/** Client-side completeness check; the server validates again. Returns issue paths. */
export function draftProblems(draft: TripDraft): string[] {
  const problems: string[] = [];
  const d = draft.destination;
  if (d.mode === "none" || (d.mode === "freetext" && !d.name.trim())) problems.push("destination");
  if (d.mode === "geo" && !d.name.trim()) problems.push("destination");
  if (!Number.isInteger(draft.lengthDays) || draft.lengthDays < 1) problems.push("lengthDays");
  if (draft.timing.mode === "date" && !draft.timing.startDate) problems.push("timing");
  if (draft.timing.mode === "months" && draft.timing.months.length === 0) problems.push("timing");
  return problems;
}

export function draftToInput(draft: TripDraft): TripInput {
  const d = draft.destination;
  if (d.mode === "none") throw new Error("destination missing");
  const destination: TripInput["destination"] =
    d.mode === "freetext"
      ? {
          kind: "freetext",
          name: d.name.trim(),
          ...(d.countryCode ? { countryCode: d.countryCode } : {}),
        }
      : {
          kind: d.geoKind,
          geoId: d.geoId,
          ...(d.name.trim() && d.name.trim() !== d.placeName ? { name: d.name.trim() } : {}),
          ...(d.radiusKm !== null ? { radiusKm: d.radiusKm } : {}),
        };
  const timing: TripInput["timing"] =
    draft.timing.mode === "date"
      ? { kind: "date", startDate: draft.timing.startDate }
      : draft.timing.mode === "months"
        ? { kind: "months", months: draft.timing.months }
        : { kind: "none" };
  return {
    title: draft.title.trim() || undefined,
    destination,
    lengthDays: draft.lengthDays,
    timing,
    groupId: draft.groupId || null,
    purposeId: draft.purposeId || null,
    wantsFlights: draft.wantsFlights,
    originAirports: draft.wantsFlights && !draft.useHomeAirports ? draft.originAirports : [],
    notes: draft.notes.trim() || undefined,
  };
}
