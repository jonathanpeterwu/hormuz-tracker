// Points to the active rules version.
// To upgrade: create rules/v4.md, update the path here, deploy.
// Git history tracks every rule change with full diffs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CURRENT_VERSION = 'v3.4';

export const rulesVersion = CURRENT_VERSION;
export const rules = readFileSync(join(__dirname, `${CURRENT_VERSION}.md`), 'utf-8');
