import { DestinationPictureBand } from "@/components/picture/destination-picture";
import { getSharedDestinationPicture } from "@/lib/server/facts";

/** Share page photo. Cache only; render it only for a token whose plan document was already returned. */
export async function SharedPicture({ token, placeName }: { token: string; placeName: string }) {
  const picture = await getSharedDestinationPicture(token);
  return picture ? <DestinationPictureBand picture={picture} placeName={placeName} /> : null;
}
