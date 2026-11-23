import { Feed } from "@/components/feed/Feed";
import { filtersFrom } from "@/feedFilters";

/**
 * The feed's page: markets by default, strategies on `?tab=strategies`, so a tab can be linked, and
 * the markets' filters read from the address, so a filtered feed can be linked too.
 */
export default async function FeedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  return <Feed tab={params.tab === "strategies" ? "strategies" : "markets"} filters={filtersFrom(params)} />;
}
