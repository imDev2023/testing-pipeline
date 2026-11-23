"use client";

import { useState } from "react";
import { API_URL } from "@/config";
import styles from "./MintLabel.module.css";

/**
 * A token's image, 20 px square, from Aviary's own copy (`/images/<hash>` on the API), never from its
 * author's server (PIPESCOPE-82). Its box has a fixed size, so no row's height depends on an author's
 * file; it gets no border, tick or mark of Aviary's; and an image that cannot be loaded shows nothing,
 * no placeholder.
 */
export function TokenImage({ hash }: { hash: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    // A plain <img>: the bytes are Aviary's own copy already, so Next's image optimiser has nothing to add.
    // eslint-disable-next-line @next/next/no-img-element
    <img className={styles.image} src={`${API_URL}/images/${hash}`} width={20} height={20} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  );
}
