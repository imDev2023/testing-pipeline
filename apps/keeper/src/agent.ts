// The launchd agent that runs the keeper on the owner's Mac (docs/spec/keeper-runner.md,
// "Running it"): `testing-pipeline.keeper`, with RunAtLoad and KeepAlive, starting
// scripts/keeper-run.sh, which loads the environment launchd lacks and runs the built program.

import { homedir } from 'node:os';
import { join } from 'node:path';

export const LABEL = 'testing-pipeline.keeper';
export const LOG_FILE = join(homedir(), 'Library/Logs/testing-pipeline-keeper.log');
export const PLIST_FILE = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The agent's property list, for a checkout at `repo`. */
export function plist(repo: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${escape(join(repo, 'scripts/keeper-run.sh'))}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${escape(repo)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- A crash loop (no key, no RPC) retries at most once a minute. -->
    <key>ThrottleInterval</key>
    <integer>60</integer>
    <key>StandardOutPath</key>
    <string>${escape(LOG_FILE)}</string>
    <key>StandardErrorPath</key>
    <string>${escape(LOG_FILE)}</string>
</dict>
</plist>
`;
}
