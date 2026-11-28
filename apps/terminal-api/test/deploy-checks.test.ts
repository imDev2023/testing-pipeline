// What `pnpm terminal:deploy` (scripts/deploy.ts) checks before and after it deploys Aviary's devnet
// Workers (#192): the URL wrangler gives each Worker, the secrets the API holds (PIPESCOPE-37), and
// that `/health` answers from the version just deployed with the database and the RPC reachable.
import { describe, expect, it } from "vitest";
import { deployedProblem, secretsProblem, workersDevUrl } from "../scripts/deployChecks";

describe("the workers.dev URL", () => {
  it("is read from what wrangler printed for the Worker deployed", () => {
    const output = "Uploaded terminal-api-devnet (12.3 sec)\nDeployed terminal-api-devnet triggers (1.2 sec)\n  https://terminal-api-devnet.rc-labs.workers.dev\n  schedule: * * * * *\nCurrent Version ID: 1234";
    expect(workersDevUrl(output, "terminal-api-devnet")).toBe("https://terminal-api-devnet.rc-labs.workers.dev");
  });

  it("is refused when wrangler printed none for that Worker", () => {
    expect(() => workersDevUrl("  https://terminal-web-devnet.rc-labs.workers.dev", "terminal-api-devnet")).toThrow("wrangler printed no workers.dev URL for terminal-api-devnet");
  });
});

describe("the API's secrets", () => {
  it("pass when RPC_URL is there and nothing else but the verified builds' GitHub token", () => {
    expect(secretsProblem(["RPC_URL"])).toBeNull();
    expect(secretsProblem(["GH_ACTIONS_TOKEN", "RPC_URL"])).toBeNull();
  });

  it("are refused without RPC_URL, saying how to set it", () => {
    expect(secretsProblem([])).toMatch(/RPC_URL is not set.*--set-rpc-url/);
  });

  it("are refused when any other secret is there, since none may be a wallet or an LLM key", () => {
    expect(secretsProblem(["RPC_URL", "ANTHROPIC_API_KEY"])).toBe("terminal-api-devnet holds secrets it must not: ANTHROPIC_API_KEY (PIPESCOPE-37)");
  });
});

describe("the deployed API's /health", () => {
  const healthy = {
    ok: true,
    cluster: "devnet",
    database: { ok: true, latencyMs: 40, migrations: 25, error: null },
    rpc: { ok: true, latencyMs: 90, slot: 527_000_000, error: null },
    version: { id: "v-1", tag: "5e6b64fabc12", timestamp: "2026-11-28T12:00:00Z" },
  };

  it("passes when it answers from the commit deployed, with the database and the RPC reachable", () => {
    expect(deployedProblem(healthy, "5e6b64fabc12")).toBeNull();
  });

  it("names an older version still answering", () => {
    expect(deployedProblem({ ...healthy, version: { ...healthy.version, tag: "d127592aaaaa" } }, "5e6b64fabc12")).toBe("/health answers from d127592aaaaa, not 5e6b64fabc12 yet");
  });

  it("names what is unreachable", () => {
    expect(deployedProblem({ ...healthy, ok: false, database: { ok: false, latencyMs: null, migrations: null, error: "the database did not answer" } }, "5e6b64fabc12")).toBe(
      "/health is not ok: database: the database did not answer",
    );
  });
});
