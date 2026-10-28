export type GeoPlace = {
  geoId: number;
  name: string; // localized per request language
  featureCode: string; // GeoNames, e.g. "PPLA2", "ADM1"
  countryCode: string | null; // ISO 3166-1 alpha-2
  admin1: string | null;
  lat: number;
  lon: number;
  timezone: string | null; // IANA
  population: number | null;
  suggestedKind: "city" | "region"; // PPL* -> city, everything else -> region
};
