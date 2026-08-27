/* RideX driver + admin routes */
const express = require('express');
const C = require('./core');
const router = express.Router();
const { db, admin, geohash, CLASSES, WAIT, COMMISSION, FATIGUE_HOURS } = C;

router.post('/driver/apply', C.auth, async (req, res) => {
  const uid = req.user.uid;
  if ((await db.ref('drivers/' + uid + '/status').once('value')).val() === 'approved')
    return res.json({ ok: true, status: 'approved' });

  const { name, cls, plate, model, licence } = req.body;
  await db.ref('drivers/' + uid).update({
    name: String(name || '').slice(0, 60),
    phone: req.user.phone_number || null,
    cls: CLASSES[cls] ? cls : 'mini',
    plate: String(plate || '').toUpperCase().slice(0, 15),
    model: String(model || '').slice(0, 40),
    licence: String(licence || '').slice(0, 25),
    status: 'pending', rating: 5.0, trips: 0, dues: 0,
    appliedAt: admin.database.ServerValue.TIMESTAMP
  });
  res.json({ ok: true, status: 'pending' });
});

/* Heartbeat. Stop calling it and the staleness check drops you from dispatch. */
router.post('/driver/beat', C.auth, async (req, res) => {
  const uid = req.user.uid;
  const prof = (await db.ref('drivers/' + uid).once('value')).val();
  if (!prof) return res.json({ status: 'none' });
  if (prof.status !== 'approved')
    return res.json({ status: prof.status, name: prof.name || null });

  const { lat, lng, online } = req.body;
  const now = Date.now();
  const activeId = (await db.ref('driverActive/' + uid).once('value')).val();
  const state = activeId ? 'busy' : (online ? 'idle' : 'offline');

  if (typeof lat === 'number' && typeof lng === 'number') {
    // precision 4 — must match core.js's cellsAround(), or a driver's
    // bucket key won't line up with what the matcher searches for
    const gh = geohash.encode(lat, lng, 4);
    const prev = (await db.ref('driverLoc/' + uid + '/gh').once('value')).val();
    const up = {};
    up['driverLoc/' + uid] = { lat, lng, gh, state, ts: now };
    if (prev && prev !== gh) up['geo/' + prev + '/' + uid] = null;
    up['geo/' + gh + '/' + uid] = state === 'idle' ? true : null;
    if (online && !prof.onlineSince) up['drivers/' + uid + '/onlineSince'] = now;
    if (!online) up['drivers/' + uid + '/onlineSince'] = null;
    await db.ref().update(up);
  }

  let offer = null;
  const offers = (await db.ref('offers/' + uid).once('value')).val() || {};
  for (const id of Object.keys(offers)) {
    if (offers[id].expires > now) { offer = Object.assign({ id }, offers[id]); break; }
    await db.ref('offers/' + uid + '/' + id).remove();
  }

  let ride = null;
  if (activeId) {
    const r = (await db.ref('rides/' + activeId).once('value')).val();
    if (r && r.state !== 'completed' && !String(r.state).startsWith('cancelled')) {
      ride = {
        id: activeId, state: r.state, pickup: r.addr[0],
        drop: r.addr[r.addr.length - 1], riderName: r.riderName,
        riderPhone: r.riderPhone,
        // coordinates so the driver app can hand off to a navigation app
        pickupLat: r.points[0].lat, pickupLng: r.points[0].lng,
        dropLat: r.points[r.points.length - 1].lat,
        dropLng: r.points[r.points.length - 1].lng,
        fare: r.fare.total + (r.boost || 0),
        earn: Math.round((r.fare.total + (r.boost || 0)) * (1 - COMMISSION)),
        waitCharge: r.waitCharge || 0, arrivedAt: r.arrivedAt || null
      };
    } else {
      await db.ref('driverActive/' + uid).remove();
    }
  }

  const hours = prof.onlineSince ? (now - prof.onlineSince) / 3600000 : 0;
  res.json({
    status: 'approved', name: prof.name, cls: prof.cls, plate: prof.plate,
    trips: prof.trips || 0, dues: prof.dues || 0, rating: prof.rating || 5,
    hoursOnline: +hours.toFixed(2), fatigueLocked: hours > FATIGUE_HOURS,
    offer, ride
  });
});

router.post('/offer/accept', C.auth, async (req, res) => {
  const { rideId, offerId } = req.body;
  const uid = req.user.uid;
  const prof = (await db.ref('drivers/' + uid).once('value')).val();
  if (!prof || prof.status !== 'approved')
    return res.status(403).json({ error: 'Your account is not approved yet.' });

  /* Validate the offer with a plain read first. */
  const ride = (await db.ref('rides/' + rideId).once('value')).val();
  if (!ride) return res.status(404).json({ error: 'That ride no longer exists.' });
  if (ride.state !== 'searching')
    return res.status(409).json({ error: 'That request went to another partner.' });

  const cur = ride.currentOffer;
  if (!cur || cur.uid !== uid || cur.offerId !== offerId)
    return res.status(409).json({ error: 'That request went to another partner.' });
  // small grace window so a tap at 1s left isn't lost to network latency
  if (Date.now() > cur.expires + 8000)
    return res.status(409).json({ error: 'That request expired.' });

  /* Atomic claim on driverUid rather than on currentOffer.
     A Firebase transaction can run its check once with null before server
     data arrives; the previous version treated that null as "already taken"
     and aborted, so accepting failed every time even with a single driver
     online. Here null means "unclaimed", which is exactly the case we want
     to succeed, while a non-null value still correctly blocks a second
     driver from claiming the same ride. */
  const claim = await db.ref('rides/' + rideId + '/driverUid')
    .transaction(existing => (existing ? undefined : uid));

  if (!claim.committed || claim.snapshot.val() !== uid)
    return res.status(409).json({ error: 'That request went to another partner.' });

  await db.ref().update({
    ['rides/' + rideId + '/state']: 'assigned',
    ['rides/' + rideId + '/driver']: {
      name: prof.name, rating: prof.rating || 5, plate: prof.plate,
      model: prof.model, phone: prof.phone || null
    },
    ['rides/' + rideId + '/assignedAt']: Date.now(),
    ['rides/' + rideId + '/currentOffer']: null,
    ['driverRides/' + uid + '/' + rideId]: true,
    ['driverActive/' + uid]: rideId,
    ['offers/' + uid + '/' + offerId]: null,
    ['driverLoc/' + uid + '/state']: 'busy'
  });
  res.json({ ok: true });
});

router.post('/offer/pass', C.auth, async (req, res) => {
  const { rideId, offerId } = req.body;
  await db.ref().update({
    ['offers/' + req.user.uid + '/' + offerId]: null,
    ['rides/' + rideId + '/currentOffer']: null
  });
  await C.advance(rideId);
  res.json({ ok: true });
});

router.post('/ride/arrived', C.auth, async (req, res) => {
  const ride = (await db.ref('rides/' + req.body.rideId).once('value')).val();
  if (!ride || ride.driverUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });
  await db.ref('rides/' + req.body.rideId).update({ state: 'arrived', arrivedAt: Date.now() });
  res.json({ ok: true });
});

router.post('/ride/start', C.auth, async (req, res) => {
  const { rideId, otp } = req.body;
  const ride = (await db.ref('rides/' + rideId).once('value')).val();
  if (!ride || ride.driverUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });
  if (ride.state !== 'arrived')
    return res.status(409).json({ error: 'Mark yourself as arrived first.' });

  const tries = (ride.otpTries || 0) + 1;
  if (String(ride.otp) !== String(otp)) {
    await db.ref('rides/' + rideId).update({ otpTries: tries });
    if (tries >= 5) return res.status(429).json({ error: 'Too many wrong attempts. Contact support.' });
    return res.status(400).json({ error: 'Wrong OTP. Ask the rider to read it again.' });
  }

  const waitMin = (Date.now() - ride.arrivedAt) / 60000;
  await db.ref('rides/' + rideId).update({
    state: 'ontrip', startedAt: Date.now(),
    waitCharge: Math.max(0, Math.round((waitMin - WAIT.freeMin) * WAIT.perMin))
  });
  res.json({ ok: true });
});

router.post('/ride/complete', C.auth, async (req, res) => {
  const ride = (await db.ref('rides/' + req.body.rideId).once('value')).val();
  if (!ride || ride.driverUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });

  // include any rider-added boost, or the driver would be short-changed
  const collected = ride.fare.total + (ride.waitCharge || 0) + (ride.boost || 0);
  const commission = Math.round(collected * COMMISSION);
  const uid = req.user.uid;

  await db.ref().update({
    ['rides/' + req.body.rideId + '/state']: 'completed',
    ['rides/' + req.body.rideId + '/endedAt']: Date.now(),
    ['rides/' + req.body.rideId + '/collected']: collected,
    ['rides/' + req.body.rideId + '/commission']: commission,
    ['drivers/' + uid + '/dues']: admin.database.ServerValue.increment(commission),
    ['drivers/' + uid + '/trips']: admin.database.ServerValue.increment(1),
    ['ledger/' + uid + '/' + req.body.rideId]: { collected, commission, at: Date.now() },
    ['driverLoc/' + uid + '/state']: 'idle',
    ['driverActive/' + uid]: null,
    ['riderActive/' + ride.riderUid]: null
  });
  res.json({ ok: true, collect: collected, yourShare: collected - commission, commission });
});

router.post('/ride/driver-cancel', C.auth, async (req, res) => {
  const { rideId, reason } = req.body;
  const uid = req.user.uid;
  await db.ref().update({
    ['rides/' + rideId + '/state']: 'searching',
    ['rides/' + rideId + '/driverUid']: null,
    ['rides/' + rideId + '/driver']: null,
    ['rides/' + rideId + '/currentOffer']: null,
    ['driverLoc/' + uid + '/state']: 'idle',
    ['driverActive/' + uid]: null,
    ['drivers/' + uid + '/cancelCount']: admin.database.ServerValue.increment(1)
  });
  await C.advance(rideId);
  res.json({ ok: true });
});

/* ── admin ── */

/* One-time bootstrap so granting admin never needs a terminal.
   Accepts either ?phone=+9198... (looked up by phone) or ?uid=... (looked up
   directly — copy the UID from Firebase Console > Authentication > Users if
   the phone lookup ever mismatches, which is more reliable than a phone
   number string that has to match exactly). */
router.get('/admin/bootstrap', async (req, res) => {
  const want = process.env.RIDEX_BOOTSTRAP;
  if (!want) return res.status(410).json({ error: 'Bootstrap is closed.' });
  if (req.query.secret !== want) return res.status(403).json({ error: 'Wrong secret.' });
  try {
    let u;
    if (req.query.uid) {
      u = await admin.auth().getUser(req.query.uid);
    } else if (req.query.phone) {
      u = await admin.auth().getUserByPhoneNumber(req.query.phone);
    } else {
      return res.status(400).json({ error: 'Add ?phone=+9198... or ?uid=...' });
    }
    await admin.auth().setCustomUserClaims(u.uid, { admin: true });
    res.json({ ok: true, uid: u.uid, phone: u.phoneNumber || null,
      note: 'Sign out and back in, then delete RIDEX_BOOTSTRAP.' });
  } catch (e) {
    res.status(404).json({ error: 'No matching account (' + e.code + '). Check the value, or sign in to the app first.' });
  }
});

router.get('/admin/drivers', C.auth, C.adminOnly, async (req, res) => {
  const s = await db.ref('drivers').once('value');
  const out = [];
  s.forEach(c => out.push(Object.assign({ uid: c.key }, c.val())));
  res.json(out.sort((a, b) => (b.appliedAt || 0) - (a.appliedAt || 0)));
});

router.post('/admin/driver/status', C.auth, C.adminOnly, async (req, res) => {
  const { uid, status } = req.body;
  if (!['approved', 'pending', 'suspended'].includes(status))
    return res.status(400).json({ error: 'Unknown status.' });
  const up = {};
  up['drivers/' + uid + '/status'] = status;
  up['drivers/' + uid + '/reviewedAt'] = Date.now();
  if (status !== 'approved') {
    const gh = (await db.ref('driverLoc/' + uid + '/gh').once('value')).val();
    if (gh) up['geo/' + gh + '/' + uid] = null;
  }
  await db.ref().update(up);
  res.json({ ok: true });
});

router.post('/admin/driver/settle', C.auth, C.adminOnly, async (req, res) => {
  const up = {};
  up['drivers/' + req.body.uid + '/dues'] =
    admin.database.ServerValue.increment(-Math.abs(req.body.amount));
  up['settlements/' + req.body.uid + '/' + Date.now()] =
    { amount: req.body.amount, by: req.user.uid };
  await db.ref().update(up);
  res.json({ ok: true });
});

router.get('/admin/live', C.auth, C.adminOnly, async (req, res) => {
  const [rides, sos] = await Promise.all([
    db.ref('rides').orderByChild('createdAt').startAt(Date.now() - 6*3600*1000).once('value'),
    db.ref('sos').orderByChild('at').startAt(Date.now() - 24*3600*1000).once('value')
  ]);
  const active = [], alerts = [];
  rides.forEach(c => {
    const r = c.val();
    if (r.state !== 'completed' && !String(r.state).startsWith('cancelled'))
      active.push({ id: c.key, state: r.state, rider: r.riderName,
        driver: r.driver ? r.driver.name : null,
        from: r.addr && r.addr[0], to: r.addr && r.addr[r.addr.length - 1],
        fare: r.fare && r.fare.total });
  });
  sos.forEach(c => alerts.push(Object.assign({ id: c.key }, c.val())));
  res.json({ active, alerts });
});

module.exports = router;
