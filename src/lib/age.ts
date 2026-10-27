/**
 * Age in full years on a given date. Dates are ISO strings (YYYY-MM-DD) so the
 * result never depends on the server's time zone.
 */
export function ageOn(birthdate: string, onDate: string): number {
  const [by, bm, bd] = parseIsoDate(birthdate);
  const [y, m, d] = parseIsoDate(onDate);
  if (y < by || (y === by && (m < bm || (m === bm && d < bd)))) {
    throw new RangeError(`${onDate} is before birthdate ${birthdate}`);
  }
  const hadBirthday = m > bm || (m === bm && d >= bd);
  return y - by - (hadBirthday ? 0 : 1);
}

function parseIsoDate(value: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new TypeError(`Expected YYYY-MM-DD, got "${value}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
