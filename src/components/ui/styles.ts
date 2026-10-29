// Shared Atlas class strings. Colours come from the semantic tokens in src/app/globals.css
// (they flip for dark mode on their own), so no dark: variants are needed here.
const focus = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

export const inputCls = `block min-h-11 w-full rounded-lg border border-line-strong bg-card px-3 py-2 text-base text-ink placeholder:text-subtle aria-[invalid=true]:border-danger-line ${focus}`;

const btn = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-5 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;

export const btnPrimary = `${btn} bg-accent text-white hover:bg-accent-hover`;
export const btnSecondary = `${btn} border-[1.5px] border-heading text-heading hover:bg-hover`;
export const btnDanger = `${btn} bg-danger-solid text-white hover:bg-danger-hover`;
export const btnIcon = `${btnSecondary} min-w-11 px-2`;
/** Quiet text button (header sign-out and similar). */
export const btnGhost =
  "inline-flex min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2";

export const cardCls = "rounded-[14px] border border-line bg-card p-4 sm:p-5";
export const mutedCls = "text-muted";
export const errorCls = "text-sm text-danger";
export const linkCls = `font-medium text-heading underline underline-offset-2 hover:text-accent-text ${focus}`;
export const focusCls = focus;

/** Small uppercase letter-spaced label (eyebrows, tile captions, table heads). */
export const labelCls = "font-sans text-xs font-semibold uppercase tracking-[0.12em] text-subtle";
/** Terracotta variant of the label, used for eyebrows and section kickers. */
export const eyebrowCls = "text-xs font-semibold uppercase tracking-[0.16em] text-accent-text";
/** Neutral and accent pills. */
export const pillCls = "inline-flex items-center rounded-full border border-heading/60 px-3 py-0.5 text-xs font-medium text-heading";
export const pillSolidCls = "inline-flex items-center rounded-full bg-heading px-3 py-0.5 text-xs font-semibold text-page";
export const pillAccentCls = "inline-flex items-center rounded-full bg-accent-soft px-3 py-0.5 text-xs font-semibold text-accent-soft-fg";
