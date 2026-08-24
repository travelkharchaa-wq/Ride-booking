/* RideX rider routes */
const express = require('express');
const C = require('./core');
const router = express.Router();
const { db, admin, crypto, CLASSES, CANCEL, LOCK_SEC } = C;

router.post('/rider/profile', C.auth, async (req, res) => {
  await db.ref('riders/' + req.user.uid).update({
    name: String(req.body.name || '').slice(0, 60),
    phone: req.user.phone_number || null,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
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

  if ((await db.ref('riderActive/' + req.user.uid).once('value')).val())
    return res.status(409).json({ error: 'You already have a ride in progress.' });

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

module.exports = router;
