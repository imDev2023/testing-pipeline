// The fixture RPC server as Playwright's first web server: `node src/serve-rpc.ts [--record]`.
// Recording passes each request on to RPC_URL, read from the environment so its key never shows on a
// command line.
import { serveRpc } from "./rpc.ts";

const upstream = process.argv.includes("--record") ? process.env.RPC_URL : undefined;
if (process.argv.includes("--record") && !upstream) throw new Error("--record needs RPC_URL in the environment.");
await serveRpc({ upstream });
console.log(upstream ? "recording devnet answers" : "serving recorded devnet answers");
