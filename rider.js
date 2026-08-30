/* RideX rider routes */
const express = require('express');
const C = require('./core');
const router = express.Router();
const { db, admin, crypto, CLASSES, CANCEL, LOCK_SEC } = C;

const TERMS_VERSION = '1.0';

function cleanStr(v, max){ return String(v == null ? '' : v).trim().slice(0, max); }

router.post('/rider/profile', C.auth, async (req, res) => {
  const uid = req.user.uid;
  const existing = (await db.ref('riders/' + uid).once('value')).val() || {};

  /* Terms are required on first save only — editing your name later should
     not ask you to accept them again. Acceptance is recorded with the version
     and a server timestamp, since a client-side checkbox proves nothing. */
  if (!existing.termsAcceptedAt && req.body.acceptedTerms !== true)
    return res.status(400).json({ error: 'Please accept the terms to continue.' });

  const name = cleanStr(req.body.name, 60);
  if (name.length < 2) return res.status(400).json({ error: 'Please enter your name.' });

  const gender = ['male', 'female', 'other', 'prefer_not_to_say', ''].includes(req.body.gender)
    ? req.body.gender : '';

  const up = {
    name,
    phone: req.user.phone_number || null,
    email: cleanStr(req.body.email, 120),
    gender,
    dob: cleanStr(req.body.dob, 10),                    // YYYY-MM-DD
    emergencyName: cleanStr(req.body.emergencyName, 60),
    emergencyPhone: cleanStr(req.body.emergencyPhone, 20),
    updatedAt: admin.database.ServerValue.TIMESTAMP
  };
  if (!existing.createdAt) up.createdAt = admin.database.ServerValue.TIMESTAMP;
  if (!existing.termsAcceptedAt) {
    up.termsVersion = TERMS_VERSION;
    up.termsAcceptedAt = admin.database.ServerValue.TIMESTAMP;
  }

  await db.ref('riders/' + uid).update(up);
  res.json({ ok: true });
});

router.post('/quote', C.auth, async (req, res) => {
  const points = req.body.points;
  if (!Array.isArray(points) || points.length < 2)
    return res.status(400).json({ error: 'Add a pickup and a drop.' });

  let m;
  try { m = await C.routeMetrics(points); }
  catch { return res.status(503).json({ error: 'Routing is unavailable. Try again in a moment.' }); }

  const quotes = {};
  for (const cls of Object.keys(CLASSES)) {
    const pool = await C.candidates(points[0], cls);
    const surge = pool.length >= 3 ? 1 : pool.length === 2 ? 1.1 : pool.length === 1 ? 1.2 : 1.25;
    quotes[cls] = C.fareFor(cls, m.km, m.minutes, points.length - 2, surge);
    quotes[cls].eta = pool.length ? Math.max(1, Math.round(pool[0].km / 0.35)) : null;
  }
  res.json({ km: m.km, minutes: m.minutes, surge: 1, quotes, lockSeconds: LOCK_SEC });
});

router.post('/quote/lock', C.auth, async (req, res) => {
  const { points, cls } = req.body;
  if (!CLASSES[cls]) return res.status(400).json({ error: 'Unknown vehicle type.' });
  let m;
  try { m = await C.routeMetrics(points); }
  catch { return res.status(503).json({ error: 'Routing is unavailable right now.' }); }

  const pool = await C.candidates(points[0], cls);
  const surge = pool.length >= 3 ? 1 : pool.length === 2 ? 1.1 : pool.length === 1 ? 1.2 : 1.25;
  const q = C.fareFor(cls, m.km, m.minutes, points.length - 2, surge);
  q.exp = Date.now() + LOCK_SEC * 1000;
  q.uid = req.user.uid;
  res.json({ fare: q, lock: C.sign(q), expiresAt: q.exp });
});

router.post('/ride/create', C.auth, async (req, res) => {
  const { points, addr, cls, lock } = req.body;
  let fare;
  try { fare = C.verifyLock(lock); }
  catch { return res.status(409).json({ error: 'That fare expired. Please get a fresh quote.' }); }
  if (fare.uid !== req.user.uid)
    return res.status(403).json({ error: 'That fare belongs to another account.' });

  /* Self-healing: a stale 'riderActive' pointer (from a ride that ended in a
     dead-end state, or was abandoned) must not lock someone out of booking
     forever. Only a genuinely live ride blocks a new one. */
  const openId = (await db.ref('riderActive/' + req.user.uid).once('value')).val();
  if (openId) {
    const open = (await db.ref('rides/' + openId).once('value')).val();
    const LIVE = ['searching', 'assigned', 'arrived', 'ontrip'];
    const stale = !open
      || !LIVE.includes(open.state)
      || (Date.now() - (open.createdAt || 0) > 2 * 60 * 60 * 1000);
    if (stale) await db.ref('riderActive/' + req.user.uid).remove();
    else return res.status(409).json({ error: 'You already have a ride in progress.' });
  }

  const rider = (await db.ref('riders/' + req.user.uid).once('value')).val() || {};
  const rideId = db.ref('rides').push().key;

  await db.ref().update({
    ['rides/' + rideId]: {
      id: rideId, riderUid: req.user.uid,
      riderName: rider.name || 'Rider',
      riderPhone: req.user.phone_number || null,
      cls, points, addr, fare, paymentMode: 'cash',
      otp: 1000 + crypto.randomInt(9000),
      state: 'searching', createdAt: Date.now(), tried: {}
    },
    ['riderRides/' + req.user.uid + '/' + rideId]: true,
    ['riderActive/' + req.user.uid]: rideId
  });

  const ride = await C.advance(rideId);
  res.json({ rideId, otp: ride.otp, state: ride.state });
});

/* Rider polls this, and this is what moves dispatch forward. */
router.get('/ride/:id/status', C.auth, async (req, res) => {
  const ride = await C.advance(req.params.id);
  if (!ride) return res.status(404).json({ error: 'Ride not found.' });
  if (ride.riderUid !== req.user.uid && ride.driverUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });

  let driverLoc = null;
  if (ride.driverUid) {
    const l = (await db.ref('driverLoc/' + ride.driverUid).once('value')).val();
    if (l) driverLoc = { lat: l.lat, lng: l.lng, ts: l.ts };
  }
  res.json({
    state: ride.state, message: ride.message || null,
    otp: ride.otp, fare: ride.fare, waitCharge: ride.waitCharge || 0,
    boost: ride.boost || 0,
    driver: ride.driver || null, driverLoc
  });
});

router.post('/ride/cancel', C.auth, async (req, res) => {
  const ride = (await db.ref('rides/' + req.body.rideId).once('value')).val();
  if (!ride || ride.riderUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });

  const fee = ride.assignedAt && (Date.now() - ride.assignedAt) > CANCEL.graceSec * 1000
    ? CANCEL.fee : 0;
  const up = {
    ['rides/' + req.body.rideId + '/state']: 'cancelled_rider',
    ['rides/' + req.body.rideId + '/cancelFee']: fee,
    ['riderActive/' + req.user.uid]: null
  };
  if (ride.currentOffer)
    up['offers/' + ride.currentOffer.uid + '/' + ride.currentOffer.offerId] = null;
  if (ride.driverUid) {
    up['driverLoc/' + ride.driverUid + '/state'] = 'idle';
    up['driverActive/' + ride.driverUid] = null;
  }
  await db.ref().update(up);
  res.json({ ok: true, fee });
});

router.post('/ride/sos', C.auth, async (req, res) => {
  const ride = (await db.ref('rides/' + req.body.rideId).once('value')).val();
  await db.ref('sos').push({
    rideId: req.body.rideId, raisedBy: req.user.uid,
    lat: req.body.lat || null, lng: req.body.lng || null, at: Date.now(),
    riderPhone: ride && ride.riderPhone || null,
    driverPhone: ride && ride.driver && ride.driver.phone || null,
    plate: ride && ride.driver && ride.driver.plate || null,
    state: 'open'
  });
  res.json({ ok: true });
});

router.post('/ride/share', C.auth, async (req, res) => {
  const token = crypto.randomBytes(9).toString('base64url');
  await db.ref('share/' + token).set({
    rideId: req.body.rideId, exp: Date.now() + 6 * 3600 * 1000
  });
  res.json({ url: (process.env.RIDEX_WEB || '') + '/t/?k=' + token });
});

/* Account screen: profile plus recent trips. */
router.get('/rider/me', C.auth, async (req, res) => {
  const uid = req.user.uid;
  const [profSnap, idsSnap] = await Promise.all([
    db.ref('riders/' + uid).once('value'),
    db.ref('riderRides/' + uid).limitToLast(30).once('value')
  ]);

  const ids = [];
  idsSnap.forEach(c => ids.push(c.key));

  const rides = [];
  await Promise.all(ids.map(async id => {
    const r = (await db.ref('rides/' + id).once('value')).val();
    if (!r) return;
    rides.push({
      id,
      state: r.state,
      at: r.createdAt || 0,
      from: r.addr && r.addr[0] || '',
      to: r.addr && r.addr[r.addr.length - 1] || '',
      cls: r.cls,
      fare: r.collected || (r.fare && r.fare.total) || 0,
      driver: r.driver ? r.driver.name : null
    });
  }));

  rides.sort((a, b) => b.at - a.at);
  const prof = profSnap.val() || {};
  const done = rides.filter(r => r.state === 'completed');
  res.json({
    name: prof.name || null,
    phone: req.user.phone_number || null,
    email: prof.email || '',
    gender: prof.gender || '',
    dob: prof.dob || '',
    emergencyName: prof.emergencyName || '',
    emergencyPhone: prof.emergencyPhone || '',
    memberSince: prof.createdAt || null,
    totalTrips: done.length,
    totalSpent: done.reduce((s, r) => s + (r.fare || 0), 0),
    rides: rides.slice(0, 20)
  });
});

/* How many drivers of a given class are free near a pickup point, and roughly
   where. Coordinates are rounded to ~100 m — riders need to see that supply
   exists, not to track individual drivers before a trip has been booked. */
router.get('/nearby', C.auth, async (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const cls = req.query.cls;
  if (!isFinite(lat) || !isFinite(lng) || !CLASSES[cls])
    return res.status(400).json({ error: 'Bad request.' });

  const pool = await C.candidates({ lat, lng }, cls);
  res.json({
    count: pool.length,
    drivers: pool.slice(0, 12).map(d => ({
      lat: Math.round(d.loc.lat * 1000) / 1000,
      lng: Math.round(d.loc.lng * 1000) / 1000
    }))
  });
});

/* Voluntary fare increase while searching. Only ever upward, capped, and only
   while no driver has accepted — so it can't be used to alter an agreed fare. */
router.post('/ride/boost', C.auth, async (req, res) => {
  const { rideId, extra } = req.body;
  const add = Math.round(Number(extra));
  if (!Number.isFinite(add) || add <= 0)
    return res.status(400).json({ error: 'Enter a valid amount.' });

  const ride = (await db.ref('rides/' + rideId).once('value')).val();
  if (!ride || ride.riderUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });
  if (ride.state !== 'searching')
    return res.status(409).json({ error: 'This ride is no longer searching.' });

  const current = ride.boost || 0;
  const next = current + add;
  const cap = Math.max(150, Math.round(ride.fare.total));   // never more than double-ish
  if (next > cap)
    return res.status(400).json({ error: 'You have reached the maximum extra amount.' });

  const up = { ['rides/' + rideId + '/boost']: next };
  // retire the standing offer so the next driver immediately sees the new amount
  if (ride.currentOffer) {
    up['offers/' + ride.currentOffer.uid + '/' + ride.currentOffer.offerId] = null;
    up['rides/' + rideId + '/currentOffer'] = null;
  }
  await db.ref().update(up);
  await C.advance(rideId);

  res.json({ ok: true, boost: next, payable: ride.fare.total + next });
});

module.exports = router;
