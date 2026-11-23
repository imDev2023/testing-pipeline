import Link from "next/link";
import { BRAND } from "@/brand";
import { ROUTES } from "@/routes";
import type { ThemeChoice } from "@/theme";
import styles from "./SiteFooter.module.css";
import { ThemeControl } from "./ThemeControl";
import { AiText, AuthorText } from "./Voice";

/**
 * The footer of every page (docs/spec/pipescope-screens.md, "On every page"): the three styles of
 * "Who is speaking", the devnet line, the links (Fees, Devnet help and the keeper page, PIPESCOPE-97)
 * and the theme control. The official Telegram bot and channel join once the API names them.
 */
export function SiteFooter({ theme }: { theme: ThemeChoice }) {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <section className={styles.voices} aria-labelledby="who-is-speaking">
          <h2 id="who-is-speaking" className={styles.heading}>
            Who is speaking
          </h2>
          <ul>
            <li>Plain text was read from the chain or measured by {BRAND.name}.</li>
            <li>
              <AiText>Text set like this was written by an AI from those facts.</AiText>
            </li>
            <li>
              <AuthorText>Text like this was written by a strategy&apos;s or token&apos;s author and is not verified.</AuthorText>
            </li>
          </ul>
        </section>
        <div className={styles.side}>
          <p className={styles.devnet}>
            Devnet only. {BRAND.name} never holds your keys: every transaction is signed in your own wallet, after a simulation you see first.
          </p>
          <nav className={styles.links} aria-label="About">
            <Link href={ROUTES.fees}>Fees</Link>
            <Link href={ROUTES.devnetHelp}>Devnet help</Link>
            <Link href={ROUTES.keeper}>Keeper</Link>
          </nav>
          <ThemeControl initial={theme} />
        </div>
      </div>
    </footer>
  );
}
