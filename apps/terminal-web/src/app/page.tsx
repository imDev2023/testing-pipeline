import { Feed } from "@/components/feed/Feed";

/** The feed's page: markets by default, strategies on `?tab=strategies`, so a tab can be linked. */
export default async function FeedPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const { tab } = await searchParams;
  return <Feed tab={tab === "strategies" ? "strategies" : "markets"} />;
}
