'use strict';

/**
 * routes.js — HTTP surface. Thin: validate, delegate to the engine, respond.
 * The engine never trusts a client-side preview; /api/apply re-computes.
 */

import { Router } from 'express';
import {
  buildIndex, computePreview, computeApply, buildAccessMatrix, docFlags,
} from './engine.js';
import { makeSeedOverlay, makeSeedLog } from './seed-state.js';
import { validateAction } from './validate.js';
import { createChat } from './chat.js';

const DEFAULT_ACTOR = 'Nordwall analyst';

export function createApp(store) {
  const idx = buildIndex(store.dataRoom);
  store.seedOverlay(makeSeedOverlay(idx));
  store.seedLog(makeSeedLog(idx));
  const chat = createChat(idx, {
    preview: (action) => computePreview(idx, store.overlay, action),
    overlay: () => store.overlay,
    log: () => store.log,
  });

  const router = Router();

  // ---- reads ---------------------------------------------------------------

  router.get('/deal', (req, res) => {
    const deal = idx.dataRoom.deal;
    res.json({
      deal: {
        name: deal.name.en,
        description: deal.description.en,
        amountEur: deal.amount_eur,
        arrangerHoldEur: deal.arranger_hold_eur,
        loanType: deal.loan_type.en,
        tenorYears: deal.tenor_years,
        property: deal.property,
        arranger: deal.arranger,
        arrangerName: idx.parties.get(deal.arranger).name,
        borrower: deal.borrower,
        borrowerName: idx.parties.get(deal.borrower).name,
        phases: deal.phases.map((p) => ({ id: p.id, name: p.name.en, from: p.from, planned: !!p.planned })),
      },
      parties: [...idx.parties.values()].map((p) => ({
        id: p.id, name: p.name, role: p.role, state: p.status,
        committed: p.status === 'committed', ticketEur: p.ticket_eur ?? null, notes: p.notes ?? null,
      })),
      documents: [...idx.docs.values()].map(({ doc, folderId, folderName }) => ({
        id: doc.id,
        name: doc.name.en,
        group: folderId,
        folderName,
        updatedAt: doc.updated,
        sensitivity: doc.sensitivity,
        version: doc.version,
        status: doc.status,
        concernsParty: doc.concerns_party ?? null,
        category: doc.category_key,
        uploadedBy: doc.uploaded_by,
        flags: docFlags(idx, doc.id),
      })),
      states: ['invited', 'nda_signed', 'committed', 'declined'],
      statusLabels: Object.fromEntries(
        Object.entries(idx.dataRoom.labels.status).map(([k, v]) => [k, v.en]),
      ),
    });
  });

  router.get('/access', (req, res) => {
    res.json({
      matrix: buildAccessMatrix(idx, store.overlay),
      generatedAt: new Date().toISOString(),
    });
  });

  router.get('/log', (req, res) => {
    res.json({ entries: store.log });
  });

  // ---- simulate + apply -----------------------------------------------------

  router.post('/preview', (req, res) => {
    const v = validateAction(idx, req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    res.json(computePreview(idx, store.overlay, v.action));
  });

  router.post('/apply', (req, res) => {
    const v = validateAction(idx, req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const actor = String(req.headers['x-actor'] || DEFAULT_ACTOR);
    const { overlay, changeLogEntry } = computeApply(idx, store.overlay, v.action, actor);
    store.apply(overlay, changeLogEntry);
    res.json({ ok: true, changeLogEntry });
  });

  // ---- conversation ----------------------------------------------------------

  router.post('/chat', (req, res) => {
    const { text, conversationId } = req.body || {};
    if (typeof text !== 'string' || !text.trim())
      return res.status(400).json({ error: 'body.text (a non-empty string) is required' });
    if (conversationId !== undefined && typeof conversationId !== 'string')
      return res.status(400).json({ error: 'body.conversationId must be a string' });
    chat.handle({ text: text.trim(), conversationId }).then((out) => res.json(out)).catch((err) => res.status(500).json({ error: String(err && err.message || err) }));
  });

  return router;
}
