// Where each page lives, so a link is never written as a bare path.
export const ROUTES = {
  feed: "/",
  feedStrategies: "/?tab=strategies",
  devnetHelp: "/devnet",
  fees: "/fees",
  keeper: "/keeper",
  wallet: "/wallet",
  search: (query: string) => `/search?q=${encodeURIComponent(query)}`,
  market: (address: string) => `/markets/${address}`,
  strategy: (address: string) => `/strategies/${address}`,
};
