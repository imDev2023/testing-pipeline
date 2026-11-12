// `pnpm client`: generates the containment hook's TypeScript client in client/ from its Anchor IDL
// (../idl/containment_hook.json, built by `pnpm idl`), with Codama, as the owner's other projects do.
// The launch script reads the config with it, and Aviary will. Never edit client/ by hand:
// change the program, rebuild the IDL, and regenerate.
//
// `node codama.ts --check` generates into a temporary folder instead and fails if client/
// differs, so `pnpm typecheck` (and CI with it) catches a client older than the IDL.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rootNodeFromAnchor, type AnchorIdl } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';

const here = fileURLToPath(new URL('.', import.meta.url));
const idlPath = fileURLToPath(new URL('../idl/containment_hook.json', import.meta.url));
const check = process.argv.includes('--check');

async function generate(root: string) {
    const idl = JSON.parse(readFileSync(idlPath, 'utf8')) as AnchorIdl;
    await createFromRoot(rootNodeFromAnchor(idl)).accept(
        renderVisitor(root, {
            generatedFolder: 'client',
            kitImportStrategy: 'rootOnly',
            syncPackageJson: false,
            // Runnable by Node's type stripping, as the demo is: no enums, and `.ts` imports.
            erasableSyntax: true,
            importExtension: 'ts',
        }),
    );
}

/** Every file under `dir`, by its path relative to `dir`, with its contents. */
function files(dir: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            const path = join(entry.parentPath, entry.name);
            out.set(relative(dir, path), readFileSync(path, 'utf8'));
        }
    }
    return out;
}

if (!check) {
    await generate(here);
    console.log(`generated ${join(here, 'client')} from idl/containment_hook.json`);
} else {
    const scratch = mkdtempSync(join(tmpdir(), 'containment-hook-client-'));
    try {
        await generate(scratch);
        const fresh = files(join(scratch, 'client'));
        const committed = files(join(here, 'client'));
        const differing = [...new Set([...fresh.keys(), ...committed.keys()])].filter(
            (path) => fresh.get(path) !== committed.get(path),
        );
        if (differing.length > 0) {
            console.error(`client/ is not what idl/containment_hook.json generates; run \`pnpm client\`:\n  ${differing.join('\n  ')}`);
            process.exit(1);
        }
        console.log('client/ matches idl/containment_hook.json');
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
