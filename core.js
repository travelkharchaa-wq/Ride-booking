/* RideX core — Firebase, fares, geo, dispatch */
const admin = require('firebase-admin');
const geohash = require('ngeohash');
const crypto = require('crypto');

const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(svc),
  databaseURL: process.env.RIDEX_DB
});
const db = admin.database();

const COMMISSION = 0.18;
const LOCK_SEC = 180;
const OFFER_SEC = 20;
const STALE_MS = 60000;
const FATIGUE_HOURS = 12;
const SECRET = process.env.RIDEX_SECRET || 'change-me';

const CLASSES = {
  bike:   { base:20, incl:1.5, perKm:7,  perMin:1.0, min:25,  fee:3,  gst:0,    factor:0.78 },
  auto:   { base:30, incl:1.5, perKm:12, perMin:1.2, min:35,  fee:5,  gst:0,    factor:1.12 },
  mini:   { base:50, incl:2.0, perKm:15, perMin:1.5, min:60,  fee:9,  gst:0.05, factor:1.00 },
  prime:  { base:80, incl:2.0, perKm:20, perMin:2.0, min:100, fee:12, gst:0.05, factor:1.00 },
  parcel: { base:25, incl:1.5, perKm:8,  perMin:1.0, min:30,  fee:5,  gst:0.18, factor:0.78 }
};
const WAIT = { freeMin: 3, perMin: 2 };
const CANCEL = { graceSec: 120, fee: 25 };

function fareFor(cls, km, drivingMin, stops, surge) {
  const c = CLASSES[cls];
  const mins = drivingMin * c.factor;
  const billKm = Math.max(0, km - c.incl);
  const ride = Math.max(c.base + billKm * c.perKm + mins * c.perMin, c.min) * surge;
  const stopFee = (stops || 0) * (cls === 'bike' ? 8 : 15);
  const gst = Math.round((ride + stopFee + c.fee) * c.gst);
  return {
    cls, km: +km.toFixed(2), minutes: Math.round(mins), surge,
    ride: Math.round(ride), stopFee, platformFee: c.fee, gst,
    total: Math.round(ride + stopFee + c.fee + gst), paymentMode: 'cash'
  };
}

async function routeMetrics(points) {
  const coords = points.map(p => p.lng + ',' + p.lat).join(';');
  const res = await fetch('https://router.project-osrm.org/route/v1/driving/' +
                          coords + '?overview=false');
  if (!res.ok) throw new Error('routing unavailable');
  const j = await res.json();
  const r = j.routes && j.routes[0];
  if (!r) throw new Error('no route');
  return { km: r.distance / 1000, minutes: r.duration / 60 };
}

const rad = d => d * Math.PI / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const cellsAround = (lat, lng) => {
  const c = geohash.encode(lat, lng, 5);
  return [c, ...geohash.neighbors(c)];
};

const sign = q => {
  const body = JSON.stringify(q);
  return Buffer.from(body).toString('base64url') + '.' +
         crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
};
function verifyLock(token) {
  const parts = String(token).split('.');
  const body = Buffer.from(parts[0], 'base64url').toString();
  const good = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (parts[1] !== good) throw new Error('bad lock');
  const q = JSON.parse(body);
  if (Date.now() > q.exp) throw new Error('expired');
  return q;
}

/* Every disqualifier is evaluated here, at query time. Nothing depends on a
   background sweeper having run recently. */
async function candidates(pickup, cls) {
  const ids = new Set();
  await Promise.all(cellsAround(pickup.lat, pickup.lng).map(async c => {
    const s = await db.ref('geo/' + c).once('value');
    s.forEach(ch => ids.add(ch.key));
  }));

  const now = Date.now();
  const out = [];
  await Promise.all([...ids].map(async uid => {
    const [p, l] = await Promise.all([
      db.ref('drivers/' + uid).once('value'),
      db.ref('driverLoc/' + uid).once('value')
    ]);
    const prof = p.val(), loc = l.val();
    if (!prof || !loc) return;
    if (prof.status !== 'approved') return;
    if (loc.state !== 'idle') return;
    if (now - loc.ts > STALE_MS) return;
    if (prof.onlineSince && (now - prof.onlineSince) / 3600000 > FATIGUE_HOURS) return;
    if (prof.cls !== cls && !(cls === 'parcel' && prof.cls === 'bike')) return;
    const km = haversine(loc, pickup);
    if (km > 7) return;
    out.push({ uid, prof, km, score: km - ((prof.rating || 4.5) - 4) * 0.8 });
  }));
  return out.sort((a, b) => a.score - b.score);
}

/* Dispatch driven by requests instead of timers: whoever polls advances it. */
async function advance(rideId) {
  const ride = (await db.ref('rides/' + rideId).once('value')).val();
  if (!ride || ride.state !== 'searching') return ride;

  const now = Date.now();
  const cur = ride.currentOffer;
  if (cur && now < cur.expires) return ride;

  if (cur) {
    await db.ref().update({
      ['offers/' + cur.uid + '/' + cur.offerId]: null,
      ['rides/' + rideId + '/currentOffer']: null
    });
  }

  if (now - ride.createdAt > 4 * 60 * 1000) {
    await db.ref('rides/' + rideId).update({
      state: 'no_drivers',
      message: 'No partners accepted your request. Please try again in a few minutes.'
    });
    return (await db.ref('rides/' + rideId).once('value')).val();
  }

  const pool = await candidates(ride.points[0], ride.cls);
  const tried = ride.tried || {};
  let next = pool.find(c => !tried[c.uid]);
  if (!next) {
    if (!pool.length) return ride;
    await db.ref('rides/' + rideId + '/tried').remove();
    next = pool[0];
  }

  const offerId = db.ref('offers').push().key;
  const expires = now + OFFER_SEC * 1000;
  await db.ref().update({
    ['offers/' + next.uid + '/' + offerId]: {
      rideId, expires,
      pickup: ride.addr[0], drop: ride.addr[ride.addr.length - 1],
      km: ride.fare.km, pickupKm: +next.km.toFixed(1),
      earn: Math.round(ride.fare.total * (1 - COMMISSION)),
      collect: ride.fare.total, paymentMode: 'cash'
    },
    ['rides/' + rideId + '/tried/' + next.uid]: true,
    ['rides/' + rideId + '/currentOffer']: { uid: next.uid, offerId, expires }
  });
  return (await db.ref('rides/' + rideId).once('value')).val();
}

async function auth(req, res, next) {
  try {
    req.user = await admin.auth().verifyIdToken(
      (req.headers.authorization || '').replace('Bearer ', ''));
    next();
  } catch { res.status(401).json({ error: 'Please sign in again.' }); }
}
function adminOnly(req, res, next) {
  if (!req.user.admin) return res.status(403).json({ error: 'Not permitted.' });
  next();
}

module.exports = {
  admin, db, geohash, crypto,
  COMMISSION, LOCK_SEC, OFFER_SEC, STALE_MS, FATIGUE_HOURS,
  CLASSES, WAIT, CANCEL,
  fareFor, routeMetrics, haversine, candidates, advance,
  sign, verifyLock, auth, adminOnly
};
