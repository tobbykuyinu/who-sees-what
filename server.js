'use strict';

/**
 * server.js — boot. One command runs the whole demo:
 *   npm start   ->  API + frontend statics on http://localhost:3000
 */

import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.js';
import { createApp } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, 'public');

const store = createStore(DATA_DIR);
const app = express();

app.use(express.json({ limit: '256kb' }));

app.use('/api', createApp(store));

// Frontend statics (the frontend worker's build lands in public/) — the demo
// is one command, one server, one port.
app.use(express.static(PUBLIC_DIR));
const indexHtml = path.join(PUBLIC_DIR, 'index.html');
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  res.status(404).send('Frontend not built yet — the API is live under /api (try /api/deal).');
});

// JSON-first errors
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'internal error — see server log' });
});
app.use((req, res) => res.status(404).json({ error: `unknown route: ${req.method} ${req.path} — see /api/deal` }));

app.listen(PORT, () => {
  console.log(`NeoShare "who sees what?" — http://localhost:${PORT}`);
  console.log(`  API: /api/deal /api/access /api/preview /api/apply /api/log /api/chat`);
  console.log(`  data: ${DATA_DIR}  state: ${path.join(DATA_DIR, 'state')}`);
});
