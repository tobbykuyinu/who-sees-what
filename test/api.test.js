'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createStore } from '../src/store.js';
import { createApp } from '../src/routes.js';
import { makeTempStore } from './helpers.js';

function boot() {
  const { dir } = makeTempStore();
  const store = createStore(dir);
  const app = express();
  app.use(express.json());
  app.use('/api', createApp(store));
  // mirror server.js: JSON-first 404 for unknown routes
  app.use((req, res) => res.status(404).json({ error: `unknown route: ${req.method} ${req.path} — see /api/deal` }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      resolve({ base: `http://127.0.0.1:${port}`, server, store });
    });
  });
}

const j = async (res) => ({ status: res.status, body: await res.json() });

test('GET /api/deal — parties, documents, states, permanent flags', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const { status, body } = await j(await fetch(`${base}/api/deal`));
  assert.equal(status, 200);
  assert.equal(body.parties.length, 11);
  assert.equal(body.documents.length, 78);
  assert.deepEqual(body.states, ['invited', 'nda_signed', 'committed', 'declined']);
  const intercreditor = body.documents.find((d) => d.id === 'd-066');
  assert.equal(intercreditor.flags.borrowerExcluded, true);
  const sideLetter = body.documents.find((d) => d.id === 'd-071');
  assert.equal(sideLetter.flags.partyScoped, true);
});

test('GET /api/access — frozen Fjord, held valuation', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const { body } = await j(await fetch(`${base}/api/access`));
  const fjord = body.matrix.find((r) => r.partyId === 'bank-e');
  assert.equal(fjord.visible.length, 0);
  assert.ok(fjord.excluded.every((e) => /dropped out/.test(e.reason)));
  const alpenland = body.matrix.find((r) => r.partyId === 'bank-d');
  assert.ok(alpenland.excluded.some((e) => e.docId === 'd-038' && /not released/.test(e.reason)));
});

test('POST /api/preview — validates and simulates without mutating', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const ok = await j(await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'release', docIds: ['d-038'], partyScope: 'committed' } }),
  }));
  assert.equal(ok.status, 200);
  assert.ok(ok.body.granted.some((g) => g.partyId === 'bank-d'));
  assert.ok(ok.body.excluded.some((e) => e.partyId === 'bank-e'));
  assert.ok(ok.body.warnings.some((w) => /previous version/.test(w.msg)));

  const bad = await j(await fetch(`${base}/api/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'nuke', docIds: [], partyScope: 'everyone' } }),
  }));
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /action\.type/);

  // preview never mutates
  const after = await j(await fetch(`${base}/api/access`));
  assert.ok(!after.body.matrix.find((r) => r.partyId === 'bank-d').visible.includes('d-038'));
});

test('POST /api/apply — applies, logs with attribution, idempotent', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const body = { action: { type: 'release', docIds: ['d-038'], partyScope: 'specific', partyIds: ['bank-d'] } };
  const applied = await j(await fetch(`${base}/api/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor': 'Test Analyst' },
    body: JSON.stringify(body),
  }));
  assert.equal(applied.status, 200);
  assert.equal(applied.body.ok, true);
  assert.equal(applied.body.changeLogEntry.actor, 'Test Analyst');
  assert.match(applied.body.changeLogEntry.actionSummary, /Valuation report/);

  const access = await j(await fetch(`${base}/api/access`));
  assert.ok(access.body.matrix.find((r) => r.partyId === 'bank-d').visible.includes('d-038'));

  const log = await j(await fetch(`${base}/api/log`));
  assert.equal(log.body.entries.length, 6, '5 seeded entries + the new one');
  assert.equal(log.body.entries[0].docs[0].id, 'd-038');

  const again = await j(await fetch(`${base}/api/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor': 'Test Analyst' },
    body: JSON.stringify(body),
  }));
  assert.equal(again.body.changeLogEntry.granted.length, 0);
});

test('POST /api/chat — demo phrasings: decision draft, answers, clarifications, refinement', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const chat = async (text, conversationId) => j(await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, ...(conversationId ? { conversationId } : {}) }),
  }));

  // story 1 command
  const draft = await chat('release the new valuation to everyone committed');
  assert.equal(draft.status, 200);
  assert.equal(draft.body.reply.kind, 'decision-draft');
  assert.deepEqual(draft.body.reply.draft.action.docIds, ['d-038']);
  assert.equal(draft.body.reply.draft.action.partyScope, 'committed');
  assert.ok(draft.body.reply.draft.preview.granted.some((g) => g.partyId === 'bank-d'));
  assert.ok(draft.body.reply.draft.preview.excluded.some((e) => e.partyId === 'bank-e'));
  assert.ok(draft.body.reply.draft.preview.excluded.some((e) => e.partyId === 'bank-f'));
  const conversationId = draft.body.reply.conversationId;

  // story 4 question
  const fjord = await chat('what can Fjord see?', conversationId);
  assert.equal(fjord.body.reply.kind, 'answer');
  assert.match(fjord.body.reply.answer.text, /dropped out/);
  assert.equal(fjord.body.reply.answer.rows[0].visible.length, 0);

  // story 5 question
  const borrower = await chat('can the borrower see the legal draft?', conversationId);
  assert.equal(borrower.body.reply.kind, 'answer');
  assert.equal(borrower.body.reply.answer.canSee, false);
  assert.match(borrower.body.reply.answer.reason, /lender legal/);

  // story 2 question
  const side = await chat('who sees Elbmarsch’s side letter?', conversationId);
  assert.equal(side.body.reply.kind, 'answer');
  const rows = side.body.reply.answer.rows;
  assert.equal(rows.find((r) => r.partyId === 'bank-c').canSee, true);
  assert.equal(rows.find((r) => r.partyId === 'bank-b').canSee, false);
  assert.match(rows.find((r) => r.partyId === 'bank-b').reason, /party-scoped/);

  // refinement re-drafts in place
  const refined = await chat('exclude Alpenland too', conversationId);
  assert.equal(refined.body.reply.kind, 'decision-draft');
  assert.equal(refined.body.reply.refined, true);
  assert.equal(refined.body.reply.draft.action.partyScope, 'specific');
  assert.ok(!refined.body.reply.draft.action.partyIds.includes('bank-d'));
  assert.ok(refined.body.reply.draft.action.partyIds.includes('bank-c'));

  // story 3: conditional grant
  const nda = await chat('grant Mainufer room access once the NDA is signed');
  assert.equal(nda.body.reply.kind, 'decision-draft');
  assert.equal(nda.body.reply.draft.action.condition, 'nda_signed');
  assert.equal(nda.body.reply.draft.preview.granted[0].pending, true);
  assert.ok(nda.body.reply.draft.preview.granted[0].docIds.length > 30, 'full NDA package');

  // ambiguity -> clarification
  const amb = await chat('release the draft to everyone committed');
  assert.equal(amb.body.reply.kind, 'clarification');
  assert.ok(amb.body.reply.options.length >= 2);

  // apply-the-draft via the normal apply endpoint (frontend flow)
  const applied = await j(await fetch(`${base}/api/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: nda.body.reply.draft.action }),
  }));
  assert.equal(applied.status, 200);
  assert.match(applied.body.changeLogEntry.actionSummary, /Pending grant/);
});

test('POST /api/chat — validation + unknown routes', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const empty = await j(await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  }));
  assert.equal(empty.status, 400);
  const missing = await j(await fetch(`${base}/api/nope`));
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /unknown route/);
});

test('GET /api/log — seeded deal story answers history honestly, newest first', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const { body } = await j(await fetch(`${base}/api/log`));
  assert.equal(body.entries.length, 5, 'deal story seeded into a fresh state');
  assert.match(body.entries[0].actionSummary, /Q&A log/, 'newest first');
  assert.match(body.entries[4].actionSummary, /Alpenland signed the NDA/);
  assert.equal(body.entries[3].affectedParties[0].id, 'bank-e', 'dropout entry names Fjord');
});

test('POST /api/chat — dispatch phrase: "I need everyone who committed to get the updated numbers right now"', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());
  const res = await j(await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'I need everyone who committed to get the updated numbers right now' }),
  }));
  assert.equal(res.status, 200);
  const r = res.body.reply;
  assert.equal(r.kind, 'decision-draft');
  assert.deepEqual(r.draft.action.docIds, ['d-038']);
  assert.equal(r.draft.action.partyScope, 'committed');
  assert.ok(r.draft.preview.granted.some((g) => g.partyId === 'bank-d'), 'valuation update released incl. Alpenland');
});

test('POST /api/chat — LLM fallback: draft-first prompt with real data + pending actions', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());

  // a pending grant exists so the prompt must surface it
  const pending = await j(await fetch(`${base}/api/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: { type: 'release', docIds: ['d-009'], partyScope: 'specific', partyIds: ['bank-f'], condition: 'nda_signed' } }),
  }));
  assert.equal(pending.status, 200);

  const origFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/v1/messages')) {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ kind: 'decision-draft', text: 'Draft ready', action: { type: 'release', docIds: ['d-009'], partyScope: 'committed', partyIds: [] } }) }],
        }),
      };
    }
    return origFetch(url, init); // pass everything else through to the server
  };
  t.after(() => { globalThis.fetch = origFetch; });

  const oldKey = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = oldKey; });

  // no parser keywords, no question pattern -> falls through to the LLM
  const res = await j(await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'make sure the participants have everything they should have' }),
  }));
  assert.equal(res.status, 200);
  assert.equal(res.body.reply.kind, 'decision-draft');
  assert.equal(res.body.reply.draft.action.docIds[0], 'd-009');
  assert.ok(res.body.reply.draft.preview, 'preview recomputed through the deterministic engine');

  assert.equal(calls.length, 1);
  const sys = JSON.parse(calls[0].init.body).system;
  assert.match(sys, /DRAFT FIRST/);
  assert.match(sys, /PENDING ACTIONS: Mainufer/, 'pending grant surfaced to the model');
  assert.match(sys, /d-038/, 'real document ids in the prompt');
  assert.match(sys, /bank-d:Alpenland/, 'real party ids in the prompt');
});

test('POST /api/chat — LLM fallback: clarification options become actionable phrasings; hallucinated ids are rejected', async (t) => {
  const { base, server } = await boot();
  t.after(() => server.close());

  const origFetch = globalThis.fetch;
  const canned = {
    kind: 'clarification',
    text: 'Which documents should everyone committed get?',
    options: ['Release the updated valuation to everyone committed', 'Release the information memorandum to everyone committed'],
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/v1/messages')) {
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: JSON.stringify(canned) }] }),
      };
    }
    return origFetch(url, init);
  };
  t.after(() => { globalThis.fetch = origFetch; });

  const oldKey = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'test-key';
  t.after(() => { if (oldKey === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = oldKey; });

  const chat = async (text) => j(await fetch(`${base}/api/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  }));

  const cl = await chat('make sure the participants have everything they should have');
  assert.equal(cl.body.reply.kind, 'clarification');
  assert.equal(cl.body.reply.options[0].kind, 'phrase');
  assert.equal(cl.body.reply.options[0].value, 'Release the updated valuation to everyone committed');
  assert.equal(cl.body.reply.options[0].label, cl.body.reply.options[0].value, 'value IS the phrasing — echo it back');

  // hallucinated doc ids never reach the engine
  const bad = { kind: 'decision-draft', text: 'x', action: { type: 'release', docIds: ['d-999'], partyScope: 'committed', partyIds: [] } };
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/v1/messages')) {
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(bad) }] }) };
    }
    return origFetch(url, init);
  };
  const res = await chat('make sure the participants have everything they should have');
  assert.notEqual(res.body.reply.kind, 'decision-draft', 'hallucinated draft is dropped, parser fallback answers');
});
