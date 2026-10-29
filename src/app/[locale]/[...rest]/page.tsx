import { notFound } from "next/navigation";

/** Unknown URL under a valid locale: render the localized not-found page (next-intl's documented catch-all). */
export default function CatchAll() {
  notFound();
}
