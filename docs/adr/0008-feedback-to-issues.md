# ADR 0008: In-app feedback becomes GitHub issues automatically

Status: accepted (Alex, 2026-11-02) · Date: 2026-11-02 · Spec: `docs/specs/feedback.md` · Issue: #83

## Context
Users should be able to report bugs and ideas without a GitHub account, and the reports should end up as GitHub
issues that the Claude Code action can work on. The repo is public. Free text can contain personal data, and user
text is untrusted input for an agent (prompt injection). Alex wants to know who sent a report, without emails in
issues. He set the limit at 10 reports per user per day and ruled that the demo account cannot send feedback.

## Decision
1. **Save first, then create the issue automatically, with no review step.** Each report is stored in `feedback`
   as `pending`. The server creates the issue right away, or the daily cron retries it later. The user always sees
   "received".
2. **The issue carries a per-report reference, `FB-` plus 8 characters, in its title and body.** It never carries a
   user id, email or name. Only the admin can resolve a reference to the reporter's email, and view that report's
   screenshot. This is the only exception to "admin sees aggregates only".
3. **Code cleans the text before it becomes public.** It removes invisible Unicode, emails, phone numbers, share
   tokens and uuids. The text sits in a code fence, so nothing in it renders or notifies anyone. Screenshots stay in
   a private bucket and never reach GitHub.
4. **There are two limits.** Each user can send 10 reports per Berlin day. Across the app, at most 30 issues are
   created per day (admin setting); reports above that ceiling wait as `pending`. There is no captcha. Demo accounts
   are blocked in the UI, the API and the database.
5. **Issues are created with Alex's fine-grained token (one repo, Issues only).** They get the labels `bug` or
   `enhancement` plus `reported-by-user`. The server never sets `claude`. Only Alex adds it, and that starts the
   workflow, which is designed separately and never merges. Branch protection requires Alex's approval on agent PRs.

## Consequences
- Report text is public without review, under Alex's account. Code removes only patterns it can detect (emails,
  phone numbers, share tokens, uuids), not names, dates or places in prose. The form warns users about this.
- GitHub failures and an expired token cost no reports, but they need an alert (`feedback_delivery`) and a rotation
  reminder in the runbook.
- Supabase Storage is used for the first time. Account deletion and the daily cron must clean it up, because objects
  do not cascade.
- CLAUDE.md gets one exception line for the admin lookup.
- Users see their own reports with status and issue link (owner RLS).
