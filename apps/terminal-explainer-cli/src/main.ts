// `pnpm explainer:approve`, `pnpm explainer:reports`, `pnpm explainer:eval` and `pnpm explainer:count` (through tsx),
// run by the owner on their Mac (docs/spec/pipescope-architecture.md, "Explainer jobs"; EXPLAINER-05,
// EXPLAINER-06). The model's key is `ANTHROPIC_API_KEY` from `~/.config/env/global.env`, which the
// Anthropic SDK reads from the environment; the database is `DATABASE_URL`; the spend ledger is
// `~/.config/spend/ledger.csv` (`SPEND_LEDGER` names another, for a test). This is the only file that
// makes an Anthropic client.
//
//   approve [--only <key start>,...] [--yes]   list the pending keys, ask, pay for those approved
//   reports                                    list "This is wrong" reports with their keys
//   eval [--report <file>] [--yes]             the five samples and the hostile fixture set, measured
//   count                                      the eval inputs' exact input tokens, from the free
//                                              token-counting endpoint: no model call, nothing paid
import Anthropic from "@anthropic-ai/sdk";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createDb } from "terminal-db";
import { COST_ESTIMATE, modelRequest, type ModelRequest } from "terminal-explainer";
import { approve, evalInputs, evaluate, listReports } from "./commands";
import type { ModelClient } from "./generate";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { only: { type: "string" }, yes: { type: "boolean", default: false }, report: { type: "string" } },
});
const [command] = positionals;
const log = (line: string) => console.log(line);
const ledger = process.env.SPEND_LEDGER ?? join(homedir(), ".config/spend/ledger.csv");

/** The owner's yes: `--yes` given on the command line, or typed at the prompt. */
async function confirm(question: string): Promise<boolean> {
  if (values.yes) {
    log(`${question}yes (--yes)`);
    return true;
  }
  if (!process.stdin.isTTY) {
    log(`${question}no: there is no terminal to answer at, and --yes was not given.`);
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

/** The Anthropic SDK's client; the request shapes are the Messages API's, built by terminal-explainer. */
function anthropic(): Anthropic {
  return new Anthropic({ maxRetries: 2 });
}

const model = (client: Anthropic): ModelClient => ({
  create: (request: ModelRequest) => client.messages.create(request as unknown as Anthropic.MessageCreateParamsNonStreaming),
});

function database() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set: run with the project's .env (docs/toolchain.md, \"Aviary's local run\").");
  return createDb(url, { connectTimeoutSeconds: 10 });
}

async function main(): Promise<void> {
  switch (command) {
    case "approve": {
      const { db, close } = database();
      try {
        await approve({ db, model: model(anthropic()), ledger, log, confirm, only: values.only?.split(",").map((s) => s.trim()).filter(Boolean) });
      } finally {
        await close();
      }
      return;
    }
    case "reports": {
      const { db, close } = database();
      try {
        await listReports({ db, log });
      } finally {
        await close();
      }
      return;
    }
    case "eval": {
      const report = values.report ?? join(process.cwd(), `explainer-eval-${new Date().toISOString().slice(0, 10)}.json`);
      await evaluate({ model: model(anthropic()), ledger, report, log, confirm });
      return;
    }
    case "count": {
      const client = anthropic();
      let characters = 0;
      let counted = 0;
      for (const [name, input] of Object.entries(evalInputs())) {
        const { max_tokens: _, ...request } = modelRequest(input);
        const { input_tokens } = await client.messages.countTokens(request as unknown as Anthropic.MessageCountTokensParams);
        const length = JSON.stringify(modelRequest(input)).length;
        characters += length;
        counted += input_tokens;
        log(`${name}: ${input_tokens} input tokens (${length} characters, ${(length / input_tokens).toFixed(2)} a token)`);
      }
      log(`In all: ${counted} input tokens, ${(characters / counted).toFixed(2)} characters a token; COST_ESTIMATE.charactersPerToken is ${COST_ESTIMATE.charactersPerToken}.`);
      return;
    }
    default:
      log("Usage: node src/main.ts approve [--only <key start>,...] [--yes] | reports | eval [--report <file>] [--yes] | count");
      process.exitCode = 2;
  }
}

await main();
