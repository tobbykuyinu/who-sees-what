'use strict';

/**
 * store.js — the only module that touches disk. Loads the two seed JSONs
 * once, holds the live overlay + change log in memory, and persists both so
 * a restart never loses history (a disclosure mistake must survive a crash,
 * not vanish with it).
 */

import fs from 'node:fs';
import path from 'node:path';

export function createStore(dataDir, stateDir = path.join(dataDir, 'state')) {
  const dataRoom = readJSON(path.join(dataDir, 'data-room.json'));
  const permissions = readJSON(path.join(dataDir, 'permissions.json'));

  const overlayPath = path.join(stateDir, 'overlay.json');
  const logPath = path.join(stateDir, 'log.jsonl');

  const fresh = !fs.existsSync(overlayPath); // empty/fresh state dir -> seed on boot
  let overlay = readOverlay(overlayPath); // null => seed below once the index exists
  const log = readLog(logPath);           // newest first

  const persist = () => {
    fs.mkdirSync(stateDir, { recursive: true });
    const tmp = overlayPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(overlayToPlain(overlay), null, 2));
    fs.renameSync(tmp, overlayPath);
    const line = JSON.stringify(log[0] ?? {}) + '\n';
    fs.appendFileSync(logPath, line);
  };

  return {
    dataRoom,
    permissions,
    get overlay() { return overlay; },
    get log() { return log; },
    /** seed the overlay once the engine index exists (first boot only) */
    seedOverlay(seed) {
      if (overlay === null) { overlay = seed; persist(); }
    },
    /** seed the deal-story history — fresh state dirs only, never duplicates */
    seedLog(entries) {
      if (fresh && log.length === 0 && entries.length) {
        log.push(...entries); // entries arrive newest-first
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(logPath, entries.slice().reverse().map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    },
    /** apply a computed change: swap the overlay, unshift the log entry */
    apply(nextOverlay, entry) {
      overlay = nextOverlay;
      log.unshift(entry);
      persist();
    },
  };
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readOverlay(p) {
  if (!fs.existsSync(p)) return null;
  const plain = readJSON(p);
  const overlay = new Map();
  for (const [docId, ov] of Object.entries(plain)) {
    overlay.set(docId, {
      grants: new Set(ov.grants || []),
      revokes: new Set(ov.revokes || []),
      pending: new Set(ov.pending || []),
      held: !!ov.held,
    });
  }
  return overlay;
}

function overlayToPlain(overlay) {
  const plain = {};
  for (const [docId, ov] of overlay) {
    plain[docId] = {
      grants: [...ov.grants],
      revokes: [...ov.revokes],
      pending: [...ov.pending],
      held: ov.held,
    };
  }
  return plain;
}

function readLog(p) {
  if (!fs.existsSync(p)) return [];
  const entries = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  return entries.reverse(); // file is append-only, oldest first
}
