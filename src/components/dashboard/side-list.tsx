import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { cardCls, focusCls, linkCls, mutedCls } from "@/components/ui/styles";

export const SIDE_LIST_MAX = 5;

export type SideListItem = { id: string; name: string };

type Props = {
  id: string;
  title: string;
  items: SideListItem[];
  itemHref: string;
  addHref: string;
  addLabel: string;
  allHref: string;
  emptyText: string;
};

function Body({ items, itemHref, addHref, addLabel, allHref, emptyText }: Omit<Props, "id" | "title">) {
  const t = useTranslations("trips");
  const shown = items.slice(0, SIDE_LIST_MAX);
  return (
    <div className="flex flex-col gap-1">
      {shown.length === 0 ? (
        <p className={`text-sm ${mutedCls}`}>{emptyText}</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((item) => (
            <li key={item.id}>
              <Link href={`${itemHref}/${item.id}`} className={`${linkCls} flex min-h-11 items-center break-words`}>
                {item.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        <Link href={addHref} className={`${linkCls} inline-flex min-h-11 items-center text-sm`}>
          {addLabel}
        </Link>
        {items.length > SIDE_LIST_MAX && (
          <Link href={allHref} className={`${linkCls} inline-flex min-h-11 items-center text-sm`}>
            {t("showAll", { count: items.length })}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Compact list for the dashboard side. <details> cannot start open by breakpoint, so phones get a
 * collapsed <details> (below md) and desktop an always-open section (md and up).
 */
export function SideList({ id, title, ...rest }: Props) {
  return (
    <>
      <details className={`${cardCls} group md:hidden`}>
        <summary
          className={`-m-2 flex min-h-11 cursor-pointer list-none items-center justify-between rounded-lg p-2 font-serif text-lg font-bold text-heading ${focusCls}`}
        >
          <span>
            {title} <span className={`font-sans text-sm font-normal ${mutedCls}`}>({rest.items.length})</span>
          </span>
          <span aria-hidden className="transition-transform group-open:rotate-180">
            ▾
          </span>
        </summary>
        <div className="mt-2">
          <Body {...rest} />
        </div>
      </details>
      <section aria-labelledby={id} className={`${cardCls} hidden md:block`}>
        <h2 id={id} className="mb-1 font-serif text-lg font-bold text-heading">
          {title}
        </h2>
        <Body {...rest} />
      </section>
    </>
  );
}
