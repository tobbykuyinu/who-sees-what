'use strict';

/**
 * chat.js — the conversation layer over the permission engine.
 *
 * "AI drafts the decision; the preview approves it." The analyst declares
 * intent in plain language; this layer turns it into a DECISION DRAFT (the
 * action + the full impact preview, ready for the Apply button), answers
 * questions in permission terms with reasons, or asks a clarification when
 * intent is ambiguous.
 *
 * Honesty note (see README): this is a deterministic keyword parser over the
 * mock data. In production this layer is LLM-backed with the SAME contract:
 * text in -> {kind, draft|answer|clarification} out; the permission engine
 * below it does not change.
 *
 * Conversation memory is minimal, per spec: the current draft + last topic
 * per conversationId, so follow-ups like "exclude Alpenland too" re-draft
 * in place.
 */

import {
  effectiveVisibility, humanizeReason, buildAccessMatrix, resolveScope,
} from './engine.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function createChat(idx, deps) {
  const conversations = new Map(); // conversationId -> { draft, lastText }
  let counter = 0;

  async function handle({ text, conversationId }) {
    const id = conversationId || `conv-${++counter}`;
    const conv = conversations.get(id) || { draft: null, lastText: null };

    // 1. refinements of the current draft (follow-ups, per spec)
    if (conv.draft) {
      const refined = tryRefine(conv, text);
      if (refined) {
        conversations.set(id, conv);
        return { reply: { ...refined, conversationId: id } };
      }
    }

    // 2. questions
    const q = tryQuestion(conv, text);
    if (q) {
      conversations.set(id, conv);
      return { reply: { ...q, conversationId: id } };
    }

    // 3. action intents
    const d = tryDraft(conv, text);
    if (d) {
      conversations.set(id, conv);
      return { reply: { ...d, conversationId: id } };
    }

    // 4. LLM fallback: free-form intent goes to the model, and its draft is
    //    re-computed through the SAME deterministic preview engine below.
    const llm = await tryLlm(text, deps);
    if (llm) {
      conversations.set(id, conv);
      return { reply: { ...llm, conversationId: id } };
    }

    // 5. parser fallback
    const fallback = {
      kind: 'clarification',
      question: 'I can draft an access change, answer a question about who sees what, or refine the current draft. Try "release the new valuation to everyone committed", "what can Fjord see?" or "who sees the side letter?".',
      options: [],
    };
    conv.lastText = text;
    conversations.set(id, conv);
    return { reply: { ...fallback, conversationId: id } };
  }

  // ---- LLM fallback ----------------------------------------------------------

  async function tryLlm(text, deps) {
    const base = process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic';
    const key = process.env.ANTHROPIC_AUTH_TOKEN;
    const model = process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro[1m]';
    if (!key) return null;
    const parties = deps.overlay().parties || [];
    const docs = deps.overlay().documents || [];
    const partyLine = parties.map((p) => `${p.id}:${p.name} (${p.state || p.status})`).join('; ');
    const docLine = docs.slice(0, 60).map((d) => `${d.id}:${d.name}`).join('; ');
    const sys = [
      'You are the intent layer of a data-room access product. Convert the analyst\'s message into STRICT JSON, one of:',
      '{"kind":"decision-draft","action":{"type":"release","docIds":[],"partyScope":"committed|all|specific","partyIds":[]},"text":"short plain-English summary"}',
      '{"kind":"answer","text":"plain-English answer about access"}',
      '{"kind":"clarification","text":"question","options":["opt1","opt2"]}',
      'Only ever draft release actions. Never include borrower or declined parties in grants.',
      `PARTIES: ${partyLine}`,
      `DOCUMENTS: ${docLine}`,
      'Reply with JSON only, no markdown fences.',
    ].join('\n');
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const r = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: 500, system: sys, messages: [{ role: 'user', content: text }] }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) return null;
      const data = await r.json();
      const content = (data.content || []).map((b) => b.text || '').join('');
      const json = JSON.parse(content.replace(/^```json|```$/g, '').trim());
      if (json.kind === 'decision-draft' && json.action) {
        const action = {
          type: 'release',
          docIds: Array.isArray(json.action.docIds) ? json.action.docIds : [],
          partyScope: ['committed', 'all', 'specific'].includes(json.action.partyScope) ? json.action.partyScope : 'committed',
          partyIds: Array.isArray(json.action.partyIds) ? json.action.partyIds : [],
        };
        const preview = deps.preview(action);
        return { kind: 'decision-draft', refined: false, change: null, text: json.text || 'Draft ready', draft: { action, preview } };
      }
      if (json.kind === 'answer' && json.text) return { kind: 'answer', answer: { type: 'llm', text: json.text } };
      if (json.kind === 'clarification' && json.text) return { kind: 'clarification', question: json.text, options: (json.options || []).slice(0, 4) };
      return null;
    } catch (e) {
      return null;
    }
  }

  // ---- refinement ----------------------------------------------------------

  function tryRefine(conv, text) {
    const t = text.toLowerCase().replace(/^(no|actually|wait|hmm)[,\s]+/, '').trim();
    if (/^(what|who|can|why|how|when|where)\b/.test(t)) return null; // questions are never refinements
    if (/^(cancel|forget|reset|start over|clear)/.test(t)) {
      conv.draft = null;
      return { kind: 'clarification', question: 'Draft cleared. What would you like to do next?', options: [] };
    }
    if (/^(yes|apply|confirm|do it|go ahead|execute|ok)$/.test(t)) {
      return { kind: 'clarification', question: 'I draft decisions — press Apply on the draft card to make the change (and it will be logged).', options: [] };
    }

    const draft = conv.draft;
    if (!draft) return null;

    // scope reset: "make it everyone committed" / "scope to all"
    const scopeReset = t.match(/everyone\s+committed|all\s+committed|committed\s+banks|the\s+syndicate/)
      ? 'committed' : /everyone|everybody|all\s+banks|all\s+parties|to\s+all\b/.test(t) ? 'all' : null;

    const exclude = t.match(/exclude|remove|without|minus|except|take\s+out|drop|not\s+incl|leave\s+out/);
    const include = !exclude && t.match(/include|add|also|too|as\s+well|bring\s+in/);
    const parties = matchParties(idx, t).parties; // raw text: refinements name parties, not docs

    if (!scopeReset && !exclude && !include) return null;

    const current = new Set(draft.action.partyScope === 'specific'
      ? draft.action.partyIds
      : resolveScope(idx, draft.action.partyScope, []).map((p) => p.id));
    let nextScope;
    let change;
    if (scopeReset) {
      nextScope = scopeReset;
      change = `scope set to ${scopeReset === 'committed' ? 'everyone committed (incl. NDA-signed)' : 'all parties'}`;
    } else if (exclude && parties.length) {
      nextScope = 'specific';
      for (const p of parties) current.delete(p);
      change = `excluded ${parties.map((p) => idx.parties.get(p).name).join(', ')}`;
    } else if (include && parties.length) {
      nextScope = 'specific';
      for (const p of parties) current.add(p);
      change = `added ${parties.map((p) => idx.parties.get(p).name).join(', ')}`;
    } else if (exclude || include) {
      return { kind: 'clarification', question: 'Which party should I adjust?', options: partyOptions() };
    } else {
      return null;
    }

    const action = nextScope === 'specific'
      ? { ...draft.action, partyScope: 'specific', partyIds: [...current] }
      : { ...draft.action, partyScope: nextScope, partyIds: [] };
    const preview = deps.preview(action);
    conv.draft = { action, preview };
    return {
      kind: 'decision-draft',
      refined: true,
      change,
      draft: { action, preview },
    };
  }

  // ---- questions -----------------------------------------------------------

  function tryQuestion(conv, text) {
    const t = text.toLowerCase().trim().replace(/\?+$/, '');

    let m = t.match(/^what\s+(can|does|do|may)\s+(.+?)\s+(see|access)$/);
    if (m) return answerPartyView(m[2]);
    m = t.match(/^can\s+(.+?)\s+(see|access)\s+(.+?)$/);
    if (m) return answerCanSee(m[1], m[3], 'can');
    m = t.match(/^why\s+can'?t\s+(.+?)\s+(see|access)\s+(.+?)$/);
    if (m) return answerCanSee(m[1], m[3], 'why');
    m = t.match(/^who\s+(can|may|sees|has\s+access\s+to)\s+(.+?)$/);
    if (m) return answerDocViewers(m[2]);
    m = t.match(/^what\s+changed(\s+(this\s+week|recently|lately|today))?/);
    if (m) return answerHistory();
    return null;
  }

  function answerPartyView(who) {
    const { parties } = matchParties(idx, who);
    if (parties.length === 1) {
      const row = buildAccessMatrix(idx, deps.overlay()).find((r) => r.partyId === parties[0]);
      const party = idx.parties.get(parties[0]);
      let text;
      if (party.status === 'declined') {
        text = `${party.name} dropped out and currently sees nothing — all access was revoked on drop-out and nothing new is ever shared. From the deal notes: "${party.notes}".`;
      } else if (row.pendingGrants.length) {
        text = `${party.name} (${party.status === 'invited' ? 'invited — teaser only' : party.status.replace('_', '-signed')}) currently sees ${row.visible.length} of ${idx.docs.size} documents${row.pendingGrants.length ? `, with ${row.pendingGrants.length} more pending on NDA signature` : ''}.`;
      } else {
        text = `${party.name} (${stateLabel(party.status)}) currently sees ${row.visible.length} of ${idx.docs.size} documents.`;
      }
      return {
        kind: 'answer',
        answer: { type: 'party-view', text, party: { id: party.id, name: party.name, state: party.status }, rows: [row] },
      };
    }
    if (/everyone|all|every/.test(who)) {
      const rows = buildAccessMatrix(idx, deps.overlay());
      return {
        kind: 'answer',
        answer: {
          type: 'party-view', text: `Access state for all ${rows.length} parties:`,
          party: null, rows,
        },
      };
    }
    return { kind: 'clarification', question: 'Which party do you mean?', options: partyOptions() };
  }

  function answerCanSee(who, what, kind) {
    const { parties } = matchParties(idx, who);
    const { docIds, ambiguous } = matchDocs(idx, what);
    if (ambiguous) return docClarification(ambiguous);
    if (parties.length !== 1) return { kind: 'clarification', question: 'Which party do you mean?', options: partyOptions() };
    if (docIds.length !== 1) return { kind: 'clarification', question: 'Which document do you mean?', options: docOptions(what) };

    const party = idx.parties.get(parties[0]);
    const { doc } = idx.docs.get(docIds[0]);
    const res = effectiveVisibility(idx, deps.overlay(), party.id, docIds[0]);
    const text = res.visible
      ? `Yes — ${party.name} can see "${doc.name.en}"${res.via === 'bank_specific' ? ' (party-scoped: it concerns them directly)' : ''}.`
      : `No — ${party.name} cannot see "${doc.name.en}": ${humanizeReason(idx, res, party.id, docIds[0])}.`;
    return {
      kind: 'answer',
      answer: {
        type: kind, text,
        party: { id: party.id, name: party.name },
        doc: { id: doc.id, name: doc.name.en },
        canSee: res.visible,
        reason: res.visible ? null : humanizeReason(idx, res, party.id, docIds[0]),
      },
    };
  }

  function answerDocViewers(what) {
    const { docIds, ambiguous } = matchDocs(idx, what);
    if (ambiguous) return docClarification(ambiguous);
    if (docIds.length !== 1) return { kind: 'clarification', question: 'Which document do you mean?', options: docOptions(what) };
    const { doc } = idx.docs.get(docIds[0]);
    const rows = [...idx.parties.values()].map((p) => {
      const res = effectiveVisibility(idx, deps.overlay(), p.id, docIds[0]);
      return {
        partyId: p.id, partyName: p.name, state: p.status, canSee: res.visible,
        reason: res.visible ? null : humanizeReason(idx, res, p.id, docIds[0]),
      };
    });
    const can = rows.filter((r) => r.canSee);
    const text = `${can.length} ${can.length === 1 ? 'party' : 'parties'} can see "${doc.name.en}": ${can.map((r) => r.partyName).join(', ') || 'no one'}.${doc.sensitivity === 'bank_specific' ? ' It is party-scoped.' : ''}`;
    return {
      kind: 'answer',
      answer: { type: 'doc-viewers', text, doc: { id: doc.id, name: doc.name.en }, rows, canSee: null, reason: null },
    };
  }

  function answerHistory() {
    const log = deps.log();
    const week = log.filter((e) => Date.now() - Date.parse(e.ts) < WEEK_MS).slice(0, 15);
    const text = week.length
      ? `${week.length} change${week.length === 1 ? '' : 's'} this week:` +
        week.map((e) => `\n• ${e.ts.slice(0, 16).replace('T', ' ')} — ${e.actor}: ${e.actionSummary}`).join('')
      : 'No changes yet — the room is in its initial state.';
    return {
      kind: 'answer',
      answer: { type: 'history', text, rows: week, canSee: null, reason: null },
    };
  }

  // ---- action intents ------------------------------------------------------

  function tryDraft(conv, text) {
    const t = text.toLowerCase().trim().replace(/\?+$/, '');

    // "exclude <party> from <doc>" as a fresh action
    let m = t.match(/^exclude\s+(.+?)\s+from\s+(.+)$/);
    if (m) {
      const rdoc = matchDocs(idx, m[2]);
      if (rdoc.ambiguous) return docClarification(rdoc.ambiguous);
      if (!rdoc.docIds.length) return { kind: 'clarification', question: 'Which document should be restricted?', options: docOptions(m[2]) };
      return draftFrom(conv, t, 'restrict', m[2], matchParties(idx, m[1]).parties, m[1]);
    }

    const type = /restrict|revoke|withdraw|hide|lock|remove\s+access|take\s+away/.test(t) ? 'restrict'
      : /release|grant|share|publish|give|open|unlock|expose|make\s+visible/.test(t) ? 'release'
        : null;
    if (!type) return null;

    const { docIds, ambiguous } = matchDocs(idx, t);
    if (ambiguous) return docClarification(ambiguous);
    if (!docIds.length) {
      return {
        kind: 'clarification',
        question: 'Which document? Try "valuation", "rent roll", "side letter", "facility agreement", "information memorandum" — or "room access" for the NDA package.',
        options: docOptions(t),
      };
    }
    const stripped = stripDocs(idx, t);
    const { parties } = matchParties(idx, stripped);
    const scope = /everyone\s+committed|all\s+committed|committed\s+banks|the\s+syndicate|everyone\s+in\s+the\s+deal|in\s+the\s+deal/.test(stripped) ? 'committed'
      : /everyone|everybody|all\s+banks|all\s+parties|every\s+bank|to\s+all\b/.test(stripped) ? 'all'
        : parties.length ? 'specific' : null;
    if (!scope) {
      return {
        kind: 'clarification',
        question: 'Who should this apply to — "everyone committed", "everyone", or a specific bank?',
        options: [
          { value: 'committed', label: 'everyone committed', kind: 'scope' },
          { value: 'all', label: 'everyone (all parties)', kind: 'scope' },
          ...partyOptions().slice(0, 4),
        ],
      };
    }

    const condition = /once\s+the\s+nda\s+is\s+signed|on\s+nda\s+signature|when\s+(the\s+)?nda|after\s+nda/.test(t)
      ? 'nda_signed' : undefined;

    return draftFrom(conv, t, type, null, parties, null, condition, scope, docIds);
  }

  function draftFrom(conv, text, type, docPhrase, parties, partyPhrase, condition, scope, docIds) {
    let action;
    if (type === 'restrict' && partyPhrase) {
      action = { type, docIds: matchDocs(idx, docPhrase).docIds, partyScope: 'specific', partyIds: parties, condition };
    } else {
      action = { type, docIds, partyScope: scope || (parties.length ? 'specific' : 'committed'), partyIds: parties, condition };
    }
    const preview = deps.preview(action);
    conv.draft = { action, preview };
    return { kind: 'decision-draft', refined: false, change: null, draft: { action, preview } };
  }

  // ---- helpers -------------------------------------------------------------

  function docClarification(ambiguous) {
    return {
      kind: 'clarification',
      question: `Which document did you mean — ${ambiguous.map((d) => idx.docs.get(d).doc.name.en).join(' or ')}?`,
      options: ambiguous.map((id) => ({ value: id, label: idx.docs.get(id).doc.name.en, kind: 'doc' })),
    };
  }

  function partyOptions() {
    return [...idx.parties.values()].slice(0, 8).map((p) => ({ value: p.id, label: p.name, kind: 'party' }));
  }

  function docOptions(text) {
    return docCandidates(idx, text).slice(0, 4).map(({ id }) => ({ value: id, label: idx.docs.get(id).doc.name.en, kind: 'doc' }));
  }

  return { handle };
}

// ---- document matching ----------------------------------------------------

/** Deterministic alias table over the mock data (checked in order). */
const DOC_MATCHERS = [
  { re: /\bvaluation\b.*\b(new|updated|update|latest|v2|version 2)\b|\b(new|updated|update|latest|v2|version 2)\b.*\bvaluation\b/, ids: ['d-038'] },
  { re: /\bvaluation\b/, ids: ['d-038'] },
  { re: /side\s*letter/, ids: ['d-071'] },
  { re: /room\s*access|\bthe\s+room\b|\bdata\s+room\b/, ids: (idx) => confidentialCurrent(idx) },
  { re: /information\s*memorandum|\bmemo\b|\bim\b/, ids: ['d-009'] },
  { re: /rent\s*roll/, ids: (idx, t) => /september|new|updated|v2/.test(t) ? ['d-026'] : /old|v1/.test(t) ? ['d-025'] : ['d-025', 'd-026'] },
  { re: /term\s*sheet/, ids: (idx, t) => /indicative/.test(t) ? ['d-010'] : ['d-011'] },
  { re: /facility\s*agreement/, ids: (idx, t) => /draft\s*1\b/.test(t) ? ['d-063'] : /draft\s*2\b/.test(t) ? ['d-064'] : ['d-065'] },
  { re: /intercreditor|inter\s*-?\s*bank|legal\s*draft/, ids: ['d-066'] },
  { re: /\bndas?\b/, ids: ['d-004', 'd-005', 'd-006', 'd-007', 'd-008'] },
  { re: /\bteaser\b/, ids: ['d-001'] },
  { re: /timetable|schedule/, ids: ['d-002'] },
  { re: /invitation/, ids: ['d-003'] },
  { re: /security/, ids: ['d-059', 'd-060', 'd-061', 'd-062'] },
  { re: /cash\s*flow/, ids: ['d-012'] },
  { re: /sources\s+and\s+uses/, ids: ['d-014'] },
  { re: /tranche|financing\s*structure/, ids: ['d-013'] },
  { re: /property\s*description/, ids: ['d-015'] },
  { re: /land\s*register/, ids: ['d-016', 'd-017'] },
  { re: /floor\s*plans?/, ids: ['d-020'] },
  { re: /building\s*permit/, ids: ['d-023'] },
  { re: /energy/, ids: ['d-024'] },
  { re: /rent\s*receipts/, ids: ['d-027'] },
  { re: /credit\s*reports?/, ids: ['d-028'] },
  { re: /\blease/, ids: ['d-029', 'd-030', 'd-031', 'd-032', 'd-033', 'd-034', 'd-035', 'd-036'] },
  { re: /photos/, ids: ['d-022'] },
  { re: /commitment\s*letter/, ids: ['d-067', 'd-068'] },
  { re: /fee\s*letter/, ids: ['d-069', 'd-070'] },
  { re: /due\s*diligence|\bdd\b/, ids: (idx, t) => /technical/.test(t) ? ['d-051', 'd-052', 'd-053'] : /legal/.test(t) ? ['d-054', 'd-055', 'd-056'] : ['d-051', 'd-052', 'd-053', 'd-054', 'd-055', 'd-056', 'd-057', 'd-058'] },
  { re: /esg/, ids: ['d-053'] },
  { re: /capex/, ids: ['d-052'] },
  { re: /tax\s*(dd|due)/, ids: ['d-057'] },
  { re: /insurance/, ids: ['d-058'] },
  { re: /purchase\s*agreement/, ids: ['d-056'] },
  { re: /financial\s*statements/, ids: ['d-045', 'd-046', 'd-048'] },
  { re: /track\s*record/, ids: ['d-049'] },
  { re: /kwg/, ids: ['d-050'] },
  { re: /shareholder/, ids: ['d-042'] },
  { re: /register\s*extract/, ids: ['d-043'] },
  { re: /articles/, ids: ['d-044'] },
  { re: /management\s*accounts/, ids: ['d-047'] },
  { re: /q\s*&\s*a|qa\s*log/, ids: ['d-072'] },
  { re: /lender\s*presentation/, ids: ['d-073'] },
  { re: /site\s*visit/, ids: ['d-074'] },
  { re: /decline\s*letter/, ids: ['d-075'] },
  { re: /credit\s*memo/, ids: ['d-076'] },
  { re: /rating/, ids: ['d-077'] },
  { re: /allocation/, ids: ['d-078'] },
  { re: /everything|all\s+(documents|docs)|entire\s+(room|data\s*room)|the\s+whole\s+room/, ids: (idx) => [...idx.docs.keys()] },
];

function confidentialCurrent(idx) {
  return [...idx.docs.values()]
    .filter(({ doc }) => doc.sensitivity === 'confidential' && doc.status === 'current')
    .map(({ doc }) => doc.id);
}

export function matchDocs(idx, text) {
  const t = text.toLowerCase();
  for (const { re, ids } of DOC_MATCHERS) {
    const m = t.match(re);
    if (m) return { docIds: typeof ids === 'function' ? ids(idx, t) : ids, ambiguous: null, matched: m[0] };
  }
  // generic fallback: token overlap with document names
  const cands = docCandidates(idx, t);
  if (cands.length === 1) return { docIds: [cands[0].id], ambiguous: null, matched: cands[0].name.toLowerCase() };
  if (cands.length > 1 && cands[0].score > 0 && cands[0].score > cands[1].score)
    return { docIds: [cands[0].id], ambiguous: null, matched: cands[0].name.toLowerCase() };
  if (cands.length > 1 && cands[0].score > 0) return { docIds: [], ambiguous: cands.slice(0, 4).map((c) => c.id) };
  return { docIds: [], ambiguous: null, matched: null };
}

function docCandidates(idx, text) {
  const tokens = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'that', 'this', 'what', 'who', 'can', 'see', 'why'].includes(w));
  const scores = [...idx.docs.values()].map(({ doc }) => {
    const nameTokens = doc.name.en.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 2);
    let score = 0;
    for (const w of tokens) {
      for (const n of nameTokens) {
        if (n === w) score += 2;               // exact token beats substring
        else if (n.includes(w) || w.includes(n)) score += 1;
      }
    }
    return { id: doc.id, name: doc.name.en, score };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  return scores;
}

/** Remove the matched document phrase so party matching doesn't see it. */
function stripDocs(idx, text) {
  const { matched } = matchDocs(idx, text);
  if (!matched) return text;
  return text.toLowerCase().replace(matched.toLowerCase(), ' ');
}

// ---- party matching -------------------------------------------------------

const PARTY_MATCHERS = [
  [/nordwall|arranger|agent/, 'bank-a'],
  [/rheintal/, 'bank-b'],
  [/elbmarsch/, 'bank-c'],
  [/alpenland/, 'bank-d'],
  [/fjord/, 'bank-e'],
  [/mainufer/, 'bank-f'],
  [/hafenkante|borrower|\bspv\b/, 'borrower'],
  [/lagune|sponsor/, 'sponsor'],
  [/kessler|valuer|appraiser/, 'advisor-valuer'],
  [/brandt|lawyers?|legal\s*advisors?/, 'advisor-legal'],
  [/ostwerk|technical/, 'advisor-tech'],
];

function matchParties(idx, text) {
  const t = text.toLowerCase();
  const parties = [];
  const names = [];
  for (const [re, id] of PARTY_MATCHERS) {
    if (re.test(t) && !parties.includes(id)) {
      parties.push(id);
      names.push(idx.parties.get(id).name);
    }
  }
  return { parties, names };
}

function stateLabel(status) {
  return status === 'nda_signed' ? 'NDA signed' : status;
}
