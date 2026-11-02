/* NeoShare take-home: who sees what, access workspace.
 *
 * One screen, one modal. The page talks to the API contract
 *   GET  /api/deal     -> { parties, documents, states }
 *   GET  /api/access   -> { matrix: [{partyId, state, visible, excluded}] }
 *   GET  /api/log      -> { entries: [{ts, actor, actionSummary, affectedParties, docs}] }
 *   POST /api/chat     -> { conversationId, reply: decision-draft | answer | clarification }
 *   POST /api/apply    -> { ok, changeLogEntry }
 * and falls back to a local engine (same contract, same rules) while the
 * API is down, so the page always renders and every demo moment works
 * standalone. The local chat intent layer is rule-based today; in
 * production the same endpoint is LLM-backed.
 */
(function () {
  'use strict';

  var $ = function (sel) { return document.querySelector(sel); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ================================================================
   * 1. LOCAL MOCK: deal data (mirrors the brief files)
   * ================================================================ */

  var ACTOR = 'Ana Berg';
  var STORE_KEY = 'neoshare-workspace-v1';

  var FOLDERS = [
    { id: 'f-01', name: 'Teaser & Transaction Overview' },
    { id: 'f-02', name: 'Confidentiality Agreements (NDA)' },
    { id: 'f-03', name: 'Information Memorandum & Financing Structure' },
    { id: 'f-04', name: 'Property Data' },
    { id: 'f-05', name: 'Tenants' },
    { id: 'f-06', name: 'Valuation & Market' },
    { id: 'f-07', name: 'Borrower & Sponsor' },
    { id: 'f-08', name: 'Due Diligence' },
    { id: 'f-09', name: 'Collateral' },
    { id: 'f-10', name: 'Loan Documentation' },
    { id: 'f-11', name: 'Q&A and Communication' },
    { id: 'f-12', name: 'Arranger Internal' }
  ];

  // [id, name, folder, sensitivity, updatedAt, status, concernsPartyId?]
  var DOC_ROWS = [
    ['d-001', 'Teaser Hafenkante Quartier', 'f-01', 'public', '2026-06-24', 'current'],
    ['d-002', 'Syndication timetable', 'f-01', 'public', '2026-09-02', 'current'],
    ['d-003', 'Invitation letter to participating banks', 'f-01', 'public', '2026-06-25', 'current'],
    ['d-004', 'NDA template', 'f-02', 'public', '2026-06-20', 'current'],
    ['d-005', 'Signed NDA - Rheintal Landesbank', 'f-02', 'bank_specific', '2026-07-01', 'current', 'bank-b'],
    ['d-006', 'Signed NDA - Elbmarsch Kreditbank', 'f-02', 'bank_specific', '2026-07-03', 'current', 'bank-c'],
    ['d-007', 'Signed NDA - Alpenland Hypothekenbank', 'f-02', 'bank_specific', '2026-07-09', 'current', 'bank-d'],
    ['d-008', 'Signed NDA - Fjord Pfandbrief Bank', 'f-02', 'bank_specific', '2026-07-04', 'current', 'bank-e'],
    ['d-009', 'Information memorandum', 'f-03', 'confidential', '2026-07-15', 'current'],
    ['d-010', 'Indicative term sheet', 'f-03', 'confidential', '2026-06-30', 'superseded'],
    ['d-011', 'Term sheet (final)', 'f-03', 'confidential', '2026-08-28', 'current'],
    ['d-012', 'Cash flow model (bank case)', 'f-03', 'confidential', '2026-09-10', 'current'],
    ['d-013', 'Financing and tranche structure', 'f-03', 'confidential', '2026-08-28', 'current'],
    ['d-014', 'Sources and uses', 'f-03', 'confidential', '2026-07-15', 'current'],
    ['d-015', 'Property description', 'f-04', 'confidential', '2026-06-28', 'current'],
    ['d-016', 'Land register extract, folio 4711', 'f-04', 'confidential', '2026-06-18', 'superseded'],
    ['d-017', 'Land register extract, folio 4711 (updated)', 'f-04', 'confidential', '2026-09-08', 'current'],
    ['d-018', 'Cadastral map and site plan', 'f-04', 'confidential', '2026-06-18', 'current'],
    ['d-019', 'Building encumbrances and contamination register', 'f-04', 'confidential', '2026-07-02', 'current'],
    ['d-020', 'Floor plans ground to 6th floor', 'f-04', 'confidential', '2026-06-28', 'current'],
    ['d-021', 'Area schedule (GIF standard)', 'f-04', 'confidential', '2026-07-20', 'current'],
    ['d-022', 'Property photos', 'f-04', 'public', '2026-06-28', 'current'],
    ['d-023', 'Building permit', 'f-04', 'confidential', '2026-06-28', 'current'],
    ['d-024', 'Energy performance certificate', 'f-04', 'confidential', '2026-06-28', 'current'],
    ['d-025', 'Rent roll', 'f-05', 'strictly_confidential', '2026-06-30', 'superseded'],
    ['d-026', 'Rent roll, September', 'f-05', 'strictly_confidential', '2026-09-14', 'current'],
    ['d-027', 'Rent receipts 2025', 'f-05', 'strictly_confidential', '2026-07-10', 'current'],
    ['d-028', 'Credit reports anchor tenants', 'f-05', 'strictly_confidential', '2026-07-22', 'current'],
    ['d-029', 'Lease anchor office tenant (floors 1-3)', 'f-05', 'strictly_confidential', '2026-07-01', 'current'],
    ['d-030', '1st addendum anchor tenant lease', 'f-05', 'strictly_confidential', '2026-07-01', 'current'],
    ['d-031', 'Lease supermarket ground floor', 'f-05', 'strictly_confidential', '2026-07-01', 'current'],
    ['d-032', 'Lease restaurant ground floor', 'f-05', 'strictly_confidential', '2026-07-01', 'current'],
    ['d-033', 'Termination notice restaurant', 'f-05', 'strictly_confidential', '2026-09-05', 'current'],
    ['d-034', 'Lease office 4th floor (new letting)', 'f-05', 'strictly_confidential', '2026-09-12', 'current'],
    ['d-035', 'Leases small units (bundle)', 'f-05', 'strictly_confidential', '2026-07-01', 'current'],
    ['d-036', 'Parking leases', 'f-05', 'confidential', '2026-07-01', 'current'],
    ['d-037', 'Valuation report (market value)', 'f-06', 'confidential', '2026-06-27', 'superseded'],
    ['d-038', 'Valuation report (market value), update', 'f-06', 'confidential', '2026-09-18', 'current'],
    ['d-039', 'Mortgage lending value report', 'f-06', 'internal', '2026-07-30', 'current'],
    ['d-040', 'Valuer reliance letter', 'f-06', 'confidential', '2026-09-20', 'current'],
    ['d-041', 'Office market report Hamburg', 'f-06', 'public', '2026-07-15', 'current'],
    ['d-042', 'Shareholder structure chart', 'f-07', 'confidential', '2026-07-01', 'current'],
    ['d-043', 'Commercial register extract borrower SPV', 'f-07', 'confidential', '2026-07-01', 'current'],
    ['d-044', 'Articles of association borrower SPV', 'f-07', 'confidential', '2026-07-01', 'current'],
    ['d-045', 'Financial statements 2024 borrower SPV', 'f-07', 'strictly_confidential', '2026-07-05', 'current'],
    ['d-046', 'Financial statements 2025 borrower SPV', 'f-07', 'strictly_confidential', '2026-08-14', 'current'],
    ['d-047', 'Management accounts June 2026', 'f-07', 'strictly_confidential', '2026-07-20', 'current'],
    ['d-048', 'Consolidated financial statements 2025 sponsor', 'f-07', 'strictly_confidential', '2026-08-14', 'current'],
    ['d-049', 'Sponsor track record', 'f-07', 'confidential', '2026-06-28', 'current'],
    ['d-050', 'KWG 18 disclosure package', 'f-07', 'strictly_confidential', '2026-08-20', 'current'],
    ['d-051', 'Technical due diligence report', 'f-08', 'confidential', '2026-08-05', 'current'],
    ['d-052', 'Maintenance and capex plan (10 years)', 'f-08', 'confidential', '2026-08-21', 'current'],
    ['d-053', 'ESG and CRREM analysis', 'f-08', 'confidential', '2026-08-12', 'current'],
    ['d-054', 'Legal due diligence report (red flag)', 'f-08', 'confidential', '2026-08-09', 'current'],
    ['d-055', 'Lease review', 'f-08', 'strictly_confidential', '2026-09-16', 'current'],
    ['d-056', 'Purchase agreement (deed 2019)', 'f-08', 'confidential', '2026-07-02', 'current'],
    ['d-057', 'Tax due diligence (short form)', 'f-08', 'confidential', '2026-08-11', 'current'],
    ['d-058', 'Building insurance certificate', 'f-08', 'confidential', '2026-07-03', 'current'],
    ['d-059', 'Security package overview', 'f-09', 'confidential', '2026-08-28', 'current'],
    ['d-060', 'Draft land charge deed', 'f-09', 'confidential', '2026-09-22', 'current'],
    ['d-061', 'Draft security purpose declaration', 'f-09', 'confidential', '2026-09-22', 'current'],
    ['d-062', 'Draft assignment of rents', 'f-09', 'confidential', '2026-09-22', 'current'],
    ['d-063', 'Syndicated facility agreement, draft 1', 'f-10', 'confidential', '2026-08-30', 'superseded'],
    ['d-064', 'Syndicated facility agreement, draft 2 (marked up)', 'f-10', 'confidential', '2026-09-25', 'superseded'],
    ['d-065', 'Syndicated facility agreement, draft 3', 'f-10', 'confidential', '2026-10-08', 'current'],
    ['d-066', 'Intercreditor / syndicate agreement draft', 'f-10', 'confidential', '2026-10-01', 'current'],
    ['d-067', 'Commitment letter - Rheintal Landesbank', 'f-10', 'bank_specific', '2026-09-26', 'current', 'bank-b'],
    ['d-068', 'Commitment letter - Elbmarsch Kreditbank', 'f-10', 'bank_specific', '2026-09-30', 'current', 'bank-c'],
    ['d-069', 'Fee letter - Rheintal Landesbank', 'f-10', 'bank_specific', '2026-09-26', 'current', 'bank-b'],
    ['d-070', 'Fee letter - Elbmarsch Kreditbank', 'f-10', 'bank_specific', '2026-09-30', 'current', 'bank-c'],
    ['d-071', 'Side letter - Elbmarsch Kreditbank (special termination right)', 'f-10', 'bank_specific', '2026-10-02', 'current', 'bank-c'],
    ['d-072', 'Q&A log', 'f-11', 'confidential', '2026-10-06', 'current'],
    ['d-073', 'Lender presentation', 'f-11', 'confidential', '2026-07-17', 'current'],
    ['d-074', 'Site visit minutes', 'f-11', 'confidential', '2026-07-24', 'current'],
    ['d-075', 'Decline letter Fjord Pfandbrief Bank', 'f-11', 'bank_specific', '2026-08-19', 'current', 'bank-e'],
    ['d-076', 'Credit memo', 'f-12', 'internal', '2026-09-24', 'current'],
    ['d-077', 'Internal rating and risk classification', 'f-12', 'internal', '2026-09-03', 'current'],
    ['d-078', 'Syndicate allocation overview', 'f-12', 'internal', '2026-10-05', 'current']
  ];
  var DOCS = DOC_ROWS.map(function (r) {
    return { id: r[0], name: r[1], group: r[2], sensitivity: r[3], updatedAt: r[4] + 'T09:00:00Z', status: r[5], concernsPartyId: r[6] || null };
  });

  // [id, name, role, status, ticketEur, declinedDate?, frozenDocIds?]
  var PARTY_ROWS = [
    ['bank-a', 'Nordwall Bank AG', 'case_owner', 'committed', 50],
    ['bank-b', 'Rheintal Landesbank', 'participant', 'committed', 40],
    ['bank-c', 'Elbmarsch Kreditbank eG', 'participant', 'committed', 30],
    ['bank-d', 'Alpenland Hypothekenbank AG', 'participant', 'nda_signed', 25],
    ['bank-f', 'Mainufer Privatbank KGaA', 'participant', 'invited', null],
    ['bank-e', 'Fjord Pfandbrief Bank', 'participant', 'declined', null, '2026-08-19', ['d-001', 'd-002', 'd-003', 'd-009', 'd-025']],
    ['borrower', 'Hafenkante Objekt GmbH & Co. KG', 'borrower', 'committed', null],
    ['sponsor', 'Lagune Real Estate Partners', 'sponsor', 'committed', null],
    ['advisor-valuer', 'Kessler Immobilienbewertung', 'appraiser', 'committed', null],
    ['advisor-legal', 'Brandt Wieck Rechtsanwälte', 'legal_advisor', 'committed', null],
    ['advisor-tech', 'Ostwerk Ingenieure', 'collaborator', 'committed', null]
  ];
  var PARTIES = PARTY_ROWS.map(function (r) {
    return { id: r[0], name: r[1], role: r[2], status: r[3], committed: r[3] === 'committed', ticketEur: r[4], declinedDate: r[5] || null, frozenDocIds: r[6] || [] };
  });
  var STATES = ['invited', 'nda_signed', 'committed', 'declined'];

  var SEED_LOG = [
    { ts: '2026-10-06T10:15:00Z', actor: ACTOR, actionSummary: 'Released Q&A log to banks past the NDA gate', affectedParties: ['bank-b', 'bank-c', 'bank-d'], docs: ['d-072'] },
    { ts: '2026-09-15T09:30:00Z', actor: ACTOR, actionSummary: 'Released rent roll, September to banks past the NDA gate', affectedParties: ['bank-b', 'bank-c', 'bank-d'], docs: ['d-026'] },
    { ts: '2026-09-08T14:20:00Z', actor: ACTOR, actionSummary: 'Released updated land register extract to banks past the NDA gate', affectedParties: ['bank-b', 'bank-c', 'bank-d'], docs: ['d-017'] },
    { ts: '2026-08-19T16:45:00Z', actor: ACTOR, actionSummary: 'Fjord Pfandbrief Bank declined: access revoked, snapshot frozen', affectedParties: ['bank-e'], docs: ['d-009', 'd-025'] },
    { ts: '2026-07-09T11:00:00Z', actor: ACTOR, actionSummary: 'Alpenland signed the NDA: due-diligence room released', affectedParties: ['bank-d'], docs: ['d-009', 'd-012', 'd-013', 'd-014', 'd-015'] }
  ];

  // Documents held back from banks until a release action (the demo's spine).
  var SEED_PENDING = { 'd-038': true, 'd-071': true };
  var SEED_RELEASED = { 'd-038': ['advisor-valuer'] };

  /* ================================================================
   * 2. LOCAL ENGINE: the permission rules from the brief files
   * ================================================================ */

  var st = null; // mutable state: parties, released, restricted, log, pending, conversation

  function freshState() {
    return {
      parties: JSON.parse(JSON.stringify(PARTIES)),
      released: JSON.parse(JSON.stringify(SEED_RELEASED)),
      restricted: {},
      pending: JSON.parse(JSON.stringify(SEED_PENDING)),
      log: JSON.parse(JSON.stringify(SEED_LOG)),
      conversation: { draft: null }
    };
  }
  function load() {
    if (st) return;
    var clear = false;
    try { clear = new URLSearchParams(location.search).has('reset'); } catch (e) { }
    try {
      var raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORE_KEY) : null;
      if (!clear && raw) { var p = JSON.parse(raw); if (p && p.v === 1) { st = p; return; } }
      if (clear && typeof localStorage !== 'undefined') localStorage.removeItem(STORE_KEY);
    } catch (e) { /* private mode or corrupt: use seed */ }
    st = freshState();
  }
  function persist() {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch (e) { }
  }
  function party(id) { return st.parties.filter(function (p) { return p.id === id; })[0] || null; }
  function doc(id) { return DOCS.filter(function (d) { return d.id === id; })[0] || null; }
  function folder(id) { return FOLDERS.filter(function (f) { return f.id === id; })[0] || null; }
  function partyName(id) { var p = party(id); return p ? p.name : id; }
  function docName(id) { var d = doc(id); return d ? d.name : id; }

  function isArranger(p) { return p.role === 'case_owner'; }
  function isBank(p) { return p.role === 'participant'; }
  function lenderSide(d) { return d.group === 'f-06' || d.id === 'd-066'; }

  // Why a party does or does not see a document, in a plain sentence.
  function visibilityReason(p, d) {
    if (isArranger(p)) return null; // case owner sees everything
    if (p.status === 'declined') {
      if (p.frozenDocIds.indexOf(d.id) !== -1) return null; // frozen snapshot
      return 'Declined: snapshot frozen since ' + fmtDate(p.declinedDate) + ', nothing new is granted';
    }
    if ((st.released[d.id] || []).indexOf(p.id) !== -1) return null;
    if ((st.restricted[d.id] || []).indexOf(p.id) !== -1) return 'Access revoked';
    if (d.sensitivity === 'internal') return 'Arranger only';
    if (d.sensitivity === 'bank_specific') {
      if (d.concernsPartyId === p.id) return null;
      if (p.role === 'legal_advisor') return null;
      return 'Bank-specific: only ' + partyName(d.concernsPartyId) + ' sees this';
    }
    if (st.pending[d.id]) {
      if (d.sensitivity === 'bank_specific') return 'Not yet shared';
      if (p.role === 'borrower' || p.role === 'sponsor') return lenderSide(d) ? lenderSideReason(d) : 'Not yet released';
      return 'Not yet released to banks';
    }
    if (d.sensitivity === 'public') return null;
    if (p.role === 'borrower' || p.role === 'sponsor') {
      if (lenderSide(d)) return lenderSideReason(d);
      return null;
    }
    if (isBank(p)) {
      if (p.status === 'invited') return 'NDA not signed yet';
      return null;
    }
    return null; // advisors see everything non-internal, non-bank-specific
  }
  function lenderSideReason(d) {
    return d.group === 'f-06' ? 'Lender-side document: valuation is for banks and advisors' : 'Lenders only: the interbank agreement is not for the borrower';
  }
  function fmtDate(iso) {
    try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch (e) { return iso; }
  }
  function visibleIds(p) {
    load();
    return DOCS.filter(function (d) { return visibilityReason(p, d) === null; }).map(function (d) { return d.id; });
  }

  function dealPayload() {
    load();
    return {
      parties: st.parties.map(function (p) { return { id: p.id, name: p.name, role: p.role, state: p.status, committed: p.committed, ticketEur: p.ticketEur, declinedDate: p.declinedDate, frozenDocIds: p.frozenDocIds }; }),
      documents: DOCS,
      states: STATES
    };
  }
  function accessPayload() {
    load();
    return {
      matrix: st.parties.map(function (p) {
        var vis = visibleIds(p);
        return {
          partyId: p.id, state: p.status, visible: vis,
          excluded: DOCS.filter(function (d) { return vis.indexOf(d.id) === -1; }).map(function (d) {
            return { docId: d.id, reason: visibilityReason(p, d) || 'Not visible' };
          })
        };
      })
    };
  }
  function logPayload() { load(); return { entries: st.log.slice() }; }

  // Scope resolution: "committed" = every bank past the NDA gate still in the deal.
  function scopeTargets(action) {
    var targets = [];
    if (action.partyScope === 'committed') {
      targets = st.parties.filter(function (p) { return isBank(p) && (p.status === 'committed' || p.status === 'nda_signed'); });
    } else if (action.partyScope === 'all') {
      targets = st.parties.slice();
    } else if (action.partyScope === 'specific') {
      targets = (action.partyIds || []).map(party).filter(Boolean);
    }
    return targets;
  }
  function scopeLabel(action) {
    if (action.partyScope === 'committed') return 'committed banks';
    if (action.partyScope === 'all') return 'all parties';
    return (action.partyIds || []).map(partyName).join(', ');
  }

  function computePreview(action) {
    load();
    var targets = scopeTargets(action);
    var granted = {}, revoked = {}, excluded = {}, warnings = [];
    var isRelease = action.type === 'release';
    var anyBankSpecificBatch = false;

    targets.forEach(function (p) {
      (action.docIds || []).forEach(function (docId) {
        var d = doc(docId);
        if (!d) return;
        if (isRelease) {
          if (p.status === 'declined') {
            addExcluded(excluded, p.id, docId, 'Fjord excluded: declined on ' + fmtDate(p.declinedDate) + ', snapshot frozen');
            warnings.push(w('warn', p.id, docId, 'Cannot grant to a declined party: ' + p.name + ' is excluded automatically.'));
            return;
          }
          var cur = visibilityReason(p, d);
          if (cur === null) return; // already visible
          if (d.sensitivity === 'bank_specific' && d.concernsPartyId !== p.id && p.role !== 'legal_advisor') {
            anyBankSpecificBatch = true;
            addExcluded(excluded, p.id, docId, 'Bank-specific: only ' + partyName(d.concernsPartyId) + ' sees this');
            return;
          }
          if (d.sensitivity === 'internal') { addExcluded(excluded, p.id, docId, 'Arranger only'); return; }
          // The NDA gate blocks broad scopes; an explicit specific grant IS the NDA transition.
          if (isBank(p) && p.status === 'invited' && action.partyScope !== 'specific') { addExcluded(excluded, p.id, docId, 'NDA not signed yet'); return; }
          if ((p.role === 'borrower' || p.role === 'sponsor') && lenderSide(d)) { addExcluded(excluded, p.id, docId, lenderSideReason(d)); return; }
          (granted[p.id] = granted[p.id] || []).push(docId);
        } else {
          if (isArranger(p)) return; // the arranger always keeps access
          if (visibilityReason(p, d) === null) {
            (revoked[p.id] = revoked[p.id] || []).push(docId);
          }
        }
      });
    });

    // The preview also names who stays excluded, so nothing is a surprise.
    if (isRelease) {
      (action.docIds || []).forEach(function (docId) {
        var d = doc(docId); if (!d) return;
        st.parties.forEach(function (p) {
          if (targets.indexOf(p) !== -1) return;
          if (visibilityReason(p, d) !== null) {
            if (p.status === 'declined') addExcluded(excluded, p.id, docId, 'Declined: snapshot frozen since ' + fmtDate(p.declinedDate));
            else if (isBank(p) && p.status === 'invited') addExcluded(excluded, p.id, docId, 'NDA not signed yet');
            else if ((p.role === 'borrower' || p.role === 'sponsor') && lenderSide(d)) addExcluded(excluded, p.id, docId, lenderSideReason(d));
          }
        });
      });
      if (anyBankSpecificBatch) {
        warnings.push(w('block', null, null, "Party-scoped document: this batch includes a document that would expose one bank's terms to other banks. It stays private to its bank. Cannot be undone."));
      }
      // New-version rule: whoever saw the superseded version gets notified.
      (action.docIds || []).forEach(function (docId) {
        var d = doc(docId);
        if (!d || d.status !== 'current') return;
        var old = DOCS.filter(function (o) { return o.group === d.group && o.name.split(',')[0] === d.name.split(',')[0] && o.status === 'superseded'; });
        if (old.length && Object.keys(granted).length) {
          var notified = st.parties.filter(function (p) { return old.some(function (o) { return visibilityReason(p, o) === null; }); });
          if (notified.length) warnings.push(w('info', null, docId, 'Parties who saw the previous version will be notified of the update: ' + notified.map(function (p) { return p.name; }).join(', ') + '.'));
        }
      });
    } else if (Object.keys(revoked).length) {
      var n = Object.keys(revoked).length;
      warnings.push(w('warn', null, null, n + (n === 1 ? ' party will' : ' parties will') + ' lose access they hold today. They may notice immediately.'));
    }
    return { granted: toList(granted), revoked: toList(revoked), excluded: toList(excluded), warnings: warnings };
  }
  function w(level, partyId, docId, msg) { return { level: level, partyId: partyId, docId: docId, msg: msg }; }
  function addExcluded(map, partyId, docId, reason) {
    (map[partyId] = map[partyId] || []).push({ docId: docId, reason: reason });
  }
  function toList(map) {
    return st.parties.map(function (p) { return { partyId: p.id, docIds: (map[p.id] || []).map(function (e) { return e.docId; }), reasons: (map[p.id] || []).map(function (e) { return e.reason; }) }; })
      .filter(function (r) { return r.docIds.length; });
  }

  function applyAction(action) {
    load();
    var pr = computePreview(action);
    if (!pr.granted.length && !pr.revoked.length) return { ok: false, changeLogEntry: null };
    pr.granted.forEach(function (row) {
      st.released[row.partyId] = st.released[row.partyId] || [];
      row.docIds.forEach(function (docId) {
        if (st.released[row.partyId].indexOf(docId) === -1) st.released[row.partyId].push(docId);
        st.pending[docId] = false;
      });
      var p = party(row.partyId);
      if (isBank(p) && p.status === 'invited') { p.status = 'nda_signed'; p.committed = false; }
    });
    pr.revoked.forEach(function (row) {
      st.restricted[row.partyId] = st.restricted[row.partyId] || [];
      row.docIds.forEach(function (docId) {
        if (st.restricted[row.partyId].indexOf(docId) === -1) st.restricted[row.partyId].push(docId);
      });
    });
    var entry = {
      ts: new Date().toISOString(), actor: ACTOR,
      actionSummary: summarize(action, pr),
      affectedParties: (pr.granted.length ? pr.granted : pr.revoked).map(function (r) { return r.partyId; }),
      docs: action.docIds
    };
    st.log.unshift(entry);
    st.conversation.draft = null;
    persist();
    return { ok: true, changeLogEntry: entry };
  }
  function summarize(action, pr) {
    var verb = action.type === 'release' ? 'Released' : 'Restricted';
    var names = action.docIds.map(docName);
    var docLabel = names.length > 2 ? names.slice(0, 2).join(', ') + ', +' + (names.length - 2) + ' more' : names.join(', ');
    var rows = pr.granted.length ? pr.granted : pr.revoked;
    var who = rows.map(function (r) { return partyName(r.partyId); });
    var whoLabel = who.length > 3 ? who.slice(0, 3).join(', ') + ', +' + (who.length - 3) + ' more' : who.join(', ');
    return verb + ' ' + docLabel + ' to ' + whoLabel;
  }

  /* ================================================================
   * 3. LOCAL CHAT: rule-based intent layer (LLM-backed in production)
   * ================================================================ */

  var CONV_ID = 'conv-1';

  function chat(text) {
    load();
    var t = (text || '').toLowerCase().trim();
    if (!t) return replyClarify('I did not catch that. Try an action or a question, e.g. "release the new valuation to everyone committed".', []);
    var p = partyMatch(t);

    // Follow-ups refine the open draft in place.
    if (st.conversation.draft && /(exclude|remove|without|minus|drop|not\b|no\b|don'?t)/.test(t) && p) {
      return refineDraft(p);
    }

    // Questions.
    var m;
    if (m = t.match(/\bwhat (can|does|has)\s+([\w .&ß-]+?)\s+(see|access|view)/)) return whatPartySees(m[2]);
    if (m = t.match(/\bwhat can\s+([\w .&ß-]+?)\s+(?:see|access|view)\b/)) return whatPartySees(m[1]);
    if (/\bwhat changed/.test(t)) return whatChanged();
    if (m = t.match(/\bwho (?:sees|can see|has access to)\s+(.+)/)) return whoSees(m[1]);
    if (m = t.match(/\b(can|does)\s+([\w .&ß-]+?)\s+(?:see|view|access)\s+(.+)/)) return canSee(m[2], m[3]);
    if (m = t.match(/\bwhy (?:can'?t|cannot)\s+([\w .&ß-]+?)\s+see\s+(.+)/)) return canSee(m[1], m[2]);

    // Actions.
    if (/(release|grant|share|publish|restrict|revoke|remove access)/.test(t)) return actionDraft(t);

    return replyClarify("I did not catch that. I understand actions like 'release X to committed banks' and questions like 'what can Fjord see?'.", [
      { label: 'Release the new valuation to everyone committed', text: 'release the new valuation to everyone committed' },
      { label: 'What can Fjord see?', text: 'what can Fjord see?' },
      { label: 'Who sees the side letter?', text: 'who sees the side letter?' }
    ]);
  }

  function replyDraft(draft) { st.conversation.draft = draft; persist(); return { kind: 'decision-draft', draft: draft }; }
  function replyAnswer(a) { return { kind: 'answer', answer: a }; }
  function replyClarify(text, options) { return { kind: 'clarification', text: text, options: options }; }

  function partyMatch(t) {
    var found = null;
    st.parties.forEach(function (p) {
      var key = p.name.toLowerCase();
      if (key.indexOf(t) !== -1 || t.indexOf(key.split(' ')[0]) !== -1 || t.indexOf(key.split(' ')[1] || '') !== -1) {
        if (!found) found = p;
      }
    });
    if (!found && /\bborrower\b/.test(t)) found = party('borrower');
    if (!found && /\bmainufer\b/.test(t)) found = party('bank-f');
    if (!found && /\bfjord\b/.test(t)) found = party('bank-e');
    if (!found && /\balpenland\b/.test(t)) found = party('bank-d');
    if (!found && /\belbmarsch\b/.test(t)) found = party('bank-c');
    if (!found && /\brheintal\b/.test(t)) found = party('bank-b');
    if (!found && /\bnordwall\b/.test(t)) found = party('bank-a');
    return found;
  }
  function docCandidates(t) {
    var tokens = t.split(/\s+/).filter(function (tok) { return tok.length > 2; });
    return DOCS.map(function (d) {
      var name = d.name.toLowerCase();
      var score = tokens.reduce(function (s, tok) { return s + (name.indexOf(tok) !== -1 ? 1 : 0); }, 0);
      if (/new|update|latest|updated/.test(t) && name.indexOf('update') !== -1) score += 2;
      if (d.status === 'current') score += 0.5;
      return { d: d, score: score };
    }).filter(function (c) { return c.score >= 1; }).sort(function (a, b) { return b.score - a.score; });
  }
  function pickDoc(t) {
    // "legal draft" style phrasings target the loan documentation folder.
    if (/(legal draft|interbank|intercreditor|facility|loan doc)/.test(t)) return { folderTarget: 'f-10' };
    var cs = docCandidates(t);
    if (!cs.length) return null;
    if (cs.length > 1 && cs[0].score - cs[1].score < 1) return { ambiguous: cs.slice(0, 3) };
    return { doc: cs[0].d };
  }

  function scopeFromText(t) {
    var p = partyMatch(t);
    if (p && !/all|every|committed/.test(t)) return { partyScope: 'specific', partyIds: [p.id] };
    if (/committed/.test(t)) return { partyScope: 'committed' };
    if (/all|every/.test(t)) return { partyScope: 'all' };
    return { partyScope: 'committed' };
  }

  function actionDraft(t) {
    var isRestrict = /(restrict|revoke|remove access)/.test(t);
    // "grant Mainufer room access once the NDA is signed" = the full NDA-gated room.
    var roomParty = partyMatch(t);
    if (/(room access|access to the (data )?room|full access)/.test(t) && roomParty && roomParty.role === 'participant') {
      var roomScope = scopeFromText(t);
      var roomAction = {
        type: 'release',
        docIds: DOCS.filter(function (d) {
          return d.sensitivity !== 'internal' && d.sensitivity !== 'bank_specific' && !st.pending[d.id];
        }).map(function (d) { return d.id; }),
        partyScope: roomScope.partyScope, partyIds: roomScope.partyIds || []
      };
      var roomNote = /\bonce the nda is signed|on nda signature/.test(t) ? 'Applies when the NDA is signed.' : null;
      return replyDraft(makeDraft('Grant room access to ' + partyName(roomAction.partyIds[0]), roomAction, roomNote));
    }
    var pick = pickDoc(t);
    if (!pick) return replyClarify('I could not find a document like that. Try "release the new valuation" or "who sees the side letter?".', []);
    if (pick.ambiguous) {
      return replyClarify('Which document do you mean?', pick.ambiguous.map(function (c) {
        return { label: c.d.name, text: (isRestrict ? 'restrict ' : 'release ') + '"' + c.d.name + '" to ' + (scopeFromText(t).partyScope === 'specific' ? partyName(scopeFromText(t).partyIds[0]) : scopeFromText(t).partyScope) };
      }));
    }
    if (pick.folderTarget) {
      var fDocs = DOCS.filter(function (d) { return d.group === pick.folderTarget; });
      var p = partyMatch(t);
      if (p && /(borrower|hafenkante|sponsor|lagune)/.test(t)) return canSee(p.id, t);
      var scope = scopeFromText(t);
      var action = { type: 'release', docIds: fDocs.map(function (d) { return d.id; }), partyScope: scope.partyScope, partyIds: scope.partyIds || [] };
      return replyDraft(makeDraft('Release Loan Documentation to ' + scopeLabel(action), action, null));
    }
    var scope = scopeFromText(t);
    var action = { type: isRestrict ? 'restrict' : 'release', docIds: [pick.doc.id], partyScope: scope.partyScope, partyIds: scope.partyIds || [] };
    var note = null;
    if (/\bonce the nda is signed|on nda signature/.test(t)) note = 'Applies when the NDA is signed.';
    return replyDraft(makeDraft((isRestrict ? 'Restrict ' : 'Release ') + pick.doc.name + ' to ' + scopeLabel(action), action, note));
  }
  function makeDraft(label, action, note) {
    return { label: label, note: note, action: action, preview: computePreview(action) };
  }

  function refineDraft(p) {
    var d = st.conversation.draft;
    var a = d.action;
    if (a.partyScope === 'specific') {
      if (a.partyIds.indexOf(p.id) === -1) a.partyIds.push(p.id); else a.partyIds = a.partyIds.filter(function (id) { return id !== p.id; });
    } else {
      var targets = scopeTargets(a).filter(function (x) { return x.id !== p.id; });
      a = { type: a.type, docIds: a.docIds, partyScope: 'specific', partyIds: targets.map(function (x) { return x.id; }) };
    }
    return replyDraft(makeDraft((a.type === 'release' ? 'Release ' : 'Restrict ') + a.docIds.map(docName).join(', ') + ' to ' + scopeLabel(a), a, d.note));
  }

  function whatPartySees(nameText) {
    var p = partyMatch(nameText);
    if (!p) return replyClarify('Which party do you mean?', [{ label: 'Fjord', text: 'what can Fjord see?' }, { label: 'Mainufer', text: 'what can Mainufer see?' }, { label: 'The borrower', text: 'what can the borrower see?' }]);
    var vis = visibleIds(p);
    var reasons = [];
    if (p.status === 'declined') {
      reasons.push({ msg: 'Access frozen since ' + fmtDate(p.declinedDate) + ' (declined). No new document is ever granted to ' + p.name + '.' });
    }
    return replyAnswer({
      headline: p.name + ' sees ' + vis.length + ' documents' + (p.status === 'declined' ? ', a frozen snapshot from ' + fmtDate(p.declinedDate) : ''),
      parties: [p.id],
      docs: vis.slice(0, 20),
      reasons: reasons
    });
  }
  function whoSees(docText) {
    var pick = pickDoc(docText);
    if (!pick || pick.ambiguous) {
      // Prefer the side letter for the demo phrasing.
      var sl = docCandidates('side letter');
      pick = sl.length ? { doc: sl[0].d } : null;
      if (!pick) return replyClarify('Which document do you mean?', [{ label: 'Side letter - Elbmarsch', text: 'who sees the side letter?' }]);
    }
    var d = pick.doc;
    var who = st.parties.filter(function (p) { return visibilityReason(p, d) === null; });
    var reasons = [];
    if (d.sensitivity === 'bank_specific') reasons.push({ msg: 'Bank-specific document: it stays visible only to ' + partyName(d.concernsPartyId) + ' (and the arranger).' });
    if (d.id === 'd-066') reasons.push({ msg: 'The borrower never sees this document: lenders only.' });
    return replyAnswer({ headline: who.length + (who.length === 1 ? ' party sees' : ' parties see') + ' "' + d.name + '"', parties: who.map(function (p) { return p.id; }), docs: [d.id], reasons: reasons });
  }
  function canSee(partyText, docText) {
    var p = partyMatch(partyText);
    if (!p) return replyClarify('Which party do you mean?', [{ label: 'The borrower', text: 'can the borrower see the legal draft?' }]);
    var pick = pickDoc(docText);
    var docs = [];
    if (pick && pick.doc) docs = [pick.doc];
    else if (pick && pick.folderTarget) docs = DOCS.filter(function (d) { return d.group === pick.folderTarget; });
    else return replyClarify('Which document do you mean?', []);
    var seen = [], blocked = [];
    docs.forEach(function (d) {
      var r = visibilityReason(p, d);
      if (r === null) seen.push(d); else blocked.push({ d: d, reason: r });
    });
    var headline = seen.length ? 'Yes: ' + p.name + ' sees ' + seen.length + ' of ' + docs.length + ' document(s) here.' : 'No: ' + p.name + ' sees none of these.';
    // The demo question: "can the borrower see the legal draft?" must answer the
    // interbank agreement first, loudly.
    if (pick && pick.folderTarget && (p.role === 'borrower' || p.role === 'sponsor')) {
      var interbank = blocked.filter(function (b) { return b.d.id === 'd-066'; });
      var facility = seen.filter(function (d) { return d.group === 'f-10' && d.sensitivity !== 'bank_specific'; });
      return replyAnswer({
        headline: 'No: ' + p.name + ' never sees the interbank agreement (draft). Lenders only.',
        parties: [p.id],
        docs: facility.map(function (d) { return d.id; }),
        reasons: interbank.map(function (b) { return { docId: b.d.id, msg: b.d.name + ': ' + b.reason }; })
          .concat([{ msg: 'They do see the facility agreement drafts: their counsel negotiates those.' }])
      });
    }
    return replyAnswer({
      headline: headline,
      parties: [p.id],
      docs: seen.map(function (d) { return d.id; }),
      reasons: blocked.map(function (b) { return { docId: b.d.id, msg: b.d.name + ': ' + b.reason }; })
    });
  }
  function whatChanged() {
    var week = 7 * 24 * 3600 * 1000, now = Date.now();
    var recent = st.log.filter(function (e) { return now - Date.parse(e.ts) < week; });
    var older = st.log.filter(function (e) { return now - Date.parse(e.ts) >= week; }).slice(0, 2);
    var lines = recent.concat(older).map(function (e) {
      return timeAgo(e.ts) + ': ' + e.actionSummary;
    });
    return replyAnswer({
      headline: recent.length + ' change(s) in the last 7 days, ' + st.log.length + ' in total',
      parties: [],
      docs: [],
      reasons: [],
      lines: lines.length ? lines : ['No changes yet. Every applied action lands here.']
    });
  }

  /* ================================================================
   * 4. API LAYER: real endpoints first, local engine as fallback
   * ================================================================ */

  var mode = 'unknown'; // unknown | live | mock
  var forcedMock = false;
  try { forcedMock = new URLSearchParams(location.search).has('mock'); } catch (e) { }
  var modeListeners = [];
  function setMode(m) { if (mode !== m) { mode = m; modeListeners.forEach(function (fn) { fn(m); }); } }
  if (forcedMock) setMode('mock');

  function http(path, body) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 1500) : null;
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      if (!res.ok) { var e = new Error('API ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') { e.network = true; e.message = 'API timed out'; }
      if (e instanceof TypeError) { e.network = true; e.message = 'API unreachable'; }
      throw e;
    }).finally(function () { if (timer) clearTimeout(timer); });
  }
  function unreachable(e) { return !!e && (e.network === true || e.status === 404); }
  function call(path, mockFn, body) {
    if (mode === 'mock') return Promise.resolve(mockFn(body));
    return http(path, body).then(function (data) {
      setMode('live');
      return data;
    }).catch(function (e) {
      if (mode === 'unknown' && unreachable(e)) { setMode('mock'); return mockFn(body); }
      if (mode === 'live' && e.network === true) { setMode('mock'); return mockFn(body); }
      throw e;
    });
  }
  var api = {
    getDeal: function () { return call('/api/deal', function () { return dealPayload(); }); },
    getAccess: function () { return call('/api/access', function () { return accessPayload(); }); },
    getLog: function () { return call('/api/log', function () { return logPayload(); }); },
    apply: function (action) { return call('/api/apply', function (a) { return applyAction(a); }, action); },
    chat: function (text, convId) {
      return call('/api/chat', function (body) { return { conversationId: CONV_ID, reply: chat(body.text) }; }, { text: text, conversationId: convId || CONV_ID });
    },
    getMode: function () { return mode; },
    onModeChange: function (fn) { modeListeners.push(fn); }
  };

  /* ================================================================
   * 5. UI
   * ================================================================ */

  var S = {
    deal: null, access: null, log: null,
    messages: [], convId: null, appliedFeed: [], selIdx: -1,
    currentAction: null, currentMeta: null
  };
  try {
    var raw = typeof localStorage !== 'undefined' ? localStorage.getItem('neoshare-applied-feed') : null;
    if (raw) S.appliedFeed = JSON.parse(raw);
  } catch (e) { }

  // Week's actions: prepared decisions, each with a preview before anything applies.
  var FEED = [
    {
      id: 'release-valuation', title: 'Release the updated valuation',
      why: 'Kessler delivered the valuation update (EUR 219.5m market value). Committed banks and Alpenland are waiting on it.',
      due: 'Due today',
      action: { type: 'release', docIds: ['d-038'], partyScope: 'committed' }
    },
    {
      id: 'side-letter', title: 'Share Elbmarsch side letter',
      why: 'Special termination right and quarterly reporting, agreed with Elbmarsch. Party-scoped: only Elbmarsch may ever see it.',
      due: 'Due Tue',
      action: { type: 'release', docIds: ['d-071'], partyScope: 'committed' }
    },
    {
      id: 'mainufer-nda', title: 'Grant Mainufer room access',
      why: 'Mainufer is about to sign the NDA. Prepare the grant so it is one click on signature.',
      due: 'Due Wed', conditional: 'Applies when the NDA is signed',
      action: { type: 'release', docIds: [], partyScope: 'specific', partyIds: ['bank-f'] }
    }
  ];
  FEED[2].action.docIds = DOCS.filter(function (d) {
    return d.sensitivity !== 'internal' && d.sensitivity !== 'bank_specific' && !SEED_PENDING[d.id];
  }).map(function (d) { return d.id; });

  var SUGGEST_QUESTIONS = [
    'What can Fjord see?',
    'Can the borrower see the legal draft?',
    'Who sees the side letter?',
    'What changed this week?'
  ];

  function timeAgo(ts) {
    var ms = Date.now() - Date.parse(ts);
    if (isNaN(ms)) return ts;
    var m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function init() {
    api.onModeChange(renderModeChip);
    renderModeChip(api.getMode());
    bindStatic();
    renderSkeletons();
    Promise.all([api.getDeal(), api.getAccess(), api.getLog()]).then(function (rs) {
      S.deal = rs[0]; S.access = rs[1]; S.log = rs[2];
      renderAll();
    }).catch(function (err) {
      $('#matrix').innerHTML = errorBox('Could not load the room: ' + (err && err.message ? err.message : err));
      $('#feed').innerHTML = '';
      $('#log').innerHTML = '';
    });
  }
  function renderModeChip(m) {
    var chip = $('#ds-chip');
    if (m === 'live') { chip.textContent = 'Live API'; chip.className = 'chip chip-live'; }
    else if (m === 'mock') { chip.textContent = 'Demo data (offline)'; chip.className = 'chip chip-mock'; }
    else { chip.textContent = 'Connecting…'; chip.className = 'chip'; }
  }
  function renderSkeletons() {
    $('#matrix').innerHTML = '<div class="skel skel-block"></div>';
    $('#feed').innerHTML = '<div class="skel skel-line"></div><div class="skel skel-line"></div><div class="skel skel-line"></div>';
    $('#log').innerHTML = '<div class="skel skel-line"></div><div class="skel skel-line"></div>';
  }
  function errorBox(msg) {
    return '<div class="error-box">' + esc(msg) + '<br><button class="btn" onclick="location.reload()">Retry</button></div>';
  }
  function emptyBox(msg) { return '<div class="empty">' + esc(msg) + '</div>'; }

  function renderAll() {
    renderMatrix();
    renderFeed();
    renderLog();
    renderActionPanel();
    renderThread();
  }

  /* ---------- matrix ---------- */
  var ROW_ORDER = ['committed', 'nda_signed', 'invited', 'declined', 'borrower', 'sponsor', 'advisor'];
  function rowRank(p) {
    if (p.role === 'case_owner') return 0;
    if (p.role === 'participant') {
      if (p.status === 'committed') return 1;
      if (p.status === 'nda_signed') return 2;
      if (p.status === 'invited') return 3;
      return 4; // declined
    }
    if (p.role === 'borrower') return 5;
    if (p.role === 'sponsor') return 6;
    return 7; // advisors
  }
  function stateChip(p) {
    if (p.role === 'case_owner') return '<span class="state-chip state-arranger">Arranger</span>';
    if (p.role === 'participant') {
      var map = { committed: 'state-committed', nda_signed: 'state-nda', invited: 'state-invited', declined: 'state-declined' };
      return '<span class="state-chip ' + map[p.status] + '">' + esc((p.status || '').replace('_', ' ')) + '</span>';
    }
    return '<span class="state-chip state-role">' + esc((p.role || '').replace('_', ' ')) + '</span>';
  }
  function partyFlags(p) {
    var out = '';
    var hasSideLetter = DOCS.some(function (d) { return d.sensitivity === 'bank_specific' && d.concernsPartyId === p.id && /side letter/i.test(d.name); });
    if (hasSideLetter) out += '<span class="flag" title="Side letter on file">🔒 side letter</span>';
    if (p.status === 'declined') out += '<span class="flag" title="Access frozen at ' + esc(fmtDate(p.declinedDate)) + '">⏸ frozen</span>';
    var awaiting = FEED.some(function (f) { return f.action.partyIds && f.action.partyIds.indexOf(p.id) !== -1 && S.appliedFeed.indexOf(f.id) === -1; });
    if (awaiting) out += '<span class="flag flag-await" title="Action pending">⏳ awaiting</span>';
    return out;
  }
  function renderMatrix() {
    var wrap = $('#matrix');
    var parties = S.deal.parties.slice().sort(function (a, b) { return rowRank(a) - rowRank(b); });
    var folders = FOLDERS;
    var byParty = {};
    (S.access.matrix || []).forEach(function (r) { byParty[r.partyId] = r; });

    var html = '<div class="matrix-scroll"><table class="matrix"><thead><tr><th class="corner">Party</th>';
    folders.forEach(function (f) {
      var badge = f.id === 'f-12' ? 'internal' : (f.id === 'f-10' ? 'bank-specific docs' : '');
      var flag = f.id === 'f-10' ? '<span class="fh-badge" title="The interbank agreement is never visible to the borrower">borrower excluded</span>' : '';
      html += '<th class="folder-head" title="' + esc(f.name) + '"><span>' + esc(f.name) + (badge ? ' · ' + badge : '') + '</span>' + flag + '</th>';
    });
    html += '</tr></thead><tbody>';

    parties.forEach(function (p) {
      var row = byParty[p.id] || { visible: [], excluded: [] };
      var vis = {};
      row.visible.forEach(function (id) { vis[id] = true; });
      var reasons = {};
      (row.excluded || []).forEach(function (e) { reasons[e.docId] = e.reason; });
      var declined = p.status === 'declined';
      html += '<tr class="' + (declined ? 'row-declined' : '') + '">';
      html += '<th class="party-cell"><div class="party-name">' + esc(p.name) + '</div>' +
        '<div class="party-sub">' + (p.ticketEur ? 'EUR ' + p.ticketEur + 'm ticket' : (p.role === 'case_owner' ? 'EUR 50m hold' : '&nbsp;')) + '</div>' +
        '<div class="party-chips">' + stateChip(p) + partyFlags(p) + '</div></th>';
      folders.forEach(function (f) {
        var docs = DOCS.filter(function (d) { return d.group === f.id; });
        var nVis = docs.filter(function (d) { return vis[d.id]; }).length;
        var cls = nVis === 0 ? 'dot-none' : (nVis === docs.length ? 'dot-full' : 'dot-part');
        var frozen = declined && docs.some(function (d) { return vis[d.id]; });
        if (frozen) cls = 'dot-frozen';
        html += '<td class="cell"><button class="cell-btn" data-party="' + p.id + '" data-folder="' + f.id +
          '" title="' + esc(f.name) + '"><i class="dot ' + cls + '"></i></button></td>';
      });
      html += '</tr>';
    });
    html += '</tbody></table></div>';
    wrap.innerHTML = html;
    wrap.querySelectorAll('.cell-btn').forEach(function (btn) {
      btn.addEventListener('click', function () { openPopover(btn, btn.dataset.party, btn.dataset.folder); });
    });
  }

  function openPopover(anchor, partyId, folderId) {
    var pop = $('#popover');
    var p = S.deal.parties.filter(function (x) { return x.id === partyId; })[0];
    var f = folder(folderId);
    var row = (S.access.matrix || []).filter(function (r) { return r.partyId === partyId; })[0] || { visible: [], excluded: [] };
    var vis = {}; row.visible.forEach(function (id) { vis[id] = true; });
    var reasons = {}; (row.excluded || []).forEach(function (e) { reasons[e.docId] = e.reason; });
    var docs = DOCS.filter(function (d) { return d.group === folderId; });
    var html = '<h4>' + esc(p.name) + ' · ' + esc(f.name) + '</h4>';
    if (p.status === 'declined') html += '<div class="answer-line" style="color:var(--danger)">Frozen snapshot since ' + esc(fmtDate(p.declinedDate)) + ': nothing new is ever granted.</div>';
    docs.forEach(function (d) {
      var on = vis[d.id];
      var sup = d.status === 'superseded' ? '<span class="pop-sup">superseded</span>' : '';
      html += '<div class="pop-doc ' + (on ? '' : 'off') + '"><span class="pop-state">' + (on ? '✓' : '·') + '</span><span class="pop-name">' + esc(d.name) + sup + '</span>' +
        (on ? '' : '<span class="pop-reason">' + esc(reasons[d.id] || '') + '</span>') + '</div>';
    });
    pop.innerHTML = html;
    pop.hidden = false;
    var r = anchor.getBoundingClientRect();
    var left = Math.min(r.right + 8, window.innerWidth - 400);
    pop.style.left = left + 'px';
    pop.style.top = Math.max(12, r.top) + 'px';
    closePopoverOnce = setTimeout(function () {
      document.addEventListener('click', onDocClick);
      document.addEventListener('keydown', onEsc);
    }, 0);
  }
  var closePopoverOnce = null;
  function onDocClick(e) {
    if (!e.target.closest('#popover') && !e.target.closest('.cell-btn')) hidePopover();
  }
  function onEsc(e) { if (e.key === 'Escape') hidePopover(); }
  function hidePopover() {
    $('#popover').hidden = true;
    if (closePopoverOnce) clearTimeout(closePopoverOnce);
    document.removeEventListener('click', onDocClick);
    document.removeEventListener('keydown', onEsc);
  }

  /* ---------- feed ---------- */
  function renderFeed() {
    var wrap = $('#feed');
    if (!FEED.length) { wrap.innerHTML = emptyBox('Nothing planned this week.'); return; }
    wrap.innerHTML = FEED.map(function (f) {
      var applied = S.appliedFeed.indexOf(f.id) !== -1;
      var scope = f.action.partyScope === 'committed' ? 'Committed banks' : (f.action.partyScope === 'all' ? 'All parties' : (f.action.partyIds || []).map(function (id) { return partyName(id); }).join(', '));
      var scopeLabelTxt = scope + ' · ' + (f.action.docIds.length > 4 ? f.action.docIds.length + ' documents' : f.action.docIds.map(docName).join(', '));
      return '<div class="feed-item"><div class="feed-body">' +
        '<div class="feed-title">' + esc(f.title) + '</div>' +
        '<div class="feed-why">' + esc(f.why) + '</div>' +
        '<div class="feed-meta"><span class="tag tag-due">' + esc(f.due) + '</span>' +
        (f.conditional ? '<span class="tag tag-cond">⏳ ' + esc(f.conditional) + '</span>' : '') +
        '<span class="tag">' + esc(scopeLabelTxt) + '</span></div></div>' +
        '<div class="feed-side">' +
        (applied ? '<span class="feed-applied">✓ Applied · in log</span>'
          : '<button class="btn btn-secondary feed-preview" data-feed="' + f.id + '">Preview impact</button>') +
        '</div></div>';
    }).join('');
    wrap.querySelectorAll('.feed-preview').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var f = FEED.filter(function (x) { return x.id === btn.dataset.feed; })[0];
        openPreview(f.action, { feedId: f.id });
      });
    });
  }

  /* ---------- log ---------- */
  function renderLog() {
    var wrap = $('#log');
    var entries = (S.log && S.log.entries) || [];
    if (!entries.length) { wrap.innerHTML = emptyBox('No changes yet. Every applied action lands here, attributed.'); return; }
    wrap.innerHTML = entries.map(function (e) {
      var parties = (e.affectedParties || []).map(partyName);
      var docsChips = (e.docs || []).slice(0, 4).map(function (id) { return '<span class="chip-mini chip-doc">' + esc(docName(id)) + '</span>'; }).join('');
      if ((e.docs || []).length > 4) docsChips += '<span class="chip-mini">+' + (e.docs.length - 4) + ' more</span>';
      return '<div class="log-entry"><div class="log-time" title="' + esc(e.ts) + '">' + esc(timeAgo(e.ts)) + '</div>' +
        '<div class="log-body"><div class="log-summary">' + esc(e.actionSummary || e.summary || '') + '</div>' +
        '<div class="log-who">by <b>' + esc(e.actor || '') + '</b>' + (parties.length ? ' · affected: <b>' + esc(parties.slice(0, 5).join(', ')) + (parties.length > 5 ? ', +' + (parties.length - 5) + ' more' : '') + '</b>' : '') + '</div>' +
        '<div class="log-chips">' + docsChips + '</div></div></div>';
    }).join('');
  }

  /* ---------- action panel (custom actions + draft edits) ---------- */
  var panelType = 'release';
  function renderActionPanel() {
    var docsWrap = $('#action-docs');
    docsWrap.innerHTML = FOLDERS.map(function (f) {
      var docs = DOCS.filter(function (d) { return d.group === f.id; });
      return '<label class="pick-label"><input type="checkbox" value="' + f.id + '" data-folder>' +
        '<span>' + esc(f.name) + '</span><span class="pick-count">' + docs.length + ' docs</span></label>';
    }).join('');
    var partiesWrap = $('#action-parties');
    partiesWrap.innerHTML = S.deal.parties.map(function (p) {
      return '<label class="pick-label"><input type="checkbox" value="' + p.id + '">' +
        '<span>' + esc(p.name) + '</span><span class="pick-count">' + esc((p.status || '').replace('_', ' ')) + '</span></label>';
    }).join('');
  }
  function panelAction() {
    var folderIds = Array.prototype.map.call($('#action-docs').querySelectorAll('input:checked'), function (i) { return i.value; });
    var docIds = [];
    folderIds.forEach(function (fid) { DOCS.forEach(function (d) { if (d.group === fid && docIds.indexOf(d.id) === -1) docIds.push(d.id); }); });
    var scope = ($('#action-panel input[name=scope]:checked') || {}).value || 'committed';
    var partyIds = Array.prototype.map.call($('#action-parties').querySelectorAll('input:checked'), function (i) { return i.value; });
    return { type: panelType, docIds: docIds, partyScope: scope, partyIds: partyIds };
  }
  function prefillPanel(action) {
    $('#action-panel').hidden = false;
    $('#btn-new-action').setAttribute('aria-expanded', 'true');
    panelType = action.type;
    Array.prototype.forEach.call($('#action-panel').querySelectorAll('.seg-btn'), function (b) {
      b.classList.toggle('is-active', b.dataset.type === action.type);
    });
    var scopeInput = $('#action-panel input[name=scope][value="' + (action.partyScope || 'committed') + '"]');
    if (scopeInput) scopeInput.checked = true;
    Array.prototype.forEach.call($('#action-docs').querySelectorAll('input'), function (i) {
      var docs = DOCS.filter(function (d) { return d.group === i.value; });
      i.checked = docs.length > 0 && docs.every(function (d) { return action.docIds.indexOf(d.id) !== -1; });
    });
    $('#action-parties-wrap').hidden = action.partyScope !== 'specific';
    Array.prototype.forEach.call($('#action-parties').querySelectorAll('input'), function (i) {
      i.checked = (action.partyIds || []).indexOf(i.value) !== -1;
    });
    $('#action-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------- preview modal ---------- */
  function openPreview(action, meta) {
    S.currentAction = action; S.currentMeta = meta || null;
    var pr;
    try { pr = computePreview(action); } catch (e) { return toast('Could not build the preview: ' + e.message, 'err'); }
    S.currentPreview = pr;
    showModal(action, pr);
  }
  function showModal(action, pr) {
    var badge = $('#modal-badge');
    badge.textContent = action.type === 'release' ? 'Release' : 'Restrict';
    badge.className = 'badge ' + (action.type === 'release' ? 'badge-release' : 'badge-restrict');
    var docLabel = action.docIds.length > 2 ? action.docIds.length + ' documents' : action.docIds.map(docName).join(', ');
    $('#modal-title').textContent = (action.type === 'release' ? 'Release ' : 'Restrict ') + docLabel + ' · ' + scopeLabel(action);
    $('#modal-body').innerHTML = renderPreview(pr);
    $('#modal-confirm').disabled = !pr.granted.length && !pr.revoked.length;
    $('#modal-confirm').textContent = action.type === 'release' ? 'Apply change' : 'Apply restriction';
    $('#modal-backdrop').hidden = false;
    $('#modal-cancel').focus();
  }
  function renderPreview(pr) {
    var html = '';
    var gains = (pr.granted || []).reduce(function (s, r) { return s + r.docIds.length; }, 0);
    var losses = (pr.revoked || []).reduce(function (s, r) { return s + r.docIds.length; }, 0);
    var exclCount = (pr.excluded || []).length;
    if (!gains && !losses) return '<div class="pv-none">Nothing would change: everyone in scope already has this access, or no one can be granted it. Nothing to apply.</div>';
    html += '<div class="pv-headline">' +
      (gains ? '<span class="num">' + (pr.granted.length === 1 ? '1 party' : pr.granted.length + ' parties') + ' will gain access (' + gains + ' document' + (gains === 1 ? '' : 's') + ')</span>' : '') +
      (gains && losses ? ' · ' : '') +
      (losses ? '<span class="num-bad">' + (pr.revoked.length === 1 ? '1 party' : pr.revoked.length + ' parties') + ' will lose access (' + losses + ' document' + (losses === 1 ? '' : 's') + ')</span>' : '') +
      (exclCount ? '<div class="pv-excl" style="margin-top:4px">' + exclCount + ' parties stay excluded</div>' : '') +
      '</div>';

    (pr.warnings || []).forEach(function (wrn) {
      var cls = wrn.level === 'block' ? 'warn-red' : (wrn.level === 'warn' ? 'warn-amber' : 'warn-info');
      html += '<div class="warn-banner ' + cls + '"><span class="warn-ico">' + (wrn.level === 'block' ? '⛔' : (wrn.level === 'warn' ? '⚠' : 'ℹ')) + '</span><span>' + esc(wrn.msg) + '</span></div>';
    });

    if ((pr.excluded || []).length) {
      html += '<div class="pv-section"><div class="pv-section-title">Stays excluded</div>';
      (pr.excluded || []).forEach(function (r) {
        html += '<div class="pv-row"><div class="pv-party" style="color:var(--text-2)">' + esc(partyName(r.partyId)) + '</div>' +
          '<div class="pv-docs">' + r.docIds.map(function (id, i) { return '<span class="pv-doc pv-doc-off" title="' + esc((r.reasons || [])[i] || '') + '">' + esc(docName(id)) + '</span>'; }).join('') + '</div>' +
          '<div class="pv-excl">' + esc((r.reasons || [])[0] || '') + '</div></div>';
      });
      html += '</div>';
    }
    if ((pr.granted || []).length) {
      html += '<div class="pv-section"><div class="pv-section-title">Will gain access</div>';
      (pr.granted || []).forEach(function (r) {
        html += '<div class="pv-row"><div class="pv-party">' + esc(partyName(r.partyId)) + '</div>' +
          '<div class="pv-docs">' + r.docIds.slice(0, 8).map(function (id) { return '<span class="pv-doc">' + esc(docName(id)) + '</span>'; }).join('') +
          (r.docIds.length > 8 ? '<span class="pv-doc">+' + (r.docIds.length - 8) + ' more</span>' : '') + '</div></div>';
      });
      html += '</div>';
    }
    if ((pr.revoked || []).length) {
      html += '<div class="pv-section"><div class="pv-section-title">Will lose access</div>';
      (pr.revoked || []).forEach(function (r) {
        html += '<div class="pv-row"><div class="pv-party" style="color:var(--danger)">' + esc(partyName(r.partyId)) + '</div>' +
          '<div class="pv-docs">' + r.docIds.slice(0, 8).map(function (id) { return '<span class="pv-doc pv-doc-off">' + esc(docName(id)) + '</span>'; }).join('') +
          (r.docIds.length > 8 ? '<span class="pv-doc pv-doc-off">+' + (r.docIds.length - 8) + ' more</span>' : '') + '</div></div>';
      });
      html += '</div>';
    }
    return html;
  }
  function closeModal() { $('#modal-backdrop').hidden = true; S.currentAction = null; }

  function confirmApply() {
    if (!S.currentAction) return;
    var btn = $('#modal-confirm');
    btn.disabled = true; btn.textContent = 'Applying…';
    api.apply(S.currentAction).then(function (res) {
      if (!res.ok) throw new Error('Nothing to apply: this change is already in place.');
      if (S.currentMeta && S.currentMeta.feedId && S.appliedFeed.indexOf(S.currentMeta.feedId) === -1) {
        S.appliedFeed.push(S.currentMeta.feedId);
        try { localStorage.setItem('neoshare-applied-feed', JSON.stringify(S.appliedFeed)); } catch (e) { }
      }
      closeModal();
      toast('Change applied and logged.', 'ok');
      refreshData();
    }).catch(function (err) {
      btn.disabled = false; btn.textContent = 'Apply change';
      toast('Could not apply: ' + (err && err.message ? err.message : err), 'err');
    });
  }
  function refreshData() {
    Promise.all([api.getDeal(), api.getAccess(), api.getLog()]).then(function (rs) {
      S.deal = rs[0]; S.access = rs[1]; S.log = rs[2];
      renderAll();
    }).catch(function (err) { toast('Could not refresh: ' + err.message, 'err'); });
  }

  /* ---------- command bar + thread ---------- */
  function suggestions() {
    var items = [];
    FEED.forEach(function (f) { if (S.appliedFeed.indexOf(f.id) === -1) items.push({ kind: 'pending action', text: f.title + ' (' + (f.action.docIds.length > 2 ? f.action.docIds.length + ' docs' : f.action.docIds.map(docName).join(', ')) + ')', submit: f.title }); });
    SUGGEST_QUESTIONS.forEach(function (q) { items.push({ kind: 'question', text: q, submit: q }); });
    return items;
  }
  function renderSuggestions(filter) {
    var wrap = $('#cmd-suggestions');
    var items = suggestions().filter(function (s) { return !filter || s.text.toLowerCase().indexOf(filter.toLowerCase()) !== -1; }).slice(0, 7);
    if (!items.length) { wrap.hidden = true; S.selIdx = -1; return; }
    wrap.innerHTML = items.map(function (s, i) {
      return '<button class="sug-item' + (i === S.selIdx ? ' is-active' : '') + '" data-i="' + i + '"><span>' + esc(s.text) + '</span><span class="sug-kind">' + esc(s.kind) + '</span></button>';
    }).join('');
    wrap.hidden = false;
    wrap.dataset.items = JSON.stringify(items);
    wrap.querySelectorAll('.sug-item').forEach(function (b) {
      b.addEventListener('click', function () {
        var items = JSON.parse(wrap.dataset.items);
        submitCommand(items[+b.dataset.i].submit);
      });
    });
  }
  function submitCommand(text) {
    text = (text || '').trim();
    if (!text) return;
    $('#cmd-input').value = '';
    hideSuggestions();
    $('#thread').hidden = false;
    $('#btn-new-conv').hidden = false;
    S.messages.push({ role: 'user', text: text });
    var pendingIdx = S.messages.push({ role: 'assistant', pending: true }) - 1;
    renderThread();
    api.chat(text, S.convId).then(function (res) {
      if (res && res.conversationId) S.convId = res.conversationId;
      var reply = res && res.reply ? res.reply : { kind: 'clarification', text: 'The API answered in an unexpected shape.', options: [] };
      if (reply.kind === 'decision-draft') {
        // Follow-ups refine the open draft in place: replace the old draft card.
        S.messages = S.messages.filter(function (m) { return !(m.role === 'assistant' && m.reply && m.reply.kind === 'decision-draft'); });
        S.messages.push({ role: 'assistant', reply: reply });
      } else {
        S.messages[pendingIdx] = { role: 'assistant', reply: reply };
      }
      renderThread();
    }).catch(function (err) {
      S.messages[pendingIdx] = { role: 'assistant', reply: { kind: 'clarification', text: 'Something went wrong: ' + (err && err.message ? err.message : err), options: [] } };
      renderThread();
    });
  }
  function hideSuggestions() { $('#cmd-suggestions').hidden = true; S.selIdx = -1; }

  function renderThread() {
    var wrap = $('#thread');
    if (!S.messages.length) return;
    wrap.innerHTML = S.messages.map(function (m) {
      if (m.role === 'user') return '<div class="msg msg-user">' + esc(m.text) + '</div>';
      if (m.pending) return '<div class="msg msg-assistant"><div class="skel skel-line" style="width:220px"></div></div>';
      return '<div class="msg msg-assistant">' + renderReply(m.reply, m) + '</div>';
    }).join('');
    wrap.scrollTop = wrap.scrollHeight;
    wrap.querySelectorAll('.draft-apply').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var draft = JSON.parse(btn.dataset.draft);
        openPreview(draft.action, { draft: draft });
      });
    });
    wrap.querySelectorAll('.draft-edit').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var draft = JSON.parse(btn.dataset.draft);
        prefillPanel(draft.action);
        toast('Draft loaded into the action builder. Adjust and preview again.', 'info');
      });
    });
    wrap.querySelectorAll('.clarify-opt').forEach(function (btn) {
      btn.addEventListener('click', function () { submitCommand(btn.dataset.text); });
    });
  }
  function renderReply(reply, msg) {
    if (reply.kind === 'decision-draft') {
      var d = reply.draft || {};
      var pr = d.preview || (d.action ? computePreview(d.action) : null);
      var html = '<div class="draft-card">';
      html += '<div class="draft-label">' + esc(d.label || 'Proposed action') + '</div>';
      if (d.note) html += '<span class="draft-note">⏳ ' + esc(d.note) + '</span>';
      html += '<div class="draft-scope">' + esc(scopeLabel(d.action)) + ' · ' + (d.action.docIds.length > 2 ? d.action.docIds.length + ' documents' : d.action.docIds.map(docName).join(', ')) + '</div>';
      if (pr) html += '<div>' + renderPreviewInline(pr) + '</div>';
      if (msg.applied) { html += '<div class="draft-foot"><span class="draft-applied">✓ Applied and logged</span></div>'; }
      else {
        html += '<div class="draft-foot"><button class="btn btn-primary draft-apply" data-draft=\'' + JSON.stringify(d).replace(/'/g, '&#39;') + '\'>Apply</button>' +
          '<button class="btn draft-edit" data-draft=\'' + JSON.stringify(d).replace(/'/g, '&#39;') + '\'>Edit</button>' +
          '<span class="pv-excl">Apply opens the confirmation flow. Nothing changes before you confirm.</span></div>';
      }
      return html + '</div>';
    }
    if (reply.kind === 'answer') {
      var a = reply.answer || {};
      var html = '<div class="answer"><div class="answer-headline">' + esc(a.headline || '') + '</div>';
      if ((a.parties || []).length) html += '<div class="chip-row">' + a.parties.map(function (id) { return '<span class="chip-mini chip-party">' + esc(partyName(id)) + '</span>'; }).join('') + '</div>';
      if ((a.docs || []).length) html += '<div class="chip-row">' + a.docs.map(function (id) { return '<span class="chip-mini chip-doc">' + esc(docName(id)) + '</span>'; }).join('') + '</div>';
      (a.reasons || []).forEach(function (r) { html += '<div class="reason">' + esc(r.msg) + '</div>'; });
      (a.lines || []).forEach(function (l) { html += '<div class="answer-line">' + esc(l) + '</div>'; });
      return html + '</div>';
    }
    // clarification
    var html = '<div class="clarify">' + esc(reply.text || '') + '</div>';
    if ((reply.options || []).length) {
      html += '<div class="clarify-opts">' + reply.options.map(function (o) {
        return '<button class="clarify-opt" data-text=\'' + esc(o.text).replace(/'/g, '&#39;') + '\'>' + esc(o.label || o.text) + '</button>';
      }).join('') + '</div>';
    }
    return html;
  }
  function renderPreviewInline(pr) {
    var html = '';
    var gains = (pr.granted || []).reduce(function (s, r) { return s + r.docIds.length; }, 0);
    var exclCount = (pr.excluded || []).length;
    (pr.warnings || []).forEach(function (wrn) {
      var cls = wrn.level === 'block' ? 'warn-red' : (wrn.level === 'warn' ? 'warn-amber' : 'warn-info');
      html += '<div class="warn-banner ' + cls + '"><span class="warn-ico">' + (wrn.level === 'block' ? '⛔' : (wrn.level === 'warn' ? '⚠' : 'ℹ')) + '</span><span>' + esc(wrn.msg) + '</span></div>';
    });
    if (!gains && !(pr.revoked || []).length) return html + '<div class="pv-none">Nothing would change.</div>';
    html += '<div class="pv-row"><div class="pv-party" style="min-width:auto">' +
      (gains ? '<span style="color:var(--ok);font-weight:700">' + gains + ' grant' + (gains === 1 ? '' : 's') + '</span>' : '') +
      (gains && exclCount ? ' · ' : '') +
      (exclCount ? '<span style="color:var(--text-2)">' + exclCount + ' excluded</span>' : '') + '</div>' +
      '<div class="pv-docs">' + (pr.granted || []).slice(0, 4).map(function (r) {
        return '<span class="pv-doc">' + esc(partyName(r.partyId)) + '</span>';
      }).join('') + '</div></div>';
    return html;
  }

  /* ---------- toast + bindings ---------- */
  var toastTimer = null;
  function toast(msg, kind) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (kind === 'err' ? ' toast-err' : kind === 'ok' ? ' toast-ok' : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 3800);
  }

  function bindStatic() {
    var input = $('#cmd-input');
    input.addEventListener('focus', function () { if (!input.value) renderSuggestions(''); });
    input.addEventListener('input', function () {
      S.selIdx = -1;
      if (input.value.trim()) renderSuggestions(input.value);
      else renderSuggestions('');
    });
    input.addEventListener('keydown', function (e) {
      var wrap = $('#cmd-suggestions');
      if (e.key === 'Enter') {
        if (!wrap.hidden && S.selIdx >= 0) {
          var items = JSON.parse(wrap.dataset.items);
          e.preventDefault();
          submitCommand(items[S.selIdx].submit);
          return;
        }
        submitCommand(input.value);
      } else if (e.key === 'ArrowDown' && !wrap.hidden) {
        e.preventDefault();
        var items = JSON.parse(wrap.dataset.items);
        S.selIdx = Math.min(S.selIdx + 1, items.length - 1); renderSuggestions(input.value || '');
      } else if (e.key === 'ArrowUp' && !wrap.hidden) {
        e.preventDefault();
        S.selIdx = Math.max(S.selIdx - 1, 0); renderSuggestions(input.value || '');
      } else if (e.key === 'Escape') { hideSuggestions(); }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.command-bar') && !e.target.closest('#cmd-suggestions')) hideSuggestions();
    });
    $('#btn-new-conv').addEventListener('click', function () {
      S.messages = []; S.convId = null;
      $('#thread').hidden = true; $('#btn-new-conv').hidden = true;
    });

    $('#btn-new-action').addEventListener('click', function () {
      var panel = $('#action-panel');
      panel.hidden = !panel.hidden;
      this.setAttribute('aria-expanded', String(!panel.hidden));
    });
    $('#action-panel').querySelectorAll('.seg-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        panelType = b.dataset.type;
        $('#action-panel').querySelectorAll('.seg-btn').forEach(function (x) { x.classList.toggle('is-active', x === b); });
      });
    });
    $('#action-panel').querySelectorAll('input[name=scope]').forEach(function (r) {
      r.addEventListener('change', function () {
        $('#action-parties-wrap').hidden = r.value !== 'specific';
      });
    });
    $('#btn-preview-action').addEventListener('click', function () {
      var action = panelAction();
      var err = $('#action-error');
      if (!action.docIds.length) { err.textContent = 'Pick at least one folder.'; err.hidden = false; return; }
      if (action.partyScope === 'specific' && !action.partyIds.length) { err.textContent = 'Pick at least one party.'; err.hidden = false; return; }
      err.hidden = true;
      openPreview(action);
    });

    $('#modal-close').addEventListener('click', closeModal);
    $('#modal-cancel').addEventListener('click', closeModal);
    $('#modal-confirm').addEventListener('click', confirmApply);
    $('#modal-backdrop').addEventListener('click', function (e) { if (e.target === this) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#modal-backdrop').hidden) closeModal();
    });
  }

  // Test hook for the node:test harness (no-op in the browser).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { api: api, computePreview: computePreview, visibleIds: visibleIds, applyAction: applyAction, chat: chat, party: party, doc: doc, load: load };
  }

  init();
})();
