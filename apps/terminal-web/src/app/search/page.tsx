import type { Metadata } from "next";
import head from "@/components/heads/Head.module.css";
import { StaticPanel } from "@/components/Panel";
import { SearchPanel } from "@/components/search/SearchPanel";
import { SearchHelp } from "@/components/search/SearchResults";
import page from "@/components/search/SearchPage.module.css";

type Props = { searchParams: Promise<{ q?: string | string[] }> };

const queryOf = async (searchParams: Props["searchParams"]) => {
  const q = (await searchParams).q;
  return (typeof q === "string" ? q : "").trim();
};

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const query = await queryOf(searchParams);
  return { title: query ? `Search: ${query}` : "Search" };
}

/**
 * The search page (docs/spec/pipescope-screens.md, Search): where Enter in the header's box goes,
 * its address holding the query, so a search can be shared or reloaded. With nothing to search for,
 * it says what can be searched for, with three examples.
 */
export default async function SearchPage({ searchParams }: Props) {
  const query = await queryOf(searchParams);
  return (
    <div className={page.page}>
      <header className={head.head}>
        <h1>Search</h1>
      </header>
      {query ? (
        <SearchPanel query={query} />
      ) : (
        <StaticPanel title="What you can search for">
          <SearchHelp />
        </StaticPanel>
      )}
    </div>
  );
}
