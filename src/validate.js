'use strict';

/**
 * validate.js — strict, human-readable validation for every action body.
 * The engine never guesses: a malformed action is a 400, not a surprise.
 */

export function validateAction(idx, body) {
  const action = body && typeof body === 'object' ? body.action : undefined;
  if (!action || typeof action !== 'object') return { error: 'body.action is required' };

  const { type, docIds, partyScope, partyIds, condition } = action;

  if (!['release', 'restrict'].includes(type))
    return { error: `action.type must be "release" or "restrict" (got ${JSON.stringify(type)})` };
  if (!Array.isArray(docIds) || docIds.length === 0)
    return { error: 'action.docIds must be a non-empty array of document ids' };
  const unknownDocs = [...new Set(docIds)].filter((id) => !idx.docs.has(id));
  if (unknownDocs.length) return { error: `unknown document ids: ${unknownDocs.join(', ')}` };
  if (!['committed', 'all', 'specific'].includes(partyScope))
    return { error: `action.partyScope must be "committed", "all" or "specific" (got ${JSON.stringify(partyScope)})` };
  if (partyScope === 'specific') {
    if (!Array.isArray(partyIds) || partyIds.length === 0)
      return { error: 'action.partyIds is required when partyScope is "specific"' };
    const unknownParties = [...new Set(partyIds)].filter((id) => !idx.parties.has(id));
    if (unknownParties.length) return { error: `unknown party ids: ${unknownParties.join(', ')}` };
  } else if (partyIds !== undefined) {
    return { error: 'action.partyIds only applies when partyScope is "specific"' };
  }
  if (condition !== undefined && condition !== 'nda_signed')
    return { error: `action.condition must be "nda_signed" when present (got ${JSON.stringify(condition)})` };

  return {
    ok: true,
    action: {
      type,
      docIds: [...new Set(docIds)],
      partyScope,
      partyIds: partyScope === 'specific' ? [...new Set(partyIds)] : [],
      condition,
    },
  };
}
