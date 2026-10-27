const focus =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400";

export const inputCls = `block min-h-11 w-full rounded-md border border-neutral-400 bg-transparent px-3 py-2 text-base aria-[invalid=true]:border-red-600 dark:border-neutral-500 dark:aria-[invalid=true]:border-red-400 ${focus}`;

const btn = `inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${focus}`;

export const btnPrimary = `${btn} bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-400 dark:text-neutral-950 dark:hover:bg-blue-300`;
export const btnSecondary = `${btn} border border-neutral-400 hover:bg-neutral-100 dark:border-neutral-500 dark:hover:bg-neutral-800`;
export const btnDanger = `${btn} bg-red-700 text-white hover:bg-red-800 dark:bg-red-400 dark:text-neutral-950 dark:hover:bg-red-300`;
export const btnIcon = `${btnSecondary} min-w-11 px-2`;

export const cardCls =
  "rounded-lg border border-neutral-300 p-4 dark:border-neutral-700";
export const mutedCls = "text-neutral-600 dark:text-neutral-400";
export const errorCls = "text-sm text-red-700 dark:text-red-400";
export const linkCls = `underline underline-offset-2 ${focus}`;
export const focusCls = focus;
