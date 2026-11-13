-- City tours with 25 places (docs/specs/city-tour.md 17.1 [P1]): a worst-case input (25 places + start + end with
-- maximum key and name lengths, an override on every leg) is about 22 kB, above the 16 kB check of 20261116120041.
-- Raised to 32 kB. Additive: every row that passed the old check passes the new one.
-- NOT VALID first, then VALIDATE: the ALTER that swaps the check needs only a brief exclusive lock, and the scan of
-- existing rows runs under SHARE UPDATE EXCLUSIVE, which does not block reads or writes of tours.
alter table public.city_tours
  drop constraint if exists city_tours_input_check,
  add constraint city_tours_input_check
    check (jsonb_typeof(input) = 'object' and pg_column_size(input) <= 32768) not valid;
alter table public.city_tours validate constraint city_tours_input_check;
