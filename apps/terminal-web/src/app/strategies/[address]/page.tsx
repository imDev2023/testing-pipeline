import { notFound } from "next/navigation";

/**
 * Until the indexer lands, Aviary knows no market or strategy, so every address here gets the
 * "nothing there" page with a 404. The page that shows one replaces this with its ticket (#116, #117, #118).
 */
export default function AddressPage() {
  notFound();
}
