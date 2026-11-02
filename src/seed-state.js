'use strict';

/**
 * The room's release state at t0, derived from the deal narrative in the
 * mock data: the updated valuation (d-038) has arrived but has NOT been
 * released yet — Alpenland is waiting on exactly this document (party note:
 * "decision after updated valuation"). Every party except the case owner
 * and the valuer (who wrote it) is cut off until the analyst releases it.
 */

export const HELD_DOCS = ['d-038'];

export function makeSeedOverlay(idx) {
  const overlay = new Map();
  for (const docId of HELD_DOCS) {
    const { doc } = idx.docs.get(docId);
    const revokes = new Set(
      [...idx.parties.values()]
        .filter((p) => p.id !== idx.caseOwnerId && p.id !== doc.uploaded_by)
        .map((p) => p.id),
    );
    overlay.set(docId, { grants: new Set(), revokes, pending: new Set(), held: true });
  }
  return overlay;
}
