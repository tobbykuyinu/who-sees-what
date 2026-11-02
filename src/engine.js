'use strict';

/**
 * engine.js — the permission engine. Pure and IO-free: store.js owns
 * loading/persistence, routes.js owns HTTP, chat.js owns intent parsing.
 *
 * Philosophy (see README): we do not replace NeoShare's permission model —
 * we encode its rules verbatim from data/permissions.json and layer an
 * explicit grant/revoke overlay on top. Every visibility question has one
 * deterministic answer, and every hidden answer carries the reason why.
 * The safe path is the lazy path: dropouts, the borrower, side letters and
 * NDA-gated parties are excluded by default.
 */

// ---- rules encoded from data/permissions.json -----------------------------

const TIER_BY_STATE = Object.freeze({
  invited: Object.freeze(['public']),
  nda_signed: Object.freeze(['public', 'confidential']),
  committed: Object.freeze(['public', 'confidential', 'strictly_confidential']),
  declined: Object.freeze([]),
});

// roles with deal-team access to "internal" documents (arranger's own docs)
const DEAL_TEAM_ROLES = new Set(['legal_advisor', 'appraiser', 'collaborator']);

// lender-side legal work (term sheets, facility drafts, intercreditor,
// security docs): never visible to the borrower
const LENDER_LEGAL_CATEGORIES = new Set(['contracts', 'contractsDeeds']);

// lender-side valuation work: the banks' valuation reports are not shared
// with the borrower either (acceptance story 1)
const VALUATION_CATEGORIES = new Set(['valuationsAppraisals', 'supplementaryValuationDocuments']);

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'of', 'from', 'a', 'an', 'in', 'on', 'to']);

// ---- index ----------------------------------------------------------------

/** Build lookup structures over the raw data-room JSON. */
export function buildIndex(dataRoom) {
  const parties = new Map();
  const docs = new Map();
  const folders = [];

  for (const p of dataRoom.parties) parties.set(p.id, p);
  const caseOwnerId = dataRoom.deal.arranger;
  const borrowerId = dataRoom.deal.borrower;

  const visit = (fs, path) => {
    for (const f of fs) {
      folders.push({ id: f.id, name: f.name.en, path });
      for (const d of f.documents || []) {
        docs.set(d.id, { doc: d, folderId: f.id, folderName: f.name.en });
      }
      visit(f.children || [], `${path}${f.id}/`);
    }
  };
  visit(dataRoom.folders, '');

  const successorOf = new Map();     // superseded docId -> current successor
  const predecessorIds = new Map();  // current docId   -> [superseded ids]

  // Version chains: a superseded doc belongs to the current doc in the same
  // folder+category whose name tokens overlap most (>= 2 shared, >= 0.6
  // ratio). Handles d-010->d-011 ("term sheet" vs "indicative term sheet")
  // while keeping d-039 ("mortgage lending value report") out of the
  // d-037->d-038 valuation chain.
  const groups = new Map();
  for (const [id, entry] of docs) {
    const key = `${entry.folderId}|${entry.doc.category_key}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  const tokens = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  for (const ids of groups.values()) {
    const superseded = ids.filter((id) => docs.get(id).doc.status === 'superseded');
    const current = ids.filter((id) => docs.get(id).doc.status === 'current');
    for (const s of superseded) {
      const st = tokens(docs.get(s).doc.name.en);
      let best = null;
      for (const c of current) {
        const ct = tokens(docs.get(c).doc.name.en);
        const shared = st.filter((t) => ct.includes(t)).length;
        const ratio = shared / Math.max(st.length, ct.length, 1);
        if (shared >= 2 && ratio >= 0.6 && (!best || ratio > best.ratio)) best = { c, ratio };
      }
      if (best) {
        successorOf.set(s, best.c);
        if (!predecessorIds.has(best.c)) predecessorIds.set(best.c, []);
        predecessorIds.get(best.c).push(s);
      }
    }
  }

  return {
    dataRoom, parties, docs, folders, caseOwnerId, borrowerId,
    successorOf, predecessorIds,
  };
}

// ---- overlay --------------------------------------------------------------

/**
 * The explicit control layer on top of the base rules.
 *   grants:  Set<partyId> — parties explicitly given the doc (lifts a tier
 *            gate or a hold; never a hard rule)
 *   revokes: Set<partyId> — parties explicitly cut from the doc
 *   pending: Set<partyId> — conditional grants: take effect when the party
 *            has signed the NDA (status nda_signed/committed)
 *   held:    true — the doc has not been released yet (seed state)
 */
export function emptyOverlay() {
  return new Map();
}

export function overlayFor(overlay, docId) {
  let ov = overlay.get(docId);
  if (!ov) {
    ov = { grants: new Set(), revokes: new Set(), pending: new Set(), held: false };
    overlay.set(docId, ov);
  }
  return ov;
}

export function cloneOverlay(overlay) {
  const next = new Map();
  for (const [docId, ov] of overlay) {
    next.set(docId, {
      grants: new Set(ov.grants),
      revokes: new Set(ov.revokes),
      pending: new Set(ov.pending),
      held: ov.held,
    });
  }
  return next;
}

// ---- visibility -----------------------------------------------------------

/**
 * One deterministic answer per (party, doc): is it visible, and if not, why.
 * `reason` values: dropped_out | bank_specific | internal | borrower_legal |
 * borrower_valuation | nda_gate | not_committed | tier | held | restricted |
 * nda_gate_pending
 */
export function effectiveVisibility(idx, overlay, partyId, docId) {
  const party = idx.parties.get(partyId);
  const { doc } = idx.docs.get(docId);
  const ov = overlay.get(docId) || { grants: new Set(), revokes: new Set(), pending: new Set(), held: false };

  if (partyId === idx.caseOwnerId) return { visible: true, via: 'case_owner' }; // owner_sees_all — nothing revokes it
  if (party.status === 'declined') return { visible: false, reason: 'dropped_out' }; // revocation_on_dropout

  const sens = doc.sensitivity;

  if (sens === 'bank_specific') { // side letters, fee/commitment letters, signed NDAs: party-scoped, narrower rule wins
    if (partyId === doc.concerns_party) return { visible: true, via: 'bank_specific' };
    return { visible: false, reason: 'bank_specific', concernedPartyId: doc.concerns_party };
  }

  if (sens === 'internal') { // arranger's own documents
    if (DEAL_TEAM_ROLES.has(party.role)) return { visible: true, via: 'internal' };
    return { visible: false, reason: 'internal' };
  }

  if (partyId === idx.borrowerId) {
    if (VALUATION_CATEGORIES.has(doc.category_key)) return { visible: false, reason: 'borrower_valuation' };
    if (LENDER_LEGAL_CATEGORIES.has(doc.category_key) && doc.uploaded_by !== idx.borrowerId)
      return { visible: false, reason: 'borrower_legal' };
  }

  const tier = TIER_BY_STATE[party.status] || [];
  const inTier = tier.includes(sens);
  const granted = ov.grants.has(partyId);
  const revoked = ov.revokes.has(partyId);
  const pending = ov.pending.has(partyId);

  if (!inTier && sens !== 'public') {
    if (party.status === 'invited') { // nda_gate: hard — an unsigned party never sees gated docs
      if (pending) return { visible: false, reason: 'nda_gate_pending' }; // conditional grant waiting on the NDA
      return { visible: false, reason: 'nda_gate' };
    }
    if (!granted) return { visible: false, reason: sens === 'strictly_confidential' ? 'not_committed' : 'tier' };
  }

  if (revoked && partyId !== doc.uploaded_by) {
    return { visible: false, reason: ov.held ? 'held' : 'restricted' };
  }

  if (granted) return { visible: true, via: inTier ? 'grant' : 'explicit_release' };
  if (!inTier) return { visible: false, reason: 'tier' };
  return { visible: true, via: 'tier' };
}

/** Human, colleague-style reason sentences for the matrix and answers. */
export function humanizeReason(idx, result, partyId, docId) {
  const { doc } = idx.docs.get(docId);
  const party = idx.parties.get(partyId);
  switch (result.reason) {
    case 'dropped_out':
      return `${party.name} dropped out — all access revoked, nothing new is ever shared`;
    case 'bank_specific': {
      const concerned = idx.parties.get(result.concernedPartyId);
      return `party-scoped — only ${concerned ? concerned.name : result.concernedPartyId} and the case owner can see this`;
    }
    case 'internal':
      return 'internal — arranger and deal team only';
    case 'borrower_legal':
      return 'lender legal document — the borrower is always excluded';
    case 'borrower_valuation':
      return 'lender valuation document — the borrower is always excluded';
    case 'nda_gate':
      return 'NDA gate — confidential access requires a signed NDA';
    case 'nda_gate_pending':
      return 'pending — access takes effect when the NDA is signed';
    case 'not_committed':
      return 'strictly confidential — committed parties only';
    case 'tier':
      return 'outside this party’s access tier';
    case 'held':
      return 'held — not released yet';
    case 'restricted':
      return 'explicitly restricted';
    default:
      return 'no access';
  }
}

// ---- scope resolution -----------------------------------------------------

/**
 * "committed" means every party past the NDA gate (status committed or
 * nda_signed) — acceptance story 1: the valuation release must include
 * Alpenland (nda_signed) but not Mainufer (invited) or Fjord (declined).
 */
export function resolveScope(idx, partyScope, partyIds) {
  const all = [...idx.parties.values()];
  if (partyScope === 'specific') return partyIds.map((id) => idx.parties.get(id));
  if (partyScope === 'committed') return all.filter((p) => p.status === 'committed' || p.status === 'nda_signed');
  return all.filter((p) => p.status !== 'declined'); // 'all' — dropouts are never in any release scope
}

// ---- preview / apply ------------------------------------------------------

/**
 * Simulate an action without mutating anything.
 * Returns { granted, revoked, excluded, warnings } where granted/revoked
 * entries are {partyId, docIds, pending} and excluded entries are
 * {partyId, docIds, reason} for parties the action will never touch.
 */
export function computePreview(idx, overlay, action) {
  const { type, docIds, partyScope, partyIds, condition } = action;
  const warnings = [];
  const granted = new Map();
  const revoked = new Map();
  const excluded = [];

  const scope = resolveScope(idx, partyScope, partyIds);

  // Story 4: EVERY release preview states the frozen parties automatically.
  if (type === 'release') {
    const declined = [...idx.parties.values()].filter((p) => p.status === 'declined');
    for (const p of declined) excluded.push({ partyId: p.id, docIds, reason: 'declined — access frozen, excluded from every release' });
    const invited = [...idx.parties.values()].filter((p) => p.status === 'invited' && !scope.includes(p));
    for (const p of invited) excluded.push({ partyId: p.id, docIds, reason: 'NDA not yet signed — excluded from the release scope' });
  }

  for (const docId of docIds) {
    const entry = idx.docs.get(docId);

    // Story 2: a party-scoped document in a broad batch gets the loud warning.
    if (type === 'release' && entry.doc.sensitivity === 'bank_specific' && scope.length > 2) {
      const concerned = idx.parties.get(entry.doc.concerns_party);
      warnings.push({
        level: 'warning', partyId: null, docId,
        msg: `Party-scoped document — this would expose ${concerned ? concerned.name : 'the concerned party'}'s terms to other banks. Cannot be undone.`,
      });
    }

    for (const party of scope) {
      const cur = effectiveVisibility(idx, overlay, party.id, docId);
      if (type === 'release') {
        if (cur.visible) continue; // already there — no-op
        const res = grantability(idx, entry, party, cur, condition);
        if (!res.grantable) {
          warnings.push({ level: 'warning', partyId: party.id, docId, msg: res.msg });
          continue;
        }
        pushEntry(granted, party.id, docId, res.pending);
        if (res.pending) {
          warnings.push({
            level: 'info', partyId: party.id, docId,
            msg: `${party.name} has not signed the NDA — access is recorded as pending and takes effect on signature`,
          });
        }
        if (cur.reason === 'not_committed') {
          warnings.push({
            level: 'warning', partyId: party.id, docId,
            msg: `explicit release to an NDA-signed (not yet committed) bank — ${party.name} would see a strictly confidential document`,
          });
        }
      } else {
        if (!cur.visible) continue;
        if (party.id === idx.caseOwnerId) {
          warnings.push({ level: 'info', partyId: party.id, docId, msg: 'case owner always sees everything — not revoked' });
          continue;
        }
        if (party.id === entry.doc.uploaded_by) {
          warnings.push({ level: 'info', partyId: party.id, docId, msg: `${party.name} uploaded this document and retains access — not revoked` });
          continue;
        }
        pushEntry(revoked, party.id, docId, false);
        warnings.push({
          level: 'warning', partyId: party.id, docId,
          msg: `${party.name} loses access — logged and reversible via the change log`,
        });
      }
    }

    // version_visibility rule: anyone who saw the old version is notified
    // about the new one (acceptance story 1: "N notified")
    if (type === 'release') {
      const preds = idx.predecessorIds.get(docId) || [];
      for (const predId of preds) {
        const viewers = [...idx.parties.values()]
          .filter((p) => effectiveVisibility(idx, overlay, p.id, predId).visible)
          .map((p) => p.name);
        if (viewers.length) {
          warnings.push({
            level: 'info', partyId: null, docId,
            msg: `${viewers.length} ${viewers.length === 1 ? 'party' : 'parties'} who saw the previous version will be notified about the update: ${viewers.join(', ')}`,
          });
        }
      }
    }
  }

  return {
    granted: mapToList(granted),
    revoked: mapToList(revoked),
    excluded,
    warnings: dedupeWarnings(warnings),
  };
}

/** Identical (level, party, message) warnings collapse to one — e.g. a
 *  38-document pending grant produces a single NDA note, not 38. */
function dedupeWarnings(warnings) {
  const seen = new Set();
  const out = [];
  for (const w of warnings) {
    const key = `${w.level}|${w.partyId}|${w.msg}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** Can this (doc, party) pair be granted? Hard rules are never lifted. */
function grantability(idx, entry, party, cur, condition) {
  switch (cur.reason) {
    case 'dropped_out':
      return { grantable: false, msg: `${party.name} dropped out — access stays revoked; nothing new is ever shared` };
    case 'nda_gate': {
      if (condition === 'nda_signed') return { grantable: true, pending: true };
      return { grantable: false, msg: `${party.name} has not signed the NDA — confidential documents stay gated (say "once the NDA is signed" to record a pending grant)` };
    }
    case 'nda_gate_pending':
      return { grantable: false, msg: `${party.name} already has this pending on NDA signature` };
    case 'bank_specific': {
      const concerned = idx.parties.get(cur.concernedPartyId);
      return { grantable: false, msg: `party-scoped document — only ${concerned ? concerned.name : cur.concernedPartyId} and the case owner can see it` };
    }
    case 'internal':
      return { grantable: false, msg: 'internal document — arranger and deal team only' };
    case 'borrower_legal':
      return { grantable: false, msg: `${party.name} (borrower) is excluded from lender legal documents — never lifted` };
    case 'borrower_valuation':
      return { grantable: false, msg: `${party.name} (borrower) is excluded from valuation documents — never lifted` };
    default:
      return { grantable: true, pending: false }; // tier lift, held or explicit restrict — all grantable
  }
}

function pushEntry(map, partyId, docId, pending) {
  if (!map.has(partyId)) map.set(partyId, { docIds: [], pending: false });
  const e = map.get(partyId);
  e.docIds.push(docId);
  if (pending) e.pending = true;
}

function mapToList(map) {
  return [...map.entries()].map(([partyId, e]) => ({ partyId, docIds: e.docIds, pending: e.pending }));
}

/**
 * Apply the action: returns the new overlay, the same preview as the client
 * saw, and the change-log entry. The engine re-computes — it never trusts
 * a client-side preview.
 */
export function computeApply(idx, overlay, action, actor, now = new Date()) {
  const { granted, revoked, excluded, warnings } = computePreview(idx, overlay, action);
  const next = cloneOverlay(overlay);

  for (const g of granted) {
    for (const docId of g.docIds) {
      const o = overlayFor(next, docId);
      if (g.pending) { o.pending.add(g.partyId); o.grants.delete(g.partyId); }
      else { o.grants.add(g.partyId); o.pending.delete(g.partyId); }
      o.revokes.delete(g.partyId);
    }
  }
  for (const r of revoked) {
    for (const docId of r.docIds) {
      const o = overlayFor(next, docId);
      o.revokes.add(r.partyId);
      o.grants.delete(r.partyId);
      o.pending.delete(r.partyId);
    }
  }

  const entry = buildLogEntry(idx, action, actor, now, { granted, revoked, excluded, warnings });
  return { overlay: next, preview: { granted, revoked, excluded, warnings }, changeLogEntry: entry };
}

/** Change-log entry shaped to ANSWER history questions. */
export function buildLogEntry(idx, action, actor, now, { granted, revoked, warnings }) {
  const docNames = action.docIds.map((id) => {
    const d = idx.docs.get(id).doc;
    return { id, name: d.name.en };
  });
  const partyNames = (ids) => ids.map((id) => ({ id, name: idx.parties.get(id).name }));
  const grantedParties = granted.map((g) => g.partyId);
  const revokedParties = revoked.map((r) => r.partyId);

  let summary;
  if (action.type === 'release') {
    const pending = granted.filter((g) => g.pending);
    if (pending.length && granted.length === pending.length) {
      summary = `Pending grant recorded for ${partyNames(grantedParties).map((p) => p.name).join(', ')}: ${docNames.length} document${docNames.length === 1 ? '' : 's'} — takes effect on NDA signature`;
    } else {
      summary = `Released ${docNames.map((d) => `"${d.name}"`).join(', ')} to ${granted.length} ${granted.length === 1 ? 'party' : 'parties'} (${partyNames(grantedParties).map((p) => p.name).join(', ') || 'nobody'})`;
    }
  } else {
    summary = `Restricted ${docNames.map((d) => `"${d.name}"`).join(', ')} from ${revoked.length} ${revoked.length === 1 ? 'party' : 'parties'} (${partyNames(revokedParties).map((p) => p.name).join(', ') || 'nobody'})`;
  }
  const warnCount = warnings.filter((w) => w.level === 'warning').length;
  if (warnCount) summary += ` — ${warnCount} warning${warnCount === 1 ? '' : 's'}`;

  return {
    ts: now.toISOString(),
    action: action.type,
    actor,
    actionSummary: summary,
    affectedParties: partyNames([...new Set([...grantedParties, ...revokedParties])]),
    docs: docNames,
    granted: granted.map((g) => ({ partyId: g.partyId, docIds: g.docIds, pending: g.pending })),
    revoked: revoked.map((r) => ({ partyId: r.partyId, docIds: r.docIds })),
    warnings: warnings.map((w) => w.msg),
  };
}

// ---- matrix ---------------------------------------------------------------

/** The analyst's mental model of the room: every party x every doc. */
export function buildAccessMatrix(idx, overlay) {
  return [...idx.parties.values()].map((party) => {
    const visible = [];
    const excluded = [];
    const pendingGrants = [];
    for (const [docId] of idx.docs) {
      const res = effectiveVisibility(idx, overlay, party.id, docId);
      if (res.visible) visible.push(docId);
      else if (res.reason === 'nda_gate_pending') {
        excluded.push({ docId, reason: humanizeReason(idx, res, party.id, docId) });
        pendingGrants.push(docId);
      } else {
        excluded.push({ docId, reason: humanizeReason(idx, res, party.id, docId) });
      }
    }
    return {
      partyId: party.id,
      partyName: party.name,
      role: party.role,
      state: party.status,
      committed: party.status === 'committed',
      ticketEur: party.ticket_eur ?? null,
      notes: party.notes ?? null,
      visible,
      excluded,
      pendingGrants,
    };
  });
}

/** Document flags the UI renders as permanent badges. */
export function docFlags(idx, docId) {
  const { doc } = idx.docs.get(docId);
  return {
    borrowerExcluded:
      VALUATION_CATEGORIES.has(doc.category_key) ||
      (LENDER_LEGAL_CATEGORIES.has(doc.category_key) && doc.uploaded_by !== idx.borrowerId),
    partyScoped: doc.sensitivity === 'bank_specific',
    internal: doc.sensitivity === 'internal',
  };
}
