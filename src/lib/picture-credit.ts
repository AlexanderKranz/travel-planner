import type { DestinationPicture } from "@/lib/domain/picture";

export type PictureCredit = {
  /** Which message to use: with or without a named author. */
  variant: "withAuthor" | "licenseOnly";
  author: string;
  licenseName: string;
  /** Null for public domain files without a licence page: the licence is then shown as plain text. */
  licenseUrl: string | null;
  sourcePageUrl: string;
};

/** Credit line parts (Commons attribution): the author part is omitted when there is no author. */
export function pictureCredit(p: Pick<DestinationPicture, "author" | "licenseName" | "licenseUrl" | "sourcePageUrl">): PictureCredit {
  const author = p.author?.trim() ?? "";
  return {
    variant: author ? "withAuthor" : "licenseOnly",
    author,
    licenseName: p.licenseName,
    licenseUrl: p.licenseUrl,
    sourcePageUrl: p.sourcePageUrl,
  };
}
