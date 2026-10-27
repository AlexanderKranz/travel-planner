# RLS / grants test plan (NOT YET RUNNABLE here: needs Docker + `supabase start`)

Run later with `supabase start && supabase db reset && psql "$LOCAL_DB_URL" -f supabase/tests/rls.test.sql`
(or `supabase test db` once the pgTAP file below is in this folder; it is already pgTAP-formatted).
