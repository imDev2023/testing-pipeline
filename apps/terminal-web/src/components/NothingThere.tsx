"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND } from "@/brand";
import { ROUTES } from "@/routes";
import { SubjectAddress } from "./Address";
import styles from "./NothingThere.module.css";

const ADDRESS_PAGE = /^\/(?:markets|strategies)\/([^/]+)$/;

/**
 * The "nothing there" page (docs/spec/pipescope-screens.md, "On every page"): an address that is no
 * market or strategy gets a page saying so, with the address and a link to the feed (and to search,
 * once it lands). Any other unknown path gets a page saying there is no such page.
 */
export function NothingThere() {
  const match = ADDRESS_PAGE.exec(usePathname() ?? "");
  const address = match ? decodeURIComponent(match[1]!) : null;
  return (
    <div className={styles.page}>
      <h1>{address ? "Nothing at this address" : "No page here"}</h1>
      {address ? (
        <>
          <p>{BRAND.name} knows no market or strategy registered with Pipeline at this address:</p>
          <SubjectAddress address={address} />
        </>
      ) : (
        <p>There is no page at this address of {BRAND.name}.</p>
      )}
      <p>
        <Link href={ROUTES.feed}>Go to the feed</Link>
      </p>
    </div>
  );
}
