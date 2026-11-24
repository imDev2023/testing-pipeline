import Link from "next/link";
import { BRAND } from "@/brand";
import { CLUSTER } from "@/config";
import { ROUTES } from "@/routes";
import { Suspense } from "react";
import { NavLink } from "./NavLink";
import { SearchBox } from "./search/SearchBox";
import searchStyles from "./search/SearchBox.module.css";
import { WalletButton } from "./wallet/WalletButton";
import styles from "./SiteHeader.module.css";

/**
 * The header of every page: the name, the devnet tag, the links to the pages that exist and the
 * search box and the wallet button. Create market and Wallet join as their pages land
 * (docs/spec/pipescope-screens.md, "On every page").
 */
export function SiteHeader() {
  return (
    <header className={styles.header}>
      <a className={styles.skip} href="#main">
        Skip to the page
      </a>
      <div className={styles.bar}>
        <div className={styles.brand}>
          <Link href={ROUTES.feed} className={styles.name}>
            {BRAND.name}
          </Link>
          <span className={styles.tag}>{CLUSTER}</span>
        </div>
        <nav className={styles.links} aria-label="Pages">
          <NavLink href={ROUTES.feed}>Feed</NavLink>
        </nav>
        {/* Until the box reads the page's address, the same field as a plain form, which Enter still submits. */}
        <Suspense
          fallback={
            <form role="search" action="/search" className={searchStyles.search}>
              <input className={searchStyles.input} type="search" name="q" aria-label="Search" placeholder="Search strategies, markets and mints" />
            </form>
          }
        >
          <SearchBox />
        </Suspense>
        <WalletButton />
      </div>
    </header>
  );
}
