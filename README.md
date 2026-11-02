# NeoShare — "Who sees what?" · backend

The arranging bank's analyst controls who sees what in a syndicated-loan data
room, where access changes over time and **a mistake is a serious incident
that can't be undone**. This repo is the backend slice of the take-home: the
permission engine, the simulation (preview) layer, the change log, and the
conversation layer — the whole "understanding layer" on top of NeoShare's
existing permission model.

## The one decision to defend

**We did not build more permission rules — we made the dangerous thing
visible.** The bank already has a permission model (the two mock JSONs);
adding rules would not make the analyst faster or safer. Instead, every
screen and every answer in this system is computed by *one engine* that
always answers three questions at once: **what is visible now, what would a
change do, and why is each exclusion there.** The safe path is the lazy
path: dropouts, the borrower, side letters and NDA-gated parties are
excluded by default, and every release preview states those exclusions
automatically — before anything applies.

## Run it

```bash
npm install
npm start          # http://localhost:3000 — API + frontend statics (public/)
npm test           # 25 tests: engine rules, acceptance stories, full HTTP surface
```

The frontend worker's build lands in `public/`; the server serves it, so the
demo is one command, one server, one port. State (overlay + change log)
persists under `data/state/` — a restart never loses history.

## API

| Endpoint | Purpose |
|---|---|
| `GET  /api/deal` | Parties, documents (+ permanent flags like `borrowerExcluded`), states |
| `GET  /api/access` | The matrix: every party × every doc, with a **reason for every exclusion** + pending grants |
| `POST /api/preview` | Simulate `{action}` → `{granted, revoked, excluded, warnings}` — never mutates |
| `POST /api/apply` | Same body → applies, re-computes server-side, logs `{ts, actor, actionSummary, affectedParties[], docs[]}` |
| `GET  /api/log` | The change log — it answers history questions ("what does Fjord know?") |
| `POST /api/chat` | The conversation panel: `{text, conversationId?}` → decision-draft / answer / clarification |

Actions: `{action: {type: "release"|"restrict", docIds[], partyScope: "committed"|"all"|"specific", partyIds[], condition?: "nda_signed"}}`.
Attribution: pass an `X-Actor` header; log entries carry it.

## The permission engine (rules encoded from `data/permissions.json`)

- **Tiering (teaser → NDA → commitment):** `public` → invited+ · `confidential` → NDA-signed+ · `strictly_confidential` → committed. `committed` scope includes NDA-signed parties (story 1: Alpenland gets the valuation).
- **NDA gate:** invited parties never see gated docs. A grant with `condition: "nda_signed"` becomes a *pending* grant: visible in the matrix as pending, takes effect on signature (story 3).
- **Party-scoped documents** (`bank_specific`): side letters, fee/commitment letters, signed NDAs — only the concerned party and the case owner. A broad release that includes one warns loudly and grants nothing beyond scope (story 2).
- **Dropout freeze:** declined parties see nothing, are never granted anything new, and are stated as excluded in *every* release preview (story 4).
- **Borrower exclusions:** lender legal documents (facility drafts, term sheets, intercreditor…) and lender valuation documents are permanently hidden from the borrower — a standing flag on those docs and a warning in every preview (story 5).
- **Case owner sees everything** (`owner_sees_all`) — nothing revokes it; **uploaders retain their own documents** under a restrict.
- **New version → notify:** superseded→current version chains are detected from the data (name-token similarity within folder+category); releasing a new version surfaces exactly who saw the old one and must be notified.

## The conversation layer (`/api/chat`)

"**AI drafts the decision; the preview approves it.**" The analyst types
intent in plain language and gets back one of three reply kinds:

- **`decision-draft`** — the parsed `{action}` plus the full impact preview
  inline, ready for the Apply button. Follow-ups refine the draft in place
  (`"exclude Alpenland too"` re-drafts with the updated party scope).
- **`answer`** — permission questions answered in terms + reasons:
  *"what can Fjord see?" · "can the borrower see the legal draft?" ·
  "who sees Elbmarsch's side letter?" · "what changed this week?"*
- **`clarification`** — when intent is ambiguous ("which document — the
  valuation or the rent roll?"), with selectable options.

**Honesty note:** this layer is a deterministic keyword parser over the mock
data today, by design — no LLM calls in the take-home. In production this
layer is LLM-backed with the **same contract** (text → `{kind, draft |
answer | clarification}`); the permission engine below it does not change.
Conversation memory is minimal per spec (current draft + last topic per
`conversationId`, in-process).

An optional LLM fallback catches free-form intents the parser misses (set
`ANTHROPIC_AUTH_TOKEN`, optionally `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL`).
Its prompt is **draft-first** (release/share/send intents always become a
decision-draft, never a clarification), carries the real parties, documents
**and pending actions**, and any clarification it does ask for comes with
options that are full actionable phrasings. Model drafts are validated and
re-computed through the same deterministic engine; hallucinated ids are
dropped. Without the key, the server runs entirely on the deterministic
layer.

The change log opens with the deal's history seeded (Q&A release, rent-roll
release, land-register update, Fjord's dropout, Alpenland's NDA) — seeded
only into a fresh state dir, so restarts never duplicate it.

## Structure

```
server.js          boot: JSON-first errors, /api router, public/ statics (port 3000)
src/engine.js      the permission engine — pure, IO-free (index, visibility,
                   preview, apply, matrix, human reasons)
src/seed-state.js  t0 release state: the updated valuation (d-038) is held
src/store.js       the only module that touches disk; persists overlay + log
src/validate.js    strict, human-readable action validation
src/chat.js        the conversation layer over the engine
src/routes.js      thin HTTP surface — validates, delegates, responds
test/              node:test suites (no extra deps): engine rules +
                   acceptance stories + full HTTP surface incl. warnings
data/              the two mock JSONs, copied verbatim as seed data
```

## Demo script (the four moments)

1. `release the new valuation to everyone committed` → draft: 6 parties gain
   (Alpenland included), Mainufer + Fjord + borrower stated as excluded,
   "8 parties who saw the previous version will be notified". **Apply** → logged.
2. `who sees Elbmarsch's side letter?` → answer: only Elbmarsch + Nordwall.
3. `grant Mainufer room access once the NDA is signed` → draft: the 36-doc
   NDA package as a pending grant. **Apply** → logged, matrix shows ⏳ pending.
4. `what can Fjord see?` → answer: nothing — dropped out, frozen, with the
   historical note. `exclude Alpenland too` on the valuation draft → re-draft.
