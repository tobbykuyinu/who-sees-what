'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SEED_SOURCE = path.resolve(process.cwd(), 'data');

/** Fresh temp data dir (copied seeds, empty state) so tests never pollute
 *  the real data/state. */
export function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neoshare-test-'));
  fs.copyFileSync(path.join(SEED_SOURCE, 'data-room.json'), path.join(dir, 'data-room.json'));
  fs.copyFileSync(path.join(SEED_SOURCE, 'permissions.json'), path.join(dir, 'permissions.json'));
  return { dir };
}
