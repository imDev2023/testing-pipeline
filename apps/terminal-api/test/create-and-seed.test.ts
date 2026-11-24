// A new market created and seeded in one transaction (docs/spec/pool4-for-solana.md, Creating a
// market; #57): the router's `create_market` from the strategy's create form, `init_fee_account` for
// each of the new market's mints, and the strategy's seed action from its metadata, built against the
// market as `create_market` would leave it, which a simulation of `create_market` alone reports.
import { readFileSync } from "node:fs";
import * as pipeline from "@pipeline-sol/sdk";
import { NATIVE_MINT_ADDRESS, PIPELINE_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, type MetadataInit } from "@pipeline-sol/sdk";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { address, blockhash, generateKeyPairSigner, type Address, type Instruction } from "@solana/kit";
import { actionNamed } from "strategy-actions";
import { describe, expect, it } from "vitest";
import { createAndSeedTransaction, createMarketTransaction, marketViewAfterCreate } from "../src/trading/action";
import { fitTransaction } from "../src/trading/prepare";
import { Refused } from "../src/trading/quote";

const METADATA = JSON.parse(readFileSync(`${import.meta.dirname}/../../../programs/buy-wall-amm/metadata.json`, "utf8")) as Record<string, unknown>;
const BUY_WALL = address("BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6");
const TOKEN = address("9qTA6qhsFwpvDvqMmiQifnQK53ijsoFXYLpH2fJembd7");
const TRADER = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const programs = (instructions: readonly Instruction[]) => instructions.map((i) => i.programAddress);
const LIFETIME = { blockhash: blockhash("4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi"), lastValidBlockHeight: 100n };

/** IMD's launch values, the creator taking both recipient roles and the seed. */
const ARGS = { fee_bps: "100", wall_split_bps: "5000", fee_recipient: TRADER, reward_share_bps: "1500", rewards_recipient: TRADER, cap_floor_bps: "2000", cap_decay_bps: "2000", seeder: TRADER };

async function created(tokenProgram: Address) {
  const state = await generateKeyPairSigner();
  return createMarketTransaction({
    init: METADATA.init as MetadataInit,
    strategy: BUY_WALL,
    trader: TRADER,
    marketState: state.address,
    args: ARGS,
    inputs: { token_mint: TOKEN },
    tokenPrograms: { [TOKEN]: tokenProgram, [NATIVE_MINT_ADDRESS]: TOKEN_PROGRAM_ADDRESS },
    maxCreatorLamports: 100_000_000n,
  });
}

/** The new market as create_market would leave it, with the demo market's vault addresses. */
const viewOf = (built: Awaited<ReturnType<typeof created>>, tokenProgram: Address = TOKEN_PROGRAM_ADDRESS) => ({
  market: built.market,
  strategyProgram: BUY_WALL,
  marketState: built.marketState,
  mints: [TOKEN, NATIVE_MINT_ADDRESS],
  vaults: [address("8xZyjFv9maYh227Y4yyrSbMLiruna8sHKzmuoViv6dZc"), address("AsXnGex7us8spZKJ75ygGAk5y9Ghg22dCmNAtr4fgRig")],
  tokenPrograms: [tokenProgram, TOKEN_PROGRAM_ADDRESS],
  supportsExactOut: false,
});
const SEED = { token_amount: "1000000000000", sol_amount: "500000000" };

describe("createAndSeedTransaction", () => {
  it("puts create_market, a fee account for each mint and the seed in one transaction, wrapping the seed's SOL around them", async () => {
    const built = await created(TOKEN_PROGRAM_ADDRESS);
    const view = viewOf(built);
    const both = await createAndSeedTransaction({ create: built, view, seed: actionNamed(METADATA, "seed"), trader: TRADER, args: SEED, inputs: {} });
    // The wallet's wrapped-SOL account made and filled, the market made with its fee accounts, seeded, then the account closed back into the wallet.
    expect(programs(both.instructions)).toEqual([ASSOCIATED_TOKEN_PROGRAM_ADDRESS, SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, PIPELINE_PROGRAM_ADDRESS, PIPELINE_PROGRAM_ADDRESS, PIPELINE_PROGRAM_ADDRESS, BUY_WALL, TOKEN_PROGRAM_ADDRESS]);
    expect(both.wrapped).toBe(500_000_000n);
    expect(both.instructions[3]).toBe(built.instructions[0]);
    const fees = await Promise.all(view.mints.map((mint, i) => pipeline.initFeeAccount({ payer: TRADER, market: built.market, mint, tokenProgram: view.tokenPrograms[i]! })));
    expect(both.instructions.slice(4, 6)).toEqual(fees);
    expect(both.seed.accounts!.find((a) => a.address === built.marketState)).toBeTruthy();
  });

  it("fits in one transaction for an SPL Token and a Token-2022 token", async () => {
    for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
      const built = await created(tokenProgram);
      const both = await createAndSeedTransaction({ create: built, view: viewOf(built, tokenProgram), seed: actionNamed(METADATA, "seed"), trader: TRADER, args: SEED, inputs: {} });
      expect(fitTransaction(both.instructions, TRADER, LIFETIME, null).version).toBe("legacy");
    }
  });

  it("refuses a seed action that is not the strategy's add_liquidity action", async () => {
    const built = await created(TOKEN_PROGRAM_ADDRESS);
    const refusal = await createAndSeedTransaction({ create: built, view: viewOf(built), seed: actionNamed(METADATA, "settle"), trader: TRADER, args: {}, inputs: {} }).catch((e: unknown) => e);
    expect((refusal as Refused).failure).toMatchObject({ class: "bad_input", sentence: "settle is not a seed: only an add_liquidity action can follow a new market's creation." });
  });
});

describe("marketViewAfterCreate", () => {
  const DEMO = JSON.parse(readFileSync(`${import.meta.dirname}/fixtures/buy-wall-demo-market.json`, "utf8")) as { router_market: { address: Address; data: string } };

  it("reads the new market's mints and vaults from the router's Market account, as create_market's simulation leaves it", () => {
    const view = marketViewAfterCreate(DEMO.router_market.address, new Uint8Array(Buffer.from(DEMO.router_market.data, "base64")), { [TOKEN]: TOKEN_PROGRAM_ADDRESS, [NATIVE_MINT_ADDRESS]: TOKEN_PROGRAM_ADDRESS });
    expect(view).toMatchObject({
      market: DEMO.router_market.address,
      strategyProgram: BUY_WALL,
      marketState: "GJaWKKtnFXs8CiVDz3WqFwK6hdAZ2VLwh4vpBbEAb9EU",
      mints: [TOKEN, NATIVE_MINT_ADDRESS],
      vaults: ["8xZyjFv9maYh227Y4yyrSbMLiruna8sHKzmuoViv6dZc", "AsXnGex7us8spZKJ75ygGAk5y9Ghg22dCmNAtr4fgRig"],
      tokenPrograms: [TOKEN_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS],
    });
  });

  it("answers null for an account that is not a router Market", () => {
    expect(marketViewAfterCreate(TOKEN, new Uint8Array(82), {})).toBeNull();
  });
});
