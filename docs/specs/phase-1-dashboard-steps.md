# Phase 1: Supabase Dashboard steps (manual)

Things that cannot live in a migration. Do them once on the remote project, after the migrations have been applied (`supabase db push`, run by whoever deploys). Menu names can shift slightly; look for the same concept nearby.

Local development (`supabase start`) gets the hook, redirect URL and email confirmation from `supabase/config.toml`; this list is for the hosted project.

## 1. Enable the Before User Created hook (invite-only signup)

Requires migration `20261027120003_signup_allowlist.sql` applied first. Do step 6 (insert your own allowlist row) BEFORE your first login: signup is fail-closed in the database (`private.handle_new_user` raises `signup_not_allowed` for any email not on the list), so even with the hook disabled nobody unlisted can register, and you cannot register yourself without the row.

1. Open the Supabase project, left sidebar: **Authentication**.
2. Click **Hooks** (under "Configuration").
3. Next to **Before User Created**, click **Add hook** (or **Configure**).
4. Hook type: **Postgres function**.
5. Schema: `public`. Function: `hook_before_user_created`.
6. Click **Create / Save**. Make sure the hook shows as enabled.

If `hook_before_user_created` is not listed, the migration has not run yet.

Verification (do this after enabling the hook, with an address that is NOT on the allowlist):

1. Request a login link for the unlisted address in the app. The page shows the neutral message, but no email arrives and no user appears under **Authentication -> Users**. Check `app_events` for `auth.signup_rejected`.
2. Password signup cannot bypass it: with the publishable key, `POST {SUPABASE_URL}/auth/v1/signup` with `{"email":"<unlisted>","password":"<any>"}` must return an error (403 `signup_not_allowed`) and create no user. The database trigger rejects it even when the hook is off.
3. A listed address still receives its link.

Dashboard **Authentication -> Users -> Add user** also needs an allowlist row for that email first (the database trigger rejects unlisted emails there too).

## 2. Auth provider settings

1. **Authentication** -> **Sign In / Providers** (may be called "Providers").
2. **Email**: provider enabled; **Confirm email** on; **Allow new users to sign up** on (needed so the magic link can create the user; the hook still blocks everyone not on the allowlist).
3. Leave "Secure email change" on. Save.

## 3. URL configuration

1. **Authentication** -> **URL Configuration**.
2. **Site URL**: the production URL (see `docs/hosting-setup.md`).
3. **Redirect URLs**, add each of:
   - `http://localhost:3000/**`
   - the production URL followed by `/**`
   - the Vercel preview pattern `https://*-<team>.vercel.app/**` (replace `<team>` with your Vercel team slug)

## 4. Magic-link email template (token-hash link plus 6-digit code)

**Requires custom SMTP (step 7):** Supabase only allows editing templates once a custom SMTP sender is configured. Until then the default template is sent. It contains only a link (no code) using the PKCE flow: `/auth/confirm` handles it via `?code=`, but **only in the same browser** that requested the link, and the "sign in with code" option cannot be used. Do this step right after step 7.

The link must use the token hash so it works when opened on another device than the one that requested it.

1. **Authentication** -> **Emails** -> **Templates**.
2. Open **Magic Link**.
3. Subject: `Dein Login-Link / Your login link`
4. Message body (HTML), replace the whole content with. `{{ .RedirectTo }}` is the URL the app passes as `emailRedirectTo` (`https://<host>/auth/confirm?locale=de|en`), so the link keeps the language of the login form for new AND existing users:

```html
<h2>Travel Planner</h2>
<p><a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email">Anmelden / Sign in</a></p>
<p>Code: <strong>{{ .Token }}</strong></p>
<p>Der Link und der Code sind nur kurz gueltig. / The link and code are valid for a short time only.</p>
```

5. Save.

Note: the locale is carried in the redirect URL query, not in user metadata (metadata is ignored for existing users). The confirm route redirects to `/<locale>/app`. The app's origin must be covered by the Redirect URLs from step 3; if it is not, Supabase substitutes the Site URL and the link breaks.

Also open the **Confirm signup** template and paste the same body (new users receive this one the first time instead of "Magic Link"), changing nothing else.

## 5. JWT signing keys (asymmetric)

1. **Project Settings** -> **JWT Keys** (or **Authentication** -> **Signing Keys**).
2. If the project still uses the legacy shared secret, click **Migrate / Create a new signing key** and choose an asymmetric type (ES256 or RS256, default is fine).
3. Confirm the new key shows as "current".

This allows the server to verify sessions locally with `getClaims()`.

## 6. Make yourself admin and invite yourself (one-off SQL)

Dashboard -> **SQL Editor** -> new query. Run (replace the address; do NOT commit it anywhere):

```sql
insert into public.signup_allowlist (email, note) values ('you@example.com', 'owner');
```

Sign in once through the app so your profile exists, then run:

```sql
update public.profiles set role = 'admin'
where id = (select id from auth.users where email = 'you@example.com');
```

Deleting an account (settings) also deletes the user's allowlist row, so a deleted user needs a new invite. A deleted user's JWT stays valid until `jwt_expiry` (1 hour, `supabase/config.toml` locally); this is accepted: the user has no data left and writes fail on missing rows.

## 7. Custom SMTP (before inviting anyone else)

Deferred (see `docs/hosting-setup.md`). Until done, only Supabase team members receive magic links. Click-by-click setup (provider candidates, Supabase steps, the **Invite user** template next to Magic Link) is in `docs/runbook.md` section 11. Invites sent from the admin page work with either sender.

## 8. Vercel environment variables

Set under Vercel -> Project -> Settings -> Environment Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY` (Production and Preview; never expose the secret key to the browser).

## 9. Demo account (optional)

One shared account for friends: "View demo" on the login page signs in server-side (the password never reaches the browser). Demo users can create, edit and delete groups and purposes, but cannot delete the account; the demo user is never admin (`profiles.is_demo`, CHECK against `role = 'admin'`).

Requirements: **Authentication -> Sign In / Providers -> Email** must have password sign-in enabled (it is by default; the app itself uses magic links). Signup stays invite-only: the fail-closed trigger and hook still reject any email that is not in `signup_allowlist`; the reset script adds the demo email there.

Set up:
1. Set `DEMO_ENABLED=true`, `DEMO_EMAIL` (a mailbox-like address, it never receives mail) and `DEMO_PASSWORD` (long random, e.g. `openssl rand -base64 32`) in `.env.local` and in Vercel (Production, and Preview if wanted). Server-only: never `NEXT_PUBLIC_`.
2. After the migrations are applied (including `20261027120009_demo.sql`), run `npm run demo:reset`. It needs `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SECRET_KEY` as well, creates the user (or repairs it) and re-seeds the example groups, purposes and trips (one finished example trip with a recorded plan, cost items and a free-text group; no AI call, no share link). Run it again any time to reset the demo data; it is idempotent.
3. Redeploy so Vercel picks up the variables.

Switch off: set `DEMO_ENABLED=false` (or remove it) and redeploy. The button disappears and `signInDemo` refuses. Existing demo sessions stay valid until the JWT expires (1 hour) unless you also delete the user.

Remove permanently: delete the demo user in Dashboard -> Authentication -> Users (profile and data cascade) and remove the three variables. Delete its `signup_allowlist` row too.

Known limitation: a visitor with the demo session can call the Supabase Auth API directly and change the shared password or email, which locks everyone else out of the demo. The login itself cannot be abused further (the account has no admin rights and sees only its own data). `npm run demo:reset` repairs password and email; run it if the demo stops working. Mitigation if it gets annoying: schedule the script, or switch the demo off.

Also: login emails now use a configured base URL, never the request headers. Set `APP_URL` for a custom domain; on Vercel production `VERCEL_PROJECT_PRODUCTION_URL` is used, locally `http://localhost:3000`.
