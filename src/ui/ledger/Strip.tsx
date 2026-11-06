"use client";

import { useEffect, useState } from "react";
import { stripStyle, type Box } from "./proof";

// A printed line of the receipt, cut out of its published (blurred) photo: the photo is the strip's background,
// scaled and moved so exactly the line's box shows. The photo's size is read once per URL.

const sizes = new Map<string, Promise<{ width: number; height: number }>>();

function photoSize(url: string) {
  let p = sizes.get(url);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => {
        sizes.delete(url);
        reject(new Error(`no photo at ${url}`));
      };
      img.src = url;
    });
    sizes.set(url, p);
  }
  return p;
}

function usePhotoSize(url: string) {
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  useEffect(() => {
    let live = true;
    photoSize(url).then(
      (s) => live && setSize({ url, ...s }),
      () => live && setSize(null),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return size?.url === url ? size : null;
}

/** The line's strip, at most maxW × maxH; nothing while the photo loads or if it cannot. */
export function Strip({ url, box, maxW, maxH, label, className }: { url: string; box: Box; maxW: number; maxH: number; label: string; className?: string }) {
  const size = usePhotoSize(url);
  if (!size) return null;
  const s = stripStyle(box, size, maxW, maxH);
  return (
    <span
      className={`lg-strip${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      style={{ width: s.width, height: s.height, backgroundImage: `url("${url}")`, backgroundSize: s.backgroundSize, backgroundPosition: s.backgroundPosition }}
    />
  );
}
