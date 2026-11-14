import type { TourMode } from "@/lib/domain/tour";

/** Small line icons per mode (24 × 24, currentColor). Decorative: the text next to them names the mode. */
const PATHS: Record<TourMode, React.ReactNode> = {
  foot: (
    <>
      <circle cx="13" cy="4" r="2" />
      <path d="M10 21l2-6 3 3v3M12 15l-1-5 3-2 2 3 3 1M11 10l-3 2-1 4" />
    </>
  ),
  wheelchair: (
    <>
      <circle cx="10" cy="4" r="2" />
      <path d="M10 7v7h6l2 5M10 10h5" />
      <path d="M7 11.5a5.5 5.5 0 1 0 7.5 6" />
    </>
  ),
  cycling: (
    <>
      <circle cx="6" cy="16" r="4" />
      <circle cx="18" cy="16" r="4" />
      <path d="M6 16l4-8h5l3 8M10 8l3 8h-7M14 5h3" />
    </>
  ),
  ebike: (
    <>
      <circle cx="6" cy="16" r="4" />
      <circle cx="18" cy="16" r="4" />
      <path d="M6 16l4-8h5l3 8M10 8l3 8h-7" />
      <path d="M15 1l-2 4h3l-2 4" />
    </>
  ),
  car: (
    <>
      <path d="M4 16v-4l2-5h12l2 5v4z" />
      <path d="M4 12h16" />
      <circle cx="8" cy="17" r="1.5" />
      <circle cx="16" cy="17" r="1.5" />
    </>
  ),
};

export function ModeIcon({ mode, className }: { mode: TourMode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ?? "size-5 shrink-0"}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[mode]}
    </svg>
  );
}
