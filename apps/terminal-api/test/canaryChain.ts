// A Pipeline market as the chain holds it, for Canary's tests: the router and a strategy program
// with their ProgramData, the router's config, the market with its state, mints, vaults and fee
// accounts, and, for a Token-2022 mint, a transfer hook program with its validation account.
import {
  BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS,
  NATIVE_MINT_ADDRESS,
  PIPELINE_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  configPda,
  encodeAccount,
  feeAccountPda,
  getMarketCodec,
  programDataPda,
  strategyPda,
} from "@pipeline-sol/sdk";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import type { FakeAccount, FakeRpc } from "terminal-indexer/testing";
import { programAddress, programDataAccount } from "terminal-indexer/testing/programs";

const addressBytes = (a: string) => getAddressEncoder().encode(address(a));

/** An upgradeable program's account: its tag (2) and the address of its ProgramData. */
function programAccount(programData: string): FakeAccount {
  const data = new Uint8Array(36);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(addressBytes(programData), 4);
  return { owner: BPF_LOADER_UPGRADEABLE_PROGRAM_ADDRESS, data, executable: true };
}

/** An initialised SPL mint's 82 bytes, with no authority. */
function mintBase(decimals: number): Uint8Array {
  const data = new Uint8Array(82);
  new DataView(data.buffer).setBigUint64(36, 1_000_000_000n, true);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

/** A Token-2022 mint with a transfer hook extension naming `hook`. */
function hookedMint(hook: string): Uint8Array {
  const data = new Uint8Array(165 + 1 + 4 + 64);
  data.set(mintBase(6), 0);
  data[165] = 1; // AccountType::Mint
  const view = new DataView(data.buffer);
  view.setUint16(166, 14, true); // ExtensionType::TransferHook
  view.setUint16(168, 64, true);
  data.set(addressBytes(hook), 170 + 32);
  return data;
}

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

export type CanaryChain = {
  market: string;
  strategy: string;
  strategyProgramData: string;
  /** The strategy's executable, whose SHA-256 the version is known by. */
  executable: Uint8Array;
  deploySlot: bigint;
  hook: string;
  hookedMint: string;
  /** Every address a snapshot's first round reads, and whether the chain has an account there. */
  firstRound: Map<string, boolean>;
  /** An account the strategy's account resolution names, which only a later round asks for. */
  resolved: string;
};

/**
 * Puts a two-mint market into `rpc`: wrapped SOL against a Token-2022 mint with a transfer hook.
 * The hooked mint's fee account does not exist yet, as on a market no one has paid a fee in.
 * Markets of one strategy share its `strategySeed`.
 */
export async function putMarket(rpc: FakeRpc, { seed = 1, strategySeed = seed, deploySlot = 500n, executable = bytes(64, 7) }: { seed?: number; strategySeed?: number; deploySlot?: bigint; executable?: Uint8Array } = {}): Promise<CanaryChain> {
  const strategy = await programAddress(strategySeed);
  const hook = await programAddress(seed + 100);
  const marketState = await programAddress(seed + 200);
  const market = await programAddress(seed + 300);
  const mintB = await programAddress(seed + 400);
  const vaultA = await programAddress(seed + 500);
  const vaultB = await programAddress(seed + 600);
  const resolved = await programAddress(seed + 700);
  const firstRound = new Map<string, boolean>();
  const put = (at: string, account: FakeAccount | null) => {
    if (account) rpc.accounts.set(at, account);
    firstRound.set(at, account !== null);
  };

  const routerData = await programDataPda(PIPELINE_PROGRAM_ADDRESS);
  put(PIPELINE_PROGRAM_ADDRESS, programAccount(routerData));
  put(routerData, programDataAccount(100n, bytes(32, 1)));
  put(await configPda(), { owner: PIPELINE_PROGRAM_ADDRESS, data: bytes(120, 2) });

  const strategyProgramData = await programDataPda(address(strategy));
  put(strategy, programAccount(strategyProgramData));
  put(strategyProgramData, programDataAccount(deploySlot, executable));
  put(await strategyPda(address(strategy)), { owner: PIPELINE_PROGRAM_ADDRESS, data: bytes(80, 3) });
  put(marketState, { owner: strategy, data: bytes(200, 4) });

  const mints = [NATIVE_MINT_ADDRESS, address(mintB)];
  const vaults = [address(vaultA), address(vaultB)];
  const none = address("11111111111111111111111111111111");
  put(
    market,
    {
      owner: PIPELINE_PROGRAM_ADDRESS,
      data: encodeAccount("Market", getMarketCodec(), {
        strategyProgram: address(strategy),
        marketState: address(marketState),
        mintCount: 2,
        mints: [...mints, none, none],
        vaults: [...vaults, none, none],
        supportsExactOut: false,
        createdBy: address("8qTRTAXmbpVCFmKRNH5nkF2XGb1HpSDhjeqkyaqMvQC2"),
        createdAt: 1_763_000_000n,
        bump: 255,
        feeAuthorityBump: 254,
        feeMintIndex: 0,
      }),
    },
  );
  put(NATIVE_MINT_ADDRESS, { owner: TOKEN_PROGRAM_ADDRESS, data: mintBase(9) });
  put(mintB, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: hookedMint(hook) });
  put(vaultA, { owner: TOKEN_PROGRAM_ADDRESS, data: bytes(165, 5) });
  put(vaultB, { owner: TOKEN_2022_PROGRAM_ADDRESS, data: bytes(182, 6) });
  put(await feeAccountPda(address(market), NATIVE_MINT_ADDRESS, TOKEN_PROGRAM_ADDRESS), { owner: TOKEN_PROGRAM_ADDRESS, data: bytes(165, 8) });
  put(await feeAccountPda(address(market), address(mintB), TOKEN_2022_PROGRAM_ADDRESS), null);

  const hookProgramData = await programDataPda(address(hook));
  put(hook, programAccount(hookProgramData));
  put(hookProgramData, programDataAccount(90n, bytes(32, 9)));
  const [validation] = await getProgramDerivedAddress({ programAddress: address(hook), seeds: [new TextEncoder().encode("extra-account-metas"), addressBytes(mintB)] });
  put(validation, { owner: hook, data: bytes(60, 10) });

  rpc.accounts.set(resolved, { owner: strategy, data: bytes(40, 11) });
  return { market, strategy, strategyProgramData, executable, deploySlot, hook, hookedMint: mintB, firstRound, resolved };
}
