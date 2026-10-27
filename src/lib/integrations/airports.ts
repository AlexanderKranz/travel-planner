/**
 * Airport lookup from the bundled OurAirports dataset (public domain, see src/data/README.md).
 * Pure and in-memory, no network. Server-only by convention: import it from route handlers and
 * server code, never from client components (the dataset is ~290 KB). Client UIs call GET /api/airports.
 */
import { z } from 'zod';
import raw from '@/data/airports.json';

export const airportSchema = z.object({
  iata: z.string().regex(/^[A-Z]{3}$/),
  name: z.string(),
  city: z.string(),
  country: z.string(), // ISO 3166-1 alpha-2
  lat: z.number(),
  lon: z.number(),
});
export type Airport = z.infer<typeof airportSchema>;

const fileSchema = z.object({
  source: z.string(),
  fetchedAt: z.string(),
  airports: z.array(z.tuple([z.string(), z.string(), z.string(), z.string(), z.number(), z.number()])),
});

const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();

type Entry = { airport: Airport; city: string; name: string };

const data = fileSchema.parse(raw);
const byIata = new Map<string, Entry>();
for (const [iata, name, city, country, lat, lon] of data.airports) {
  byIata.set(iata, { airport: { iata, name, city, country, lat, lon }, city: fold(city), name: fold(name) });
}
const entries = [...byIata.values()];

export const airportDataInfo = { source: data.source, fetchedAt: data.fetchedAt, count: entries.length };

export function getAirport(iata: string): Airport | undefined {
  return byIata.get(iata.trim().toUpperCase())?.airport;
}

export function isKnownIata(code: string): boolean {
  return byIata.has(code.trim().toUpperCase());
}

/** Exact IATA first, then city prefix, name prefix, then word-prefix in city/name. Accent-insensitive. */
export function searchAirports(query: string, limit = 10): Airport[] {
  const q = fold(query);
  if (!q || limit <= 0) return [];
  const out: Airport[] = [];
  const seen = new Set<string>();
  const add = (e: Entry) => {
    if (!seen.has(e.airport.iata) && out.length < limit) {
      seen.add(e.airport.iata);
      out.push(e.airport);
    }
  };
  const exact = byIata.get(q.toUpperCase());
  if (exact) add(exact);
  for (const e of entries) if (e.city.startsWith(q)) add(e);
  for (const e of entries) if (e.name.startsWith(q)) add(e);
  for (const e of entries) if (e.city.includes(` ${q}`) || e.name.includes(` ${q}`)) add(e);
  return out;
}
