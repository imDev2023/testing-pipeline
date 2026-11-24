// Transfer-hook extra accounts (docs/spec/pipescope-architecture.md, Trading path; PIPESCOPE-33),
// resolved by Aviary's own code from each mint's `ExtraAccountMetaList`, since neither Pipeline's SDK
// nor its hosted API does it: a sell's go in the router's `input_hook_accounts`, a buy's after the
// strategy's own accounts, and every transfer the swap makes in a hooked mint is covered, the fees
// included. The chain here is a fake RPC serving the accounts a hook's validation account names.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@pipeline-sol/sdk";
import { findAssociatedTokenPda } from "@solana-program/token-2022";
import { AccountRole, address, createSolanaRpc, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { actionHookAccounts, hookAccounts, swapHookAccounts } from "../src/trading/hooks";
import { Refused } from "../src/trading/quote";
import type { TradeMint } from "../src/trading/market";

const HOOK = at(1);
const MINT = at(2);
const PLAIN = address("So11111111111111111111111111111111111111112");
const TRADER = address("E69PqdUigwXRBdCBR5LfkACb9f342QsRK8oRGGdtJnAW");
const TRADER_ATA = at(4);
const VAULT = at(5);
const POOL = at(6);
const FEE_ACCOUNT = at(7);
const WHITELIST = at(8);
const STASH = at(9);

/** A made-up address, the same each run. */
function at(n: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).map((_, i) => (i === 0 ? n : i === 31 ? 200 : 7)));
}

const EXECUTE = [105, 37, 101, 197, 75, 251, 102, 26];
const encoder = getAddressEncoder();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** One `ExtraAccountMeta`: its discriminator, 32 bytes of address or seed config, then signer and writable. */
type Meta = { discriminator: number; config: Uint8Array; writable: boolean };
const fixed = (at: Address, writable = false): Meta => ({ discriminator: 0, config: new Uint8Array(encoder.encode(at)), writable });
/** A PDA of the hook program from seeds, each packed as the interface packs them, padded to 32 bytes. */
const pda = (seeds: number[], writable = false): Meta => {
  const config = new Uint8Array(32);
  config.set(seeds);
  return { discriminator: 1, config, writable };
};
const literal = (text: string) => [1, text.length, ...Buffer.from(text)];
const accountKey = (index: number) => [3, index];

/** A validation account: the Execute entry's discriminator, its length, the count, then each 35-byte meta. */
function validation(metas: Meta[]): Uint8Array {
  const body = new Uint8Array(4 + 35 * metas.length);
  const view = new DataView(body.buffer);
  view.setUint32(0, metas.length, true);
  metas.forEach((m, i) => {
    const at = 4 + 35 * i;
    body[at] = m.discriminator;
    body.set(m.config, at + 1);
    body[at + 33] = 0;
    body[at + 34] = m.writable ? 1 : 0;
  });
  const data = new Uint8Array(12 + body.length);
  data.set(EXECUTE);
  new DataView(data.buffer).setUint32(8, body.length, true);
  data.set(body, 12);
  return data;
}

/** A token account owned by `owner`: its mint, then its owner at byte 32. */
function tokenAccount(owner: Address): Uint8Array {
  const data = new Uint8Array(165);
  data.set(encoder.encode(owner), 32);
  return data;
}

let server: Server | null = null;
afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

/** A fake RPC serving `accounts` (base64 data owned by `owner`) to getAccountInfo and getMultipleAccounts; every request asked is kept. */
async function chain(accounts: Record<string, { owner: Address; data: Uint8Array }>) {
  const asked: string[] = [];
  const view = (a: string) => (accounts[a] ? { lamports: 1_000_000, owner: accounts[a].owner, data: [b64(accounts[a].data), "base64"], executable: false, rentEpoch: 0, space: accounts[a].data.length } : null);
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: [string | string[]] };
      asked.push(method);
      const value = method === "getMultipleAccounts" ? (params[0] as string[]).map(view) : view(params[0] as string);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result: { context: { slot: 1 }, value } }));
    });
  });
  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));
  return { rpc: createSolanaRpc(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/`), asked };
}

const hooked: TradeMint = { address: MINT, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, decimals: 6, transferHook: HOOK };
const plain: TradeMint = { address: PLAIN, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS, decimals: 9, transferHook: null };

async function validationPda(): Promise<Address> {
  return (await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["extra-account-metas", encoder.encode(MINT)] }))[0];
}

describe("a hooked mint's extra accounts, from its ExtraAccountMetaList", () => {
  it("names nothing for a mint with no transfer hook, and asks the chain nothing", async () => {
    const { rpc, asked } = await chain({});
    expect(await hookAccounts(rpc, plain, [{ source: TRADER_ATA, destination: VAULT, owner: TRADER, amount: 1n }])).toEqual([]);
    expect(asked).toEqual([]);
  });

  it("resolves a fixed account, then the hook program and its validation account, all read-only, as Token-2022 asks for them", async () => {
    const list = await validationPda();
    const { rpc } = await chain({ [list]: { owner: HOOK, data: validation([fixed(WHITELIST)]) } });
    expect(await hookAccounts(rpc, hooked, [{ source: TRADER_ATA, destination: VAULT, owner: TRADER, amount: 1n }])).toEqual([
      { address: WHITELIST, role: AccountRole.READONLY },
      { address: HOOK, role: AccountRole.READONLY },
      { address: list, role: AccountRole.READONLY },
    ]);
  });

  it("derives an account from seeds naming the transfer's own accounts, so each transfer's accounts are its own, and covers every transfer once", async () => {
    const list = await validationPda();
    // A PDA of the hook seeded by the transfer's destination (account 2), writable, as an allowlist hook keys a recipient.
    const { rpc } = await chain({ [list]: { owner: HOOK, data: validation([fixed(STASH, true), pda([...literal("seen"), ...accountKey(2)], true)]) } });
    const seen = async (destination: Address) => (await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["seen", encoder.encode(destination)] }))[0];
    const accounts = await hookAccounts(rpc, hooked, [
      { source: TRADER_ATA, destination: VAULT, owner: TRADER, amount: 1_000n },
      { source: TRADER_ATA, destination: FEE_ACCOUNT, owner: TRADER, amount: 3n },
    ]);
    expect(accounts).toEqual([
      { address: STASH, role: AccountRole.WRITABLE },
      { address: await seen(VAULT), role: AccountRole.WRITABLE },
      { address: HOOK, role: AccountRole.READONLY },
      { address: list, role: AccountRole.READONLY },
      { address: await seen(FEE_ACCOUNT), role: AccountRole.WRITABLE },
    ]);
  });

  it("names nothing more than the hook program and validation account when the hook asks for no extra accounts", async () => {
    const list = await validationPda();
    const { rpc } = await chain({ [list]: { owner: HOOK, data: validation([]) } });
    expect(await hookAccounts(rpc, hooked, [{ source: TRADER_ATA, destination: VAULT, owner: TRADER, amount: 1n }])).toEqual([
      { address: HOOK, role: AccountRole.READONLY },
      { address: list, role: AccountRole.READONLY },
    ]);
  });
});

describe("a swap's hook accounts, where the router and the strategy look for them", () => {
  const base = { trader: TRADER, traderInput: TRADER_ATA, traderOutput: at(10), feeAccount: FEE_ACCOUNT, integratorAccount: null, amountIn: 1_000n, amountOut: 2_000n, pipelineFee: 3n, integratorFee: 5n };

  it("puts a sell's in the router's input hook accounts, covering the trader's transfer into the vault and Pipeline's fee taken in the input", async () => {
    const list = await validationPda();
    const { rpc } = await chain({ [list]: { owner: HOOK, data: validation([pda([...literal("seen"), ...accountKey(2)])]) } });
    const seen = async (destination: Address) => (await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["seen", encoder.encode(destination)] }))[0];
    const { input, output } = await swapHookAccounts(rpc, { ...base, inputMint: hooked, outputMint: plain, inputVault: VAULT, outputVault: at(11), feeSide: "input" });
    expect(output).toEqual([]);
    expect(input.map((a) => a.address)).toEqual([await seen(VAULT), HOOK, list, await seen(FEE_ACCOUNT)]);
  });

  it("covers a sell's integrator fee too, when one is charged in the input", async () => {
    const list = await validationPda();
    const integrator = at(12);
    const { rpc } = await chain({ [list]: { owner: HOOK, data: validation([pda([...literal("seen"), ...accountKey(2)])]) } });
    const { input } = await swapHookAccounts(rpc, { ...base, integratorAccount: integrator, inputMint: hooked, outputMint: plain, inputVault: VAULT, outputVault: POOL, feeSide: "output" });
    const seen = async (destination: Address) => (await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["seen", encoder.encode(destination)] }))[0];
    expect(input.map((a) => a.address)).toEqual([await seen(VAULT), HOOK, list, await seen(integrator)]);
  });

  it("puts a buy's after the strategy's accounts, for the vault paying the trader, signed for by whoever owns the vault", async () => {
    const list = await validationPda();
    // The hook names the transfer's owner (account 3): the vault's owner, read from the vault itself.
    const { rpc } = await chain({
      [list]: { owner: HOOK, data: validation([pda([...literal("by"), ...accountKey(3)])]) },
      [VAULT]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: tokenAccount(POOL) },
    });
    const by = (await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["by", encoder.encode(POOL)] }))[0];
    const { input, output } = await swapHookAccounts(rpc, { ...base, inputMint: plain, outputMint: hooked, inputVault: at(13), outputVault: VAULT, feeSide: "input" });
    expect(input).toEqual([]);
    expect(output.map((a) => a.address)).toEqual([by, HOOK, list]);
  });

  it("covers Pipeline's fee taken from a hooked output, which the router pays out of the strategy's accounts", async () => {
    const list = await validationPda();
    const { rpc } = await chain({
      [list]: { owner: HOOK, data: validation([pda([...literal("seen"), ...accountKey(2)])]) },
      [VAULT]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: tokenAccount(POOL) },
    });
    const seen = async (destination: Address) => (await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["seen", encoder.encode(destination)] }))[0];
    const { output } = await swapHookAccounts(rpc, { ...base, inputMint: plain, outputMint: hooked, inputVault: at(13), outputVault: VAULT, feeSide: "output" });
    expect(output.map((a) => a.address)).toEqual([await seen(base.traderOutput), HOOK, list, await seen(FEE_ACCOUNT)]);
  });

  it("asks nothing of the chain for a swap between two plain mints", async () => {
    const { rpc, asked } = await chain({});
    expect(await swapHookAccounts(rpc, { ...base, inputMint: plain, outputMint: { ...plain, address: MINT }, inputVault: VAULT, outputVault: POOL, feeSide: "input" })).toEqual({ input: [], output: [] });
    expect(asked).toEqual([]);
  });

  it("refuses, decoded and naming the hook, a swap whose hook's accounts cannot be worked out, rather than failing the request", async () => {
    const list = await validationPda();
    // The hook's list derives an account from the data of the trader's output account, which this swap is still to create.
    const fromData = pda([...literal("held"), 4, 2, 32, 32]);
    const { rpc } = await chain({ [list]: { owner: HOOK, data: validation([fromData]) }, [VAULT]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: tokenAccount(POOL) } });
    const refused = await swapHookAccounts(rpc, { ...base, inputMint: plain, outputMint: hooked, inputVault: at(13), outputVault: VAULT, feeSide: "input" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Refused);
    expect((refused as Refused).failure).toMatchObject({ class: "hook_refused", program: HOOK });
    expect((refused as Refused).failure.sentence).toMatch(/^The token's transfer hook needs accounts Aviary could not work out, so there is no swap to build: /);
  });

  it("refuses a buy whose vault cannot be read, naming the vault", async () => {
    const list = await validationPda();
    const { rpc } = await chain({ [list]: { owner: HOOK, data: validation([]) } });
    const refused = await swapHookAccounts(rpc, { ...base, inputMint: plain, outputMint: hooked, inputVault: at(13), outputVault: VAULT, feeSide: "input" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Refused);
    expect((refused as Refused).failure.sentence).toContain(VAULT);
  });
});

describe("a custom action's hook accounts, after the action's own (Pipeline's strategies forward every account after their own)", () => {
  const market = (mints: TradeMint[], vaults: Address[]) => ({ mints, view: { vaults } }) as unknown as Parameters<typeof actionHookAccounts>[1]["market"];

  it("covers a hooked mint's transfers both ways between the wallet's token account, which the action writes, and the market's vault", async () => {
    const list = await validationPda();
    const [walletAccount] = await findAssociatedTokenPda({ owner: TRADER, mint: MINT, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const { rpc } = await chain({
      [list]: { owner: HOOK, data: validation([pda([...literal("seen"), ...accountKey(2)])]) },
      [VAULT]: { owner: TOKEN_2022_PROGRAM_ADDRESS, data: tokenAccount(POOL) },
    });
    const seen = async (destination: Address) => (await getProgramDerivedAddress({ programAddress: HOOK, seeds: ["seen", encoder.encode(destination)] }))[0];
    const action = { programAddress: at(30), accounts: [{ address: TRADER, role: AccountRole.READONLY_SIGNER }, { address: walletAccount, role: AccountRole.WRITABLE }, { address: VAULT, role: AccountRole.WRITABLE }] };
    const accounts = await actionHookAccounts(rpc, { market: market([plain, hooked], [at(20), VAULT]), trader: TRADER, action });
    expect(accounts.map((a) => a.address)).toEqual([await seen(VAULT), HOOK, list, await seen(walletAccount)]);
  });

  it("adds nothing when the action does not write the wallet's account of a hooked mint, or the market has none", async () => {
    const { rpc, asked } = await chain({});
    const [walletAccount] = await findAssociatedTokenPda({ owner: TRADER, mint: MINT, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });
    const readOnly = { programAddress: at(30), accounts: [{ address: walletAccount, role: AccountRole.READONLY }] };
    expect(await actionHookAccounts(rpc, { market: market([plain, hooked], [at(20), VAULT]), trader: TRADER, action: readOnly })).toEqual([]);
    expect(await actionHookAccounts(rpc, { market: market([plain], [at(20)]), trader: TRADER, action: readOnly })).toEqual([]);
    expect(asked).toEqual([]);
  });
});

