import type { Fact } from "@/lib/domain";
import { SourcesLine, sourceItem } from "./sources-line";

/** Collapsed section for a long table. Closed by default so the page needs little scrolling. */
export function FactDetails<T>({
  title,
  fact,
  children,
}: {
  title: string;
  fact: Fact<T>;
  children: (data: T) => React.ReactNode;
}) {
  if (fact.status !== "ok") return null;
  return (
    <details className="group rounded-lg border border-neutral-300 dark:border-neutral-700">
      <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-lg px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-blue-600 dark:focus-visible:outline-blue-400">
        {title}
        <span aria-hidden="true" className="transition-transform group-open:rotate-180">▾</span>
      </summary>
      <div className="flex flex-col gap-3 border-t border-neutral-200 p-4 dark:border-neutral-800">
        {children(fact.data)}
        <SourcesLine items={[sourceItem(fact)]} />
      </div>
    </details>
  );
}
