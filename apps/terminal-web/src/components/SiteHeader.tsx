import Link from "next/link";
import { BRAND } from "@/brand";
import { CLUSTER } from "@/config";
import { ROUTES } from "@/routes";
import { NavLink } from "./NavLink";
import { WalletButton } from "./wallet/WalletButton";
import styles from "./SiteHeader.module.css";

/**
 * The header of every page: the name, the devnet tag, the links to the pages that exist and the
 * wallet button. Create market, Wallet and the search box join as their pages land
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
        <WalletButton />
      </div>
    </header>
  );
}
