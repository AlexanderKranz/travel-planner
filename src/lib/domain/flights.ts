import { z } from "zod";

export const IataCode = z.string().regex(/^[A-Z]{3}$/);
export type FlightDir = "out" | "back";
export type FlightMode = "schedule" | "proxy";

export type FlightLeg = {
  dir: FlightDir;
  from: string;
  to: string;
  number: string; // display form "LH 1148"
  airline: string | null; // resolved name; null = unknown (show number only)
  operatedBy?: string; // only when the API marks a different operator
  dep: string;
  arr: string; // local HH:MM at from/to
  arrDayOffset: 0 | 1;
  blockMin: number; // from scheduled UTC times
  date: string; // schedule date actually checked (proxy date in proxy mode)
  weekdays?: number[]; // 1=Mo..7=Su, from step N
  operatingDays?: { days: number; of: number; month: string }; // "25 of 31 days in 2027-03"
  tooLong?: true; // blockMin > maxBlockMin
};
export type PairStatus = "found" | "none" | "not_published" | "not_checked";
export type FlightPair = {
  from: string;
  to: string;
  toName: string;
  gatewayKm: number;
  status: PairStatus;
  perDay?: number; // routes/daily average (1 decimal)
  operators: { iata?: string; name: string }[]; // from routes/daily; private/unnamed filtered
  approxBlockMin: number; // great-circle estimate, always present
};
export type FlightsFacts = {
  basis: "trip_dates" | "sample_week";
  outDate: string;
  backDate: string;
  mode: { out: FlightMode; back: FlightMode };
  checkedDates: { out: string; back: string }; // after proxy shift
  origins: string[];
  gateways: { iata: string; name: string; km: number }[];
  pairs: FlightPair[]; // sorted: found first, then by gatewayKm
  legs: FlightLeg[]; // max 6 per direction, sorted: fitting first, then dep time
  maxBlockMin: number | null; // from the purpose (spec section 4)
  quotaLimited: boolean; // at least one lookup refused by the guard
};

/** One day next to the trip's date for one direction and one airport pair (on-demand "check +/-1 day"). */
export type NearbyDay = {
  date: string; // the real calendar day (trip date -1 / +1); legs[].date holds the schedule date actually checked
  offset: -1 | 1;
  weekday: number; // 1=Mo..7=Su of `date`
  legs: FlightLeg[]; // max 6, fitting first, then dep time; codeshares removed
  complete: boolean; // both am and pm windows fetched (false = partly not checked)
  checked: boolean; // false = not looked up at all (beyond horizon, in the past, quota or budget)
};
export type NearbyFlights = {
  dir: FlightDir;
  from: string; // pair origin
  to: string; // pair gateway (dir back: the departure airport)
  mode: FlightMode; // proxy = last year's flights on the same weekday, like the main lookup
  days: NearbyDay[]; // ascending by date
  quotaLimited: boolean;
};
