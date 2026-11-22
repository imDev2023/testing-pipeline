import { describe, expect, it } from "vitest";
import { EXPLORER } from "../src/config";

describe("explorer links", () => {
  it("stay on devnet whatever the address or signature holds", () => {
    expect(EXPLORER.address("x?cluster=mainnet-beta#")).toBe("https://explorer.solana.com/address/x%3Fcluster%3Dmainnet-beta%23?cluster=devnet");
    expect(EXPLORER.transaction("../address/y")).toBe("https://explorer.solana.com/tx/..%2Faddress%2Fy?cluster=devnet");
  });
});
