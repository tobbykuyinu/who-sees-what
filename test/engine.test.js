'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildIndex, effectiveVisibility, computePreview, computeApply,
  buildAccessMatrix,
} from '../src/engine.js';
import { makeSeedOverlay } from '../src/seed-state.js';

const dataRoom = JSON.parse(fs.readFileSync(path.resolve('data/data-room.json'), 'utf8'));
const idx = buildIndex(dataRoom);
const overlay = makeSeedOverlay(idx);

const vis = (partyId, docId, ov = overlay) => effectiveVisibility(idx, ov, partyId, docId);

test('index: 78 documents, 11 parties, version chains detected', () => {
  assert.equal(idx.docs.size, 78);
  assert.equal(idx.parties.size, 11);
  assert.deepEqual(idx.predecessorIds.get('d-038'), ['d-037']);
  assert.deepEqual(idx.predecessorIds.get('d-065').sort(), ['d-063', 'd-064']);
  assert.deepEqual(idx.predecessorIds.get('d-026'), ['d-025']);
  assert.deepEqual(idx.predecessorIds.get('d-011'), ['d-010']);
  assert.equal(idx.predecessorIds.has('d-039'), false, 'mortgage lending value must not join the valuation chain');
});

test('case owner sees everything, always', () => {
  assert.equal(vis('bank-a', 'd-038').visible, true);
  assert.equal(vis('bank-a', 'd-071').visible, true);
  assert.equal(vis('bank-a', 'd-078').visible, true);
});

test('dropout freeze: Fjord (declined) sees nothing, ever', () => {
  for (const docId of idx.docs.keys()) assert.equal(vis('bank-e', docId).visible, false);
  assert.equal(vis('bank-e', 'd-001').reason, 'dropped_out');
});

test('NDA gate: Mainufer (invited) sees teaser-level public docs only', () => {
  assert.equal(vis('bank-f', 'd-001').visible, true);   // teaser
  assert.equal(vis('bank-f', 'd-041').visible, true);   // market report (public)
  assert.equal(vis('bank-f', 'd-009').reason, 'nda_gate'); // info memo
  assert.equal(vis('bank-f', 'd-038').reason, 'nda_gate');
});

test('tiering: Alpenland (nda_signed) sees confidential, not strictly confidential', () => {
  assert.equal(vis('bank-d', 'd-009').visible, true);
  assert.equal(vis('bank-d', 'd-026').reason, 'not_committed');
});

test('side letter is party-scoped: only Elbmarsch + case owner', () => {
  assert.equal(vis('bank-c', 'd-071').visible, true);
  assert.equal(vis('bank-b', 'd-071').reason, 'bank_specific');
  assert.equal(vis('borrower', 'd-071').reason, 'bank_specific');
  assert.equal(vis('advisor-legal', 'd-071').reason, 'bank_specific');
});

test('internal docs: deal team only', () => {
  assert.equal(vis('advisor-legal', 'd-039').visible, true);
  assert.equal(vis('advisor-valuer', 'd-039').visible, true);
  assert.equal(vis('bank-b', 'd-039').reason, 'internal');
  assert.equal(vis('borrower', 'd-039').reason, 'internal');
});

test('borrower excluded from lender legal docs and valuations, keeps own uploads', () => {
  assert.equal(vis('borrower', 'd-066').reason, 'borrower_legal');   // intercreditor draft
  assert.equal(vis('borrower', 'd-011').reason, 'borrower_legal');   // term sheet
  assert.equal(vis('borrower', 'd-038').reason, 'borrower_valuation'); // valuation v2
  assert.equal(vis('borrower', 'd-037').reason, 'borrower_valuation');
  assert.equal(vis('borrower', 'd-014').visible, true);  // own upload
  assert.equal(vis('borrower', 'd-056').visible, true);  // own purchase agreement
  assert.equal(vis('borrower', 'd-025').visible, true);  // own rent roll
});

test('held valuation: nobody but case owner + valuer sees d-038 yet', () => {
  assert.equal(vis('bank-b', 'd-038').reason, 'held');
  assert.equal(vis('bank-d', 'd-038').reason, 'held');
  assert.equal(vis('advisor-valuer', 'd-038').visible, true); // uploader retains
});

test('story 1: release valuation v2 to everyone committed', () => {
  const { granted, excluded, warnings } = computePreview(idx, overlay, {
    type: 'release', docIds: ['d-038'], partyScope: 'committed', partyIds: [],
  });
  const grantedParties = granted.map((g) => g.partyId).sort();
  assert.deepEqual(
    grantedParties,
    ['advisor-legal', 'advisor-tech', 'bank-b', 'bank-c', 'bank-d', 'sponsor'],
  );
  assert.ok(grantedParties.includes('bank-d'), 'Alpenland (nda_signed) included');
  assert.ok(!grantedParties.includes('borrower'), 'borrower excluded');
  assert.ok(excluded.some((e) => e.partyId === 'bank-e' && /declined/.test(e.reason)), 'Fjord stated as excluded');
  assert.ok(excluded.some((e) => e.partyId === 'bank-f' && /NDA/.test(e.reason)), 'Mainufer stated as excluded');
  assert.ok(warnings.some((w) => w.partyId === 'borrower' && /valuation/.test(w.msg)), 'borrower warning');
  assert.ok(warnings.some((w) => /previous version/.test(w.msg)), 'notify warning for v1 viewers');
});

test('story 2: side letter in a broad batch warns loudly, grants nothing beyond the concerned party', () => {
  const { granted, warnings } = computePreview(idx, overlay, {
    type: 'release', docIds: ['d-071'], partyScope: 'all', partyIds: [],
  });
  assert.deepEqual(granted.map((g) => g.partyId), [], 'concerned party already sees it — nothing else is granted');
  assert.ok(warnings.some((w) => w.docId === 'd-071' && /Party-scoped document/.test(w.msg)));
  assert.ok(warnings.some((w) => w.partyId === 'bank-b' && /party-scoped document/.test(w.msg)));
});

test('story 4: never grant to a declined party', () => {
  const { granted, warnings } = computePreview(idx, overlay, {
    type: 'release', docIds: ['d-009'], partyScope: 'specific', partyIds: ['bank-e'],
  });
  assert.equal(granted.length, 0);
  assert.ok(warnings.some((w) => w.partyId === 'bank-e' && /dropped out/.test(w.msg)));
});

test('NDA gate blocks grants to invited parties unless conditional', () => {
  const blocked = computePreview(idx, overlay, {
    type: 'release', docIds: ['d-009'], partyScope: 'specific', partyIds: ['bank-f'],
  });
  assert.equal(blocked.granted.length, 0);
  assert.ok(blocked.warnings.some((w) => /has not signed the NDA/.test(w.msg)));

  const conditional = computePreview(idx, overlay, {
    type: 'release', docIds: ['d-009'], partyScope: 'specific', partyIds: ['bank-f'], condition: 'nda_signed',
  });
  assert.equal(conditional.granted.length, 1);
  assert.equal(conditional.granted[0].pending, true);
});

test('restrict: case owner and uploader are protected, others revoked with warning', () => {
  const { revoked, warnings } = computePreview(idx, overlay, {
    type: 'restrict', docIds: ['d-026'], partyScope: 'committed', partyIds: [],
  });
  const ids = revoked.map((r) => r.partyId);
  assert.ok(ids.includes('bank-b') && ids.includes('bank-c') && ids.includes('sponsor'));
  assert.ok(!ids.includes('borrower'), 'uploader retained');
  assert.ok(!ids.includes('bank-a'), 'case owner retained');
  assert.ok(warnings.some((w) => w.partyId === 'borrower' && /retains access/.test(w.msg)));
});

test('apply: overlay mutates, log entry answers history questions, idempotent second apply', () => {
  const first = computeApply(idx, overlay, {
    type: 'release', docIds: ['d-038'], partyScope: 'specific', partyIds: ['bank-d'],
  }, 'Tobby (analyst)', new Date('2026-11-02T15:00:00Z'));
  assert.equal(vis('bank-d', 'd-038', first.overlay).visible, true);
  const e = first.changeLogEntry;
  assert.equal(e.actor, 'Tobby (analyst)');
  assert.match(e.actionSummary, /Valuation report/);
  assert.ok(e.affectedParties.some((p) => p.id === 'bank-d'));
  assert.ok(e.docs.some((d) => d.id === 'd-038'));

  const second = computeApply(idx, first.overlay, {
    type: 'release', docIds: ['d-038'], partyScope: 'specific', partyIds: ['bank-d'],
  }, 'Tobby (analyst)', new Date('2026-11-02T15:01:00Z'));
  assert.equal(second.preview.granted.length, 0, 'second apply is a no-op');
});

test('pending grant is visible in the matrix as pending, not visible', () => {
  const applied = computeApply(idx, overlay, {
    type: 'release', docIds: ['d-009'], partyScope: 'specific', partyIds: ['bank-f'], condition: 'nda_signed',
  }, 'Tobby (analyst)', new Date('2026-11-02T15:00:00Z'));
  const matrix = buildAccessMatrix(idx, applied.overlay);
  const mainufer = matrix.find((r) => r.partyId === 'bank-f');
  assert.ok(mainufer.pendingGrants.includes('d-009'));
  assert.ok(!mainufer.visible.includes('d-009'));
  assert.ok(mainufer.excluded.some((e) => e.docId === 'd-009' && /pending/.test(e.reason)));
});

test('matrix covers all parties with reasons for every hidden doc', () => {
  const matrix = buildAccessMatrix(idx, overlay);
  assert.equal(matrix.length, 11);
  const fjord = matrix.find((r) => r.partyId === 'bank-e');
  assert.equal(fjord.visible.length, 0);
  assert.equal(fjord.excluded.length, 78);
});
