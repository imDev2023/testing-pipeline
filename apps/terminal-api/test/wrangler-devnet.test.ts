// The hosted devnet deployment, `terminal-api-devnet` (docs/spec/pipescope-architecture.md,
// Environments; #192). Wrangler carries no binding or var into an environment, so `env.devnet` names
// every one again; this keeps it the local run's twin, so each value still has one place, the
// top level, and a binding added there is never missing from the deployment.
import { readFileSync } from "node:fs";
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

type Config = Record<string, unknown> & { env: { devnet: Record<string, unknown> } };
const config = parse(readFileSync(`${import.meta.dirname}/../wrangler.jsonc`, "utf8")) as Config;
const devnet = config.env.devnet;

/** What the deployment holds apart from the local run: its own name, and the ids of the resources made for it. */
const OWN = ["name", "workers_dev", "hyperdrive", "kv_namespaces"];

describe("terminal-api's devnet environment", () => {
  it("is terminal-api-devnet on workers.dev", () => {
    expect(devnet).toMatchObject({ name: "terminal-api-devnet", workers_dev: true });
  });

  it("names again every binding, var, trigger and container of the local run, with the same values", () => {
    for (const key of Object.keys(config)) {
      if (["$schema", "name", "main", "compatibility_date", "compatibility_flags", "observability", "env", "migrations", ...OWN].includes(key)) continue;
      expect(devnet[key], key).toEqual(config[key]);
    }
  });

  it("reaches Postgres through the Hyperdrive made for it, under the local run's binding", () => {
    const [local] = config.hyperdrive as { binding: string; id: string }[];
    const [hosted] = devnet.hyperdrive as { binding: string; id: string }[];
    expect(hosted!.binding).toBe(local!.binding);
    expect(hosted!.id).toMatch(/^[0-9a-f]{32}$/);
    expect(hosted!.id).not.toBe(local!.id);
  });

  it("keeps its caches in the KV namespace made for it, under the local run's binding", () => {
    const [local] = config.kv_namespaces as { binding: string }[];
    const [hosted] = devnet.kv_namespaces as { binding: string; id: string }[];
    expect(hosted).toEqual({ binding: local!.binding, id: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it("asks for RPC_URL alone as a secret, and holds no wallet or LLM key (PIPESCOPE-37)", () => {
    expect(devnet.secrets).toEqual({ required: ["RPC_URL"] });
    expect(JSON.stringify(devnet)).not.toMatch(/ANTHROPIC|OPENAI|LLM_|_API_KEY|PRIVATE|SECRET_KEY|KEYPAIR/);
  });
});
