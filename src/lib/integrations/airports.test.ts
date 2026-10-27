import { describe, expect, it } from 'vitest';
import { getAirport, isKnownIata, searchAirports } from './airports';

describe('airports', () => {
  it.each(['FRA', 'MUC', 'VIE', 'AGP', 'LNZ'])('finds %s', (code) => {
    expect(isKnownIata(code)).toBe(true);
    expect(getAirport(code)?.iata).toBe(code);
    expect(searchAirports(code)[0]?.iata).toBe(code);
  });

  it('is accent- and case-insensitive', () => {
    expect(searchAirports('Málaga').map((a) => a.iata)).toContain('AGP');
    expect(searchAirports('malaga')[0]?.iata).toBe('AGP');
    expect(searchAirports('agp')[0]?.iata).toBe('AGP');
  });

  it('matches city prefixes', () => {
    expect(searchAirports('frank').map((a) => a.iata)).toContain('FRA');
  });

  it('respects limit and handles empty input', () => {
    expect(searchAirports('a', 3).length).toBeLessThanOrEqual(3);
    expect(searchAirports('  ')).toEqual([]);
  });

  it('rejects unknown codes', () => {
    expect(isKnownIata('ZZZ')).toBe(false);
    expect(getAirport('ZZZ')).toBeUndefined();
    expect(isKnownIata('fra')).toBe(true);
  });
});
