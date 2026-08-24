/* RideX API — entry point */
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: (process.env.RIDEX_ORIGINS || '*').split(',') }));
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_, res) => res.json({ ok: true, at: Date.now() }));

app.use(require('./rider'));
app.use(require('./driver'));

const port = process.env.PORT || 8090;
app.listen(port, () => console.log('RideX API listening on ' + port));
