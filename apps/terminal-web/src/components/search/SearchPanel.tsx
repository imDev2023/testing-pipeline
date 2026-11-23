"use client";

import { useCallback } from "react";
import { Panel } from "../Panel";
import { searchApi } from "./SearchBox";
import { SearchResultsView } from "./SearchResults";

/** The search page's results, a panel that loads and fails on its own. */
export function SearchPanel({ query }: { query: string }) {
  const load = useCallback((signal: AbortSignal) => searchApi(query, signal), [query]);
  return (
    <Panel title={`Results for “${query}”`} what="the results" load={load}>
      {(results) => <SearchResultsView results={results} heading="h3" />}
    </Panel>
  );
}
