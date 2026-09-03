/* RideX driver + admin routes */
const express = require('express');
const C = require('./core');
const router = express.Router();
const { db, admin, geohash, CLASSES, WAIT, COMMISSION, FATIGUE_HOURS, STALE_MS } = C;

/* Documents are stored as compressed base64 in the Realtime Database rather
   than Firebase Storage, which now requires a paid plan. This is fine for a
   pilot with a handful of drivers; past a few hundred it should move to
   object storage, since RTDB is not built to hold binary blobs. */
const MAX_DOC = 700 * 1024;   // ~700 KB of base64 per document

function checkDoc(d, label) {
  if (!d || typeof d !== 'string' || !d.startsWith('data:'))
    return label + ' is required.';
  if (d.length > MAX_DOC)
    return label + ' is too large. Please use a smaller photo.';
  const mime = d.slice(5, d.indexOf(';'));
  if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime))
    return label + ' must be a photo or a PDF.';
  return null;
}

router.post('/driver/apply', C.auth, async (req, res) => {
  const uid = req.user.uid;
  if ((await db.ref('drivers/' + uid + '/status').once('value')).val() === 'approved')
    return res.json({ ok: true, status: 'approved' });

  const { name, cls, plate, model, licence, licenceDoc, rcDoc, acceptedTerms } = req.body;

  /* Drivers must accept explicitly too — their obligations under the terms
     (valid licence, RC, insurance, permits) are the substantive ones. */
  if (acceptedTerms !== true)
    return res.status(400).json({ error: 'Please accept the terms to continue.' });

  // both documents are mandatory — an unverified driver must never reach a rider
  const e1 = checkDoc(licenceDoc, 'Driving licence');
  if (e1) return res.status(400).json({ error: e1 });
  const e2 = checkDoc(rcDoc, 'Vehicle RC');
  if (e2) return res.status(400).json({ error: e2 });

  await db.ref().update({
    ['drivers/' + uid]: {
      name: String(name || '').slice(0, 60),
      phone: req.user.phone_number || null,
      cls: CLASSES[cls] ? cls : 'mini',
      plate: String(plate || '').toUpperCase().slice(0, 15),
      model: String(model || '').slice(0, 40),
      licence: String(licence || '').slice(0, 25),
      status: 'pending', rating: 5.0, trips: 0, dues: 0,
      hasDocs: true,
      termsVersion: '1.0',
      termsAcceptedAt: admin.database.ServerValue.TIMESTAMP,
      appliedAt: admin.database.ServerValue.TIMESTAMP
    },
    ['driverDocs/' + uid]: {
      licenceDoc, rcDoc, at: admin.database.ServerValue.TIMESTAMP
    }
  });
  res.json({ ok: true, status: 'pending' });
});

/* Push token, so the driver can be reached when the app is closed. */
router.post('/driver/token', C.auth, async (req, res) => {
  const token = String(req.body.token || '').slice(0, 400);
  if (!token) return res.status(400).json({ error: 'Missing token.' });
  await db.ref('drivers/' + req.user.uid).update({
    fcmToken: token,
    fcmUpdatedAt: admin.database.ServerValue.TIMESTAMP
  });
  res.json({ ok: true });
});

/* Tells you which account you are actually signed in as, and whether it has
   admin. Useful when the console says "Not permitted" and you need the UID to
   add to adminUids — no bootstrap secret or deploy required. */
router.get('/whoami', C.auth, async (req, res) => {
  let inList = false;
  try {
    inList = (await db.ref('adminUids/' + req.user.uid).once('value')).val() === true;
  } catch (e) { /* reported as false */ }
  res.json({
    uid: req.user.uid,
    phone: req.user.phone_number || null,
    adminClaim: !!req.user.admin,
    adminInList: inList,
    isAdmin: !!req.user.admin || inList
  });
});

/* Support number is served only to signed-in users, so it never appears in
   the public page source or gets scraped from the site. */
router.get('/support', C.auth, async (req, res) => {
  res.json({ phone: process.env.RIDEX_SUPPORT_PHONE || null });
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
        earn: Math.round((r.fare.total + (r.boost || 0)) * (1 - COMMISSION)),
        arrivedAt: r.arrivedAt || null
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
    ['riderRides/' + ride.riderUid + '/' + rideId + '/state']: 'assigned',
    ['riderRides/' + ride.riderUid + '/' + rideId + '/driver']: prof.name || null,
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
    ['riderRides/' + ride.riderUid + '/' + req.body.rideId + '/state']: 'completed',
    ['riderRides/' + ride.riderUid + '/' + req.body.rideId + '/fare']: collected,
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

/* Drivers can no longer cancel from their own app — they call RideX instead,
   so a human decides whether the customer gets reassigned or the trip is
   called off. This is that lever. */
router.post('/admin/ride/cancel', C.auth, C.adminOnly, async (req, res) => {
  const { rideId, action, reason } = req.body;
  const ride = (await db.ref('rides/' + rideId).once('value')).val();
  if (!ride) return res.status(404).json({ error: 'Ride not found.' });

  const uid = ride.driverUid;
  const up = {
    ['rides/' + rideId + '/adminNote']: String(reason || '').slice(0, 200),
    ['rides/' + rideId + '/handledBy']: req.user.uid,
    ['rides/' + rideId + '/currentOffer']: null
  };
  if (uid) {
    up['driverLoc/' + uid + '/state'] = 'idle';
    up['driverActive/' + uid] = null;
    up['drivers/' + uid + '/cancelCount'] = admin.database.ServerValue.increment(1);
  }

  if (action === 'reassign') {
    // put it back into dispatch for another driver, fare unchanged
    up['rides/' + rideId + '/state'] = 'searching';
    up['rides/' + rideId + '/driverUid'] = null;
    up['rides/' + rideId + '/driver'] = null;
    await db.ref().update(up);
    await C.advance(rideId);
    return res.json({ ok: true, state: 'searching' });
  }

  up['rides/' + rideId + '/state'] = 'cancelled_driver';
  up['riderRides/' + ride.riderUid + '/' + rideId + '/state'] = 'cancelled_driver';
  up['riderActive/' + ride.riderUid] = null;
  await db.ref().update(up);
  res.json({ ok: true, state: 'cancelled_driver' });
});

/* Operations map: where every driver is, and where trips are happening.
   Rider positions are only included for rides actually in progress — the app
   does not track a customer's location when they are not on a trip, and it
   should not start doing so just to populate a dashboard. */
router.get('/admin/map', C.auth, C.adminOnly, async (req, res) => {
  const now = Date.now();
  const [locSnap, drvSnap, rideSnap] = await Promise.all([
    db.ref('driverLoc').once('value'),
    db.ref('drivers').once('value'),
    db.ref('rides').orderByChild('createdAt').startAt(now - 6 * 3600 * 1000).once('value')
  ]);

  const profs = drvSnap.val() || {};
  const drivers = [];
  locSnap.forEach(c => {
    const l = c.val() || {};
    const p = profs[c.key] || {};
    if (typeof l.lat !== 'number' || typeof l.lng !== 'number') return;
    const stale = now - (l.ts || 0) > STALE_MS;
    drivers.push({
      uid: c.key,
      name: p.name || 'Driver',
      plate: p.plate || '',
      cls: p.cls || 'mini',
      status: p.status || 'pending',
      // a driver whose heartbeat stopped is shown as offline, whatever the
      // last written state said — otherwise the map lies about availability
      state: stale ? 'offline' : (l.state || 'offline'),
      lat: l.lat, lng: l.lng,
      agoSec: Math.round((now - (l.ts || now)) / 1000)
    });
  });

  const trips = [];
  rideSnap.forEach(c => {
    const r = c.val();
    if (!['searching', 'assigned', 'arrived', 'ontrip'].includes(r.state)) return;
    if (!r.points || !r.points[0]) return;
    trips.push({
      id: c.key, state: r.state,
      rider: r.riderName || 'Rider',
      driver: r.driver ? r.driver.name : null,
      cls: r.cls,
      fare: r.fare ? r.fare.total : 0,
      from: r.addr && r.addr[0], to: r.addr && r.addr[r.addr.length - 1],
      lat: r.points[0].lat, lng: r.points[0].lng,
      dropLat: r.points[r.points.length - 1].lat,
      dropLng: r.points[r.points.length - 1].lng
    });
  });

  const counts = {
    online:  drivers.filter(d => d.state === 'idle').length,
    busy:    drivers.filter(d => d.state === 'busy').length,
    offline: drivers.filter(d => d.state === 'offline').length,
    approved: Object.values(profs).filter(p => p.status === 'approved').length,
    trips: trips.length
  };
  res.json({ drivers, trips, counts, at: now });
});

router.get('/admin/drivers', C.auth, C.adminOnly, async (req, res) => {
  const s = await db.ref('drivers').once('value');
  const out = [];
  /* Block body is required. Firebase stops enumerating as soon as the
     callback returns something truthy, and Array.push returns the new
     length — so an expression-bodied arrow silently returned only the first
     driver no matter how many existed. */
  s.forEach(c => { out.push(Object.assign({ uid: c.key }, c.val())); });
  console.log('[admin/drivers] snapshot children=' + s.numChildren() +
              ' collected=' + out.length);
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

/* Lets an admin actually look at the licence and RC before approving. */
router.get('/admin/driver/docs', C.auth, C.adminOnly, async (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.status(400).json({ error: 'Missing uid.' });
  const d = (await db.ref('driverDocs/' + uid).once('value')).val();
  if (!d) return res.status(404).json({ error: 'No documents on file for this driver.' });
  res.json(d);
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
  
