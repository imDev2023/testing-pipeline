// The hostile metadata fixtures (docs/spec/pipescope-explainer.md, Testing): documents a hostile
// author could publish, each a valid strategy metadata document by Pipeline's validator, so Aviary
// shows its author text and the explainer would read it. The web app's tests render every one, and
// none may become a link or markup.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const HOSTILE_METADATA_DIR = join(import.meta.dirname, "../fixtures/hostile-metadata");

/** Each fixture by its file's name, without `.json`, as the parsed JSON a fetch would give. */
export const hostileMetadata: Record<string, unknown> = Object.fromEntries(
  readdirSync(HOSTILE_METADATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => [f.slice(0, -".json".length), JSON.parse(readFileSync(join(HOSTILE_METADATA_DIR, f), "utf8"))]),
);
