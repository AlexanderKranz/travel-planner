import { useTranslations } from "next-intl";
import { linkCls } from "@/components/ui/styles";
import type { DestinationPictureResult } from "@/lib/domain/picture";
import { pictureCredit } from "@/lib/picture-credit";
import { PictureFigure } from "./picture-figure";

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

/**
 * Photo band above the trip title (owner page and share page). Served through the Next image optimizer, so the
 * viewer's browser never contacts Wikimedia. Fixed height with object-cover: no layout shift, banners and photos alike.
 * Credit line (author, licence, source, "cropped") sits directly under it, as CC BY-SA requires.
 */
export function DestinationPictureBand({ picture, placeName }: { picture: DestinationPictureResult; placeName: string }) {
  const t = useTranslations("picture");
  const c = pictureCredit(picture);
  const licence = (chunks: React.ReactNode) =>
    c.licenseUrl ? (
      <a href={c.licenseUrl} {...ext} className={linkCls}>
        {chunks}
      </a>
    ) : (
      chunks
    );
  return (
    <PictureFigure src={picture.url} alt={t("alt", { place: placeName })}>
      <figcaption className="min-w-0 break-words text-xs text-muted sm:text-right [overflow-wrap:anywhere]">
        {t.rich(c.variant === "withAuthor" ? "creditAuthor" : "creditLicense", {
          author: c.author,
          license: c.licenseName,
          lic: licence,
        })}{" "}
        <a href={c.sourcePageUrl} {...ext} className={linkCls}>
          {t("source")}
        </a>
        . {t("cropped")}
      </figcaption>
    </PictureFigure>
  );
}
