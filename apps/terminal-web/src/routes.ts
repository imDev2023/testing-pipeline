// Where each page lives, so a link is never written as a bare path.
export const ROUTES = {
  feed: "/",
  feedStrategies: "/?tab=strategies",
  devnetHelp: "/devnet",
  market: (address: string) => `/markets/${address}`,
  strategy: (address: string) => `/strategies/${address}`,
};
