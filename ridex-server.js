/* RideX API — entry point */
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: (process.env.RIDEX_ORIGINS || '*').split(',') }));
/* Driver licence and RC photos are sent as base64, roughly 650 KB each, so
   the default small-body limit would reject every application before the
   route even runs. Everything else on this API is tiny. */
app.use(express.json({ limit: '4mb' }));

app.get('/health', (_, res) => res.json({ ok: true, at: Date.now() }));

app.use(require('./rider'));
app.use(require('./driver'));

/* Express does not catch errors thrown inside async route handlers, so an
   unexpected value in one request used to reject unhandled and kill the whole
   process — dropping every rider and driver mid-trip while Render restarted.
   These guards turn that into a logged 500 for the one caller instead. */
app.use((err, req, res, next) => {
  console.error('Route error on ' + req.method + ' ' + req.path + ':', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

process.on('unhandledRejection', err => {
  console.error('Unhandled rejection (server kept alive):', err);
});
process.on('uncaughtException', err => {
  console.error('Uncaught exception (server kept alive):', err);
});

const port = process.env.PORT || 8090;
app.listen(port, () => console.log('RideX API listening on ' + port));
