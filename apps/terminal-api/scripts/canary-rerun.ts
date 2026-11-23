// `pnpm canary:rerun --market <m> | --strategy <s>`: the owner's manual re-run of Canary
// (docs/spec/pipescope-architecture.md, "Canary runner"; #124) on a market, or on every market of a
// strategy, under the strategy's current version. It signs the request with the operator wallet
// (`CANARY_OPERATOR` in wrangler.jsonc), the project's devnet wallet, whose key stays on this Mac,
// and posts it to the API, which hands it to the version's `CanaryRun`.
//
//   pnpm canary:rerun --market 7BctWoaSumdxkMBCXxMum59NV5CZJBvC33SCrcGa5CAK
//   pnpm canary:rerun --strategy BmXEmoN2PubGxDFae8BzxKZv4ZPaXULWYVGGLHsZg4V6 --api http://localhost:8841
//
// --api defaults to TERMINAL_API_URL, else the local run's http://localhost:8811; --keypair to
// ~/.config/testing-pipeline/devnet/wallet.json.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createKeyPairSignerFromBytes, getBase58Decoder, signBytes } from "@solana/kit";
import { canaryRerunMessage } from "../src/contract.ts";

const { values } = parseArgs({
  options: {
    market: { type: "string" },
    strategy: { type: "string" },
    api: { type: "string", default: process.env.TERMINAL_API_URL ?? "http://localhost:8811" },
    keypair: { type: "string", default: join(homedir(), ".config/testing-pipeline/devnet/wallet.json") },
  },
});
if ((values.market === undefined) === (values.strategy === undefined)) {
  console.error("Name one market (--market <address>) or one strategy (--strategy <program>).");
  process.exit(2);
}
const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(values.keypair, "utf8")) as number[]));
const payload = JSON.stringify({ ...(values.market ? { market: values.market } : { strategy: values.strategy }), wallet: signer.address, at: new Date().toISOString() });
const signature = getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, canaryRerunMessage(payload)));
const response = await fetch(`${values.api}/v1/canary/reruns`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload, signature }) });
const body = (await response.json().catch(() => null)) as { error?: string; version?: { program: string; deploySlot: string }; markets?: string[] } | null;
if (response.status !== 202) {
  console.error(`The API refused the re-run (${response.status}): ${body?.error ?? "no reason given"}`);
  process.exit(1);
}
console.log(`Canary will run ${body!.markets!.length} market(s) on version ${body!.version!.deploySlot} of ${body!.version!.program}: ${body!.markets!.join(", ")}`);
