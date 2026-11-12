-- The model's short reply to a plan adjustment ("Plan anpassen"), kept with the patch version so the version list can
-- show what the model said it changed (Alex, 2026-11-12). Model output, shown only to people who can see the plan.
alter table public.plan_versions
  add column if not exists reply text check (reply is null or char_length(reply) <= 2000);

grant insert (reply) on public.plan_versions to authenticated;
