import { labelCls } from "@/components/ui/styles";

/** Fact tile: small uppercase caption, big serif value, one quiet line below (Atlas). */
export function Tile({ label, value, children }: { label: string; value: React.ReactNode; children?: React.ReactNode }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-1 rounded-xl border border-line bg-card p-4 sm:p-5">
      <h3 className={labelCls}>{label}</h3>
      <p className="break-words font-serif text-2xl font-bold leading-tight text-heading sm:text-[1.75rem]">{value}</p>
      {children}
    </section>
  );
}
