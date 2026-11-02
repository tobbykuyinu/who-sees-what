# Who sees what? — Submission note

## My understanding of the problem

An arranging bank runs the data room for a syndicated financing. The analyst controls who sees what, and that answer changes constantly: banks move from teaser to NDA to commitment, side letters stay private to one bank, banks that drop out must see nothing new, updated documents must reach everyone with access, and the borrower must never see the interbank drafts. One wrong disclosure is a serious incident and it cannot be undone. Today this is held together with emails, a large Excel matrix, and anxiety. The tooling stores permissions but does not help the analyst stay confident about them under time pressure. My answer is a control surface above the permission model: the access state always visible, every change previewed before it applies, and the change log answering history questions like "what does Fjord know".

## Assumptions I made

1. The provided permission model is correct. I built on it unchanged. The product is the layer above it.
2. The analyst is the only actor who applies changes; participating banks only view.
3. The week's scenarios from the brief (valuation update, side letter, NDA transition, dropout, borrower exclusion) define the scope.
4. Document processing (search, extraction) exists and works. Mocked, as the brief allows.
5. The intent layer is rule-based in this prototype. An LLM belongs there in production, behind the same deterministic gate.
6. The interface works at two granularities: the matrix reasons about document groups (the room's folder structure) and the conversation reasons about individual documents. Releases act on files and the matrix aggregates. The group view gives the at-a-glance state, the file view gives precision; mixing them on one surface would make both worse.

## What I deliberately left out

Bulk document import. Multi-deal navigation. Full audit export. Notification delivery itself (the change log records who must be notified; delivery is a channel concern). Real-time collaboration. The participating-bank view (I focused on the analyst, who owns the risk). Authentication. i18n beyond the provided mock data.

## My next step

1. Replace the rule-based intent parser with an LLM, keeping the deterministic preview and apply gate untouched.
2. Notification delivery driven by the change log.
3. The participating-bank view as the counterpart experience.
4. A per-party document timeline: what did Fjord see, and when.
