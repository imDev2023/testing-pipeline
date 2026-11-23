// The devnet script's commands. Run `npm run cli -- help` for the list.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { borrow, repayAll } from "./borrower.ts";
import { openContext, type Context } from "./context.ts";
import { deposit, redeem } from "./ctokens.ts";
import { setEmergencyMode } from "./emergency.ts";
import { checkLayout, formatChecks } from "./layout-check.ts";
import { supplySecondDepositor, takeBack } from "./parties.ts";
import { CTOKEN_HOLDER, DEVNET, RESERVES, RESERVE_KEYS, TEST_BORROWER, type ReserveKey } from "./policy.ts";
import { prove } from "./prove.ts";
import { refreshReserves } from "./refresh.ts";
import { setup } from "./setup.ts";
import { statusReport, units } from "./status.ts";

const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const DEFAULT_ADDRESSES = resolve(PACKAGE_DIR, "../../deployments/kamino-devnet.json");
const DEFAULT_KEYS = join(homedir(), ".config/testing-pipeline/devnet");
const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const HELP = `Usage: npm run cli -- <command> [options]

Commands:
  setup                          create (or check) the lending market, the test USDC mint and both reserves
  status                         per reserve: supply, borrowed, free liquidity, utilisation, stored rate, flags
  layout                         check the reserves and the lending market against the spec's offsets
  supply [--reserve R]           the second depositor (devnet wallet) tops its supply up to its target
  take-back --reserve R --amount N|all
                                 the second depositor takes liquidity back
  ctoken-deposit --reserve R [--amount N]
                                 the plain cToken holder deposits (default: its amount in src/policy.ts)
  ctoken-redeem --reserve R [--ctokens N]
                                 the plain cToken holder redeems (default: every cToken it holds)
  borrow [--amount N]            the test borrower borrows WSOL against test USDC (default ${units(TEST_BORROWER.borrow, 9)} SOL)
  repay                          the test borrower repays its WSOL debt in full
  emergency on|off [--market]    the market owner sets the WSOL reserve's (or the whole market's) emergency mode
  refresh [--reserve R]          anyone (the devnet wallet pays) refreshes each reserve's stored rate (default: both)
  prove                          run every check of the ticket in one go and print signatures and SOL spent

  R is wsol or usdc; N is in whole tokens (SOL or test USDC), for example 0.5.

Options:
  --url URL          RPC (default ${DEVNET}, or RPC_URL); only devnet or a local validator
  --keys DIR         key folder (default ${DEFAULT_KEYS}, or KEYS_DIR)
  --addresses FILE   address book (default deployments/kamino-devnet.json in this repo)`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string", default: process.env.RPC_URL ?? DEVNET },
      keys: { type: "string", default: process.env.KEYS_DIR ?? DEFAULT_KEYS },
      addresses: { type: "string", default: DEFAULT_ADDRESSES },
      reserve: { type: "string" },
      amount: { type: "string" },
      ctokens: { type: "string" },
      market: { type: "boolean", default: false },
    },
  });
  const [command, argument] = positionals;
  if (!command || command === "help") {
    console.log(HELP);
    return;
  }
  const ctx = await openContext({ url: values.url, keysDir: values.keys, bookPath: values.addresses });
  await refuseOtherClusters(ctx);
  const reserve = () => reserveKey(values.reserve);
  switch (command) {
    case "setup":
      await setup(ctx);
      break;
    case "status":
      console.log((await statusReport(ctx)).text);
      break;
    case "layout": {
      const checks = await checkLayout(ctx);
      console.log(formatChecks(checks));
      if (!checks.every((c) => c.ok)) process.exitCode = 1;
      break;
    }
    case "supply":
      for (const key of values.reserve ? [reserve()] : RESERVE_KEYS) {
        const result = await supplySecondDepositor(ctx, key);
        if (!result) console.log(`${RESERVES[key].label}: the second depositor's supply already reaches its target`);
      }
      break;
    case "take-back": {
      const key = reserve();
      if (!values.amount) throw new Error("take-back needs --amount N or --amount all");
      const result = await takeBack(ctx, key, values.amount === "all" ? "all" : baseUnits(values.amount, key));
      console.log(`Received ${units(result.received, RESERVES[key].decimals)} ${RESERVES[key].label}`);
      break;
    }
    case "ctoken-deposit": {
      const key = reserve();
      const amount = values.amount ? baseUnits(values.amount, key) : CTOKEN_HOLDER[key];
      const result = await deposit(ctx, ctx.keys.ctokenHolder, key, amount, `plain cToken holder deposits ${RESERVES[key].label}`);
      console.log(`Received ${result.ctokens} cTokens`);
      break;
    }
    case "ctoken-redeem": {
      const key = reserve();
      const ctokens = values.ctokens ? BigInt(values.ctokens) : "all";
      const result = await redeem(ctx, ctx.keys.ctokenHolder, key, ctokens, `plain cToken holder redeems ${RESERVES[key].label}`);
      console.log(`Received ${units(result.received, RESERVES[key].decimals)} ${RESERVES[key].label} for ${result.ctokens} cTokens`);
      break;
    }
    case "borrow":
      await borrow(ctx, values.amount ? baseUnits(values.amount, "wsol") : TEST_BORROWER.borrow);
      break;
    case "repay": {
      const result = await repayAll(ctx);
      console.log(`Repaid ${units(result.repaid, 9)} SOL`);
      break;
    }
    case "emergency": {
      if (argument !== "on" && argument !== "off") throw new Error("emergency needs on or off");
      const signature = await setEmergencyMode(ctx, values.market ? "market" : "reserve", argument === "on");
      if (!signature) console.log(`Emergency mode is already ${argument}`);
      break;
    }
    case "refresh":
      for (const r of await refreshReserves(ctx, values.reserve ? [reserve()] : RESERVE_KEYS)) {
        console.log(`${RESERVES[r.key].label} reserve refreshed in slot ${r.slot}`);
      }
      break;
    case "prove":
      await prove(ctx);
      break;
    default:
      throw new Error(`unknown command ${command}; run npm run cli -- help`);
  }
}

/**
 * Devnet only, until Pipeline's router is on mainnet; local validators are for tests. Errors name the RPC by its host
 * alone, since a provider's URL can carry an API key.
 */
async function refuseOtherClusters(ctx: Context) {
  const { hostname } = new URL(ctx.chain.url);
  if (hostname === "127.0.0.1" || hostname === "localhost") return;
  const hash = await ctx.chain.genesisHash();
  if (hash !== DEVNET_GENESIS_HASH) throw new Error(`the RPC at ${hostname} is not devnet (genesis hash ${hash}); this script runs on devnet only`);
}

function reserveKey(name: string | undefined): ReserveKey {
  if (name === "wsol") return "wsol";
  if (name === "usdc") return "testUsdc";
  throw new Error("--reserve must be wsol or usdc");
}

function baseUnits(text: string, key: ReserveKey): bigint {
  const decimals = RESERVES[key].decimals;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[2]?.length ?? 0) > decimals) throw new Error(`${text} is not an amount with at most ${decimals} decimals`);
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt((match[2] ?? "").padEnd(decimals, "0") || "0");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
