import type { Metadata } from "next";
import { Suspense } from "react";
import { CreateMarket } from "@/components/create/CreateMarket";
import head from "@/components/heads/Head.module.css";
import page from "@/components/create/Create.module.css";
import { BRAND } from "@/brand";

export const metadata: Metadata = { title: "Create a market" };

/**
 * Create market (docs/spec/pipescope-screens.md, Create market; PIPESCOPE-20): a market made from a
 * registered strategy's own create form, with mints that already exist. The strategy chosen is kept in
 * the page's address.
 */
export default function CreatePage() {
  return (
    <div className={page.page}>
      <header className={head.head}>
        <h1>Create a market</h1>
        <p className={page.lede}>A market is made from a registered strategy&apos;s own create form, with mints that already exist. {BRAND.name} does not create tokens or register strategies; developers register a strategy from the command line.</p>
      </header>
      <Suspense fallback={null}>
        <CreateMarket />
      </Suspense>
    </div>
  );
}
