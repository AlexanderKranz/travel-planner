/**
 * One formula for the flight time estimate, shared by the flights panel (`approxBlockMin`) and the destination
 * search (radius filter, card label), so the two cannot disagree. Spec find-destinations section 3 [D2].
 */

export const BLOCK_OVERHEAD_MIN = 30; // taxi, climb, descent
export const KM_PER_MIN = 13.3; // ~800 km/h
export const LIMIT_TOLERANCE_MIN = 10; // the estimate is not exact to the minute
/** At most this many origin airports are considered, here and in the flight check (`getFlightsFacts`). */
export const MAX_ORIGINS = 2;
/** Closer than this to an origin airport: no flight line, the card says "close to your airport". */
export const NEAR_AIRPORT_KM = 250;

export const blockMinFromKm = (km: number): number => BLOCK_OVERHEAD_MIN + km / KM_PER_MIN;

/** Straight-line radius for a flight limit in hours: 2 h = 1,330 km, 2.5 h = 1,729 km, 3 h = 2,128 km. */
export const flightRadiusKm = (maxHours: number): number =>
  Math.round((60 * maxHours - BLOCK_OVERHEAD_MIN + LIMIT_TOLERANCE_MIN) * KM_PER_MIN);

/** Nearest half hour, shown as "ca. 2 h". */
export const roundedHalfHourMin = (min: number): number => Math.round(min / 30) * 30;
