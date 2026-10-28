import { getTranslations } from "next-intl/server";
import { FactPanel } from "@/components/facts/fact-panel";
import { PlacesList } from "@/components/facts/places-list";
import { getPlacesFacts } from "@/lib/server/facts";
import type { PanelProps } from "./types";

export async function PlacesPanel({ trip, purpose, ctx }: PanelProps) {
  const t = await getTranslations("facts");
  const fact = await getPlacesFacts(trip, purpose, ctx);
  return (
    <FactPanel title={t("places.title")} fact={fact} fallbackSource="osm">
      {(data) => <PlacesList data={data} locale={ctx.locale} />}
    </FactPanel>
  );
}
