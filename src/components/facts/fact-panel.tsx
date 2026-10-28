import type { Fact, SourceId } from "@/lib/domain";
import { cardCls } from "@/components/ui/styles";
import { FactUnavailable } from "./fact-unavailable";
import { SourceNote } from "./source-note";

/** Card with heading, then the data (ok) or an explanation (unavailable) plus the source note. */
export function FactPanel<T>({
  title,
  fact,
  fallbackSource,
  className,
  children,
  extraNote,
}: {
  title: string;
  fact: Fact<T>;
  fallbackSource?: SourceId;
  className?: string;
  children: (data: T) => React.ReactNode;
  extraNote?: React.ReactNode;
}) {
  return (
    <section aria-label={title} className={`${cardCls} min-w-0 ${className ?? ""}`}>
      <h2 className="mb-3 text-lg font-bold">
        {title}
      </h2>
      {fact.status === "ok" ? (
        <>
          {children(fact.data)}
          <SourceNote
            source={fact.source}
            sourceUrl={fact.sourceUrl}
            fetchedAt={fact.fetchedAt}
            stale={fact.stale}
          >
            {extraNote}
          </SourceNote>
        </>
      ) : (
        <>
          <FactUnavailable fact={fact} />
          {(fact.source ?? fallbackSource) && <SourceNote source={(fact.source ?? fallbackSource)!} />}
        </>
      )}
    </section>
  );
}
