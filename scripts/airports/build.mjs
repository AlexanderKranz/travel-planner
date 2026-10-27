// Builds src/data/airports.json from OurAirports (public domain).
// Source: https://davidmegginson.github.io/ourairports-data/airports.csv
// Docs:   https://ourairports.com/data/ (checked 2026-10-27)
// Run:    npm run airports:build   (about once a year)
// Keeps rows with scheduled_service=yes and a 3-letter IATA code.
// Output: { source, fetchedAt, airports: [[iata, name, city, countryIso2, lat, lon], ...] }
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_CSV = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../../src/data/airports.json');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const res = await fetch(URL_CSV);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
const [header, ...rows] = parseCsv(await res.text());
const col = Object.fromEntries(header.map((h, i) => [h, i]));
for (const k of ['name', 'latitude_deg', 'longitude_deg', 'iso_country', 'municipality', 'scheduled_service', 'iata_code']) {
  if (!(k in col)) throw new Error(`Missing column ${k}`);
}

const seen = new Set();
const airports = [];
for (const r of rows) {
  const iata = r[col.iata_code].trim().toUpperCase();
  if (r[col.scheduled_service] !== 'yes' || !/^[A-Z]{3}$/.test(iata) || seen.has(iata)) continue;
  const lat = Number(r[col.latitude_deg]), lon = Number(r[col.longitude_deg]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
  seen.add(iata);
  airports.push([iata, r[col.name].trim(), r[col.municipality].trim(), r[col.iso_country].trim(),
    Math.round(lat * 1e4) / 1e4, Math.round(lon * 1e4) / 1e4]);
}
airports.sort((a, b) => a[0].localeCompare(b[0]));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ source: URL_CSV, fetchedAt: new Date().toISOString().slice(0, 10), airports }) + '\n');
console.log(`Wrote ${airports.length} airports to ${OUT}`);
