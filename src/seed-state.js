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

/**
 * The deal story as change-log history (newest first), so the demo opens with
 * a room that has a past — "what does Fjord know?" is answerable immediately.
 * Seeded ONLY into a fresh state dir (store.seedLog) so re-runs never duplicate.
 * Shape matches the frontend's local seed: {ts, action, actor, actionSummary,
 * affectedParties[], docs[]}.
 */
export function makeSeedLog(idx) {
  const party = (id) => ({ id, name: idx.parties.get(id).name });
  const doc = (id) => ({ id, name: idx.docs.get(id).doc.name.en });
  const banksPastNda = ['bank-b', 'bank-c', 'bank-d']; // committed + NDA-signed banks
  return [
    {
      ts: '2026-10-06T09:00:00.000Z', action: 'release', actor: 'Nordwall analyst',
      actionSummary: 'Released Q&A log to banks past the NDA gate',
      affectedParties: banksPastNda.map(party), docs: [doc('d-072')],
    },
    {
      ts: '2026-09-15T09:00:00.000Z', action: 'release', actor: 'Nordwall analyst',
      actionSummary: 'Released rent roll, September to banks past the NDA gate',
      affectedParties: banksPastNda.map(party), docs: [doc('d-026')],
    },
    {
      ts: '2026-09-08T09:00:00.000Z', action: 'release', actor: 'Nordwall analyst',
      actionSummary: 'Released updated land register extract to banks past the NDA gate',
      affectedParties: banksPastNda.map(party), docs: [doc('d-017')],
    },
    {
      ts: '2026-08-19T09:00:00.000Z', action: 'declined', actor: 'Nordwall analyst',
      actionSummary: 'Fjord Pfandbrief Bank declined: access revoked, snapshot frozen',
      affectedParties: [party('bank-e')], docs: [],
    },
    {
      ts: '2026-07-09T09:00:00.000Z', action: 'nda_signed', actor: 'Nordwall analyst',
      actionSummary: 'Alpenland signed the NDA: due-diligence room released',
      affectedParties: [party('bank-d')],
      docs: ['d-051', 'd-052', 'd-053', 'd-054', 'd-055', 'd-056', 'd-057', 'd-058'].map(doc),
    },
  ];
}
