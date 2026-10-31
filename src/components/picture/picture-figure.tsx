"use client";

import Image from "next/image";
import { useState } from "react";

/** Band plus credit. A picture that fails to load (e.g. Wikimedia throttling) removes both: no broken image, no gap. */
export function PictureFigure({ src, alt, children }: { src: string; alt: string; children: React.ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1.5">
      <div className="relative h-[140px] w-full overflow-hidden rounded-[14px] border border-line bg-hover sm:h-[180px] lg:h-[220px]">
        <Image
          src={src}
          alt={alt}
          fill
          priority
          sizes="(min-width: 1280px) 1200px, 100vw"
          className="object-cover object-center"
          onError={() => setFailed(true)}
        />
      </div>
      {children}
    </figure>
  );
}
