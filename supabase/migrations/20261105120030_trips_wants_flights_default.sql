-- Flights are opt-in on new trips. Existing trips keep their value.
alter table public.trips alter column wants_flights set default false;
