import Image from "next/image";
import { useTranslations } from "next-intl";
import { linkCls } from "@/components/ui/styles";
import type { DestinationPictureResult } from "@/lib/domain/picture";
import { pictureCredit } from "@/lib/picture-credit";

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
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <div className="relative h-[140px] w-full overflow-hidden rounded-[14px] border border-line bg-hover sm:h-[180px] lg:h-[220px]">
        <Image
          src={picture.url}
          alt={t("alt", { place: placeName })}
          fill
          priority
          sizes="(min-width: 1280px) 1200px, 100vw"
          className="object-cover object-center"
        />
      </div>
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
    </figure>
  );
}
