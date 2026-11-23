import type { MarketMint } from "terminal-api/contract";
import { AviaryMark } from "./AviaryMark";
import styles from "./MintLabel.module.css";
import { ShortAddress } from "./ShortAddress";
import { TokenImage } from "./TokenImage";
import { AuthorText } from "./Voice";

/**
 * A mint as every page names it (docs/spec/pipescope-screens.md, "Token names and images";
 * PIPESCOPE-22, PIPESCOPE-82): SOL and USDC by Aviary's own name, set plainly, with the mark that
 * ships with the app; a token that names itself by its own symbol (or else its name) in the author's
 * style, with its image from Aviary's copy when one was kept and always with its mint's short
 * address beside it, since the name is the author's claim; any other mint by its short address alone.
 */
export function MintLabel({ mint, symbol, token }: Pick<MarketMint, "mint" | "symbol"> & { token: MarketMint["token"] }) {
  if (symbol) {
    return (
      <span className={styles.unit} title={mint}>
        <AviaryMark mint={mint} />
        {symbol}
      </span>
    );
  }
  const name = token?.symbol ?? token?.name;
  if (!name) return <ShortAddress address={mint} />;
  return (
    <span className={styles.label}>
      <span className={styles.unit}>
        {/* Keyed by its hash, so a new image is tried even after an earlier one failed to load. */}
        {token?.image && <TokenImage key={token.image} hash={token.image} />}
        <AuthorText>{name}</AuthorText>
      </span>{" "}
      <ShortAddress address={mint} />
    </span>
  );
}
