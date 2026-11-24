import { describe, expect, it } from "vitest";
import { measure } from "../src/trading/prepare";

const WALLET = "E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW";
const WSOL_ATA = "Fro9sz5j2CjPtSJ9KyiT21RZxqXfGY92wx9r5YpYWsPe";
const TOKEN_ATA = "GpQBQYmVnF8YUQFPo5zKfByiZPtx8LwwnAReW5CEXoZm";
const FEE_ACCOUNT = "8Zp1XYra8KUSDj3CpS4FbnAPewCncTPPWtz9Aq4b7L2N";
const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN = "6DsWfiJk2zcHAgYjsMZYULGrVgzeedtnKbdy76vReMyp";
const RENT = 2_039_280n;

/** A token account holding `amount`, with the rent it carries (and, for wrapped SOL, the lamports it wraps). */
const tokenAccount = (amount: bigint, wrapped = false) => {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { lamports: RENT + (wrapped ? amount : 0n), data: [Buffer.from(data).toString("base64"), "base64"] as const };
};
const sol = (lamports: bigint) => ({ lamports, data: ["", "base64"] as const });
const watched = [WALLET, WSOL_ATA, TOKEN_ATA, FEE_ACCOUNT] as const;

describe("what the simulation says a swap takes and gives", () => {
  it("on a buy paid in SOL, counts the swap's SOL apart from the network fee and the rent of the token account it creates", () => {
    const m = measure({
      watched,
      mints: [null, WSOL, TOKEN],
      before: [sol(1_000_000_000n), null, null, tokenAccount(0n)],
      after: [sol(1_000_000_000n - 100_000_000n - 5_000n - RENT), null, tokenAccount(86_063_877_914n), tokenAccount(248_139n)],
      networkFee: 5_000n,
      paysSol: true,
      receivesSol: false,
    });
    expect(m).toMatchObject({ paid: "100000000", received: "86063877914", market_rent: "0", new_accounts: [{ account: TOKEN_ATA, mint: TOKEN, rent: String(RENT) }] });
  });

  it("does not count wrapped SOL the wallet already held, which closing its account hands back as SOL", () => {
    const held = 500_000_000n;
    const m = measure({
      watched,
      mints: [null, WSOL, TOKEN],
      before: [sol(1_000_000_000n), tokenAccount(held, true), tokenAccount(1n), tokenAccount(0n)],
      after: [sol(1_000_000_000n - 100_000_000n - 5_000n + RENT + held), null, tokenAccount(2n), tokenAccount(248_139n)],
      networkFee: 5_000n,
      paysSol: true,
      receivesSol: false,
    });
    expect(m).toMatchObject({ paid: "100000000", received: "1", new_accounts: [] });
  });

  it("counts the rent of the market's fee account the swap creates, apart from what it gives", () => {
    const m = measure({
      watched,
      mints: [null, TOKEN, WSOL],
      before: [sol(1_000_000_000n), tokenAccount(5_000_000n), null, null],
      after: [sol(1_000_000_000n + 5_212n - 5_000n - RENT), tokenAccount(0n), null, tokenAccount(14n)],
      networkFee: 5_000n,
      paysSol: false,
      receivesSol: true,
    });
    expect(m).toMatchObject({ paid: "5000000", received: "5212", market_rent: String(RENT), new_accounts: [] });
  });
});
