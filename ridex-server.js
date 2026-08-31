/* RideX API — entry point */
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: (process.env.RIDEX_ORIGINS || '*').split(',') }));

/* Every response is explicitly marked as never cacheable. Without this, a GET
   endpoint (driver list, ride status, the live map) can be served stale by
   any layer sitting between the browser and this server — a mobile carrier's
   transparent proxy, a CDN edge, or even the browser's own HTTP cache — since
   none of those need permission to cache a response that doesn't forbid it.
   The symptom is exactly what showed up here: new data existed in Firebase,
   but every poll, including a raw fetch() run directly in devtools, kept
   returning an old snapshot because they were all hitting the same cached
   copy rather than this server. */
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

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
