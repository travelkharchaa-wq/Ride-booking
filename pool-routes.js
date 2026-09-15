/* RideX shared-ride routes.
 *
 * Flow:
 *   1. P2 books normally with shared:true, then calls POST /pool/find.
 *      If a moving shared trip fits (pool.js rules), dispatch for P2 pauses.
 *   2. P1 is asked:      GET /pool/ask/:rideId  →  POST /pool/respond
 *   3. Driver is asked:  GET /pool/driver       →  POST /pool/driver-respond
 *   4. Linked. P2 is picked up with the existing /ride/arrived and /ride/start
 *      (P2's own OTP). Drops go through /ride/complete, which this file
 *      intercepts for pooled rides so the order and fare split are enforced.
 *
 * This router must be mounted BEFORE rider.js and driver.js, because it
 * intercepts /ride/complete, /ride/cancel and /ride/driver-cancel. For any
 * ride that is not involved in pooling it calls next() and the original
 * handlers run exactly as before.
 */
const express = require('express');
const C = require('./core');
const Pool = require('./pool');
const router = express.Router();
const { db, admin, COMMISSION, CANCEL } = C;

const SEARCH_KM = 5;        // how far a moving driver may be from P2's pickup
const MAX_CHECKS = 4;       // routing calls per search, to spare the OSRM server

const ref = p => db.ref(p);
const val = async p => (await ref(p).once('value')).val();
const last = arr => arr[arr.length - 1];

/* Same public OSRM server core.js uses, but with the full route shape,
   because matching needs the road line and not just totals. */
async function route(points) {
  const coords = points.map(p => p.lng + ',' + p.lat).join(';');
  const res = await fetch('https://router.project-osrm.org/route/v1/driving/' +
                          coords + '?overview=full&geometries=geojson');
  if (!res.ok) throw new Error('routing unavailable');
  const j = await res.json();
  const r = j.routes && j.routes[0];
  if (!r) throw new Error('no route');
  return {
    km: r.distance / 1000,
    minutes: r.duration / 60,
    line: r.geometry.coordinates.map(c => ({ lat: c[1], lng: c[0] })),
    legs: r.legs.map(l => ({ km: l.distance / 1000, minutes: l.duration / 60 }))
  };
}

/* Undo a pending (not yet linked) pool request. P2 goes back to normal
   dispatch with a fresh search window, since time spent waiting on the pool
   answer should not count against their 4-minute search limit. */
async function releaseAsk(p1Id, ask) {
  const up = { ['rides/' + p1Id + '/poolAsk']: null };
  const p2 = ask && await val('rides/' + ask.p2RideId);
  if (p2 && p2.state === 'pool_pending' && p2.poolCandidate === p1Id) {
    up['rides/' + ask.p2RideId + '/state'] = 'searching';
    up['rides/' + ask.p2RideId + '/poolCandidate'] = null;
    up['rides/' + ask.p2RideId + '/createdAt'] = Date.now();
    up['riderRides/' + p2.riderUid + '/' + ask.p2RideId + '/state'] = 'searching';
  }
  await ref().update(up);
  if (p2) await C.advance(ask.p2RideId);
}

/* Lazily expires requests nobody answered. Called from every pool endpoint,
   the same request-driven approach core.js uses for dispatch. */
async function settle(p1Id) {
  const p1 = await val('rides/' + p1Id);
  const ask = p1 && p1.poolAsk;
  if (!ask) return p1;
  if (Date.now() < ask.expires) return p1;

  if (ask.stage === 'rider' && (ask.tries || 1) < Pool.OFFER_TRIES) {
    await ref('rides/' + p1Id + '/poolAsk').update({
      tries: (ask.tries || 1) + 1,
      expires: Date.now() + Pool.OFFER_SEC * 1000
    });
  } else {
    await releaseAsk(p1Id, ask);
  }
  return val('rides/' + p1Id);
}

function push(token, title, body) {
  if (!token) return;
  admin.messaging().send({
    token, data: { title, body },
    android: { priority: 'high' },
    webpush: { headers: { Urgency: 'high', TTL: String(Pool.OFFER_SEC) } }
  }).catch(err => console.warn('pool push failed:', err.code || err.message));
}

/* ── 1. P2 looks for a moving shared trip ── */
router.post('/pool/find', C.auth, async (req, res) => {
  const p2Id = req.body.rideId;
  const p2 = await val('rides/' + p2Id);
  if (!p2 || p2.riderUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });
  if (!p2.shared) return res.json({ matched: false, reason: 'not a shared ride' });
  if (p2.state === 'pool_pending') return res.json({ matched: true, pending: true });
  if (p2.state !== 'searching' || p2.poolWith)
    return res.json({ matched: false, reason: 'ride already moving' });

  const pickup = p2.points[0], drop = last(p2.points);
  const tried = p2.poolTried || {};
  const active = (await val('driverActive')) || {};

  /* Shortlist: moving shared trips, same class, driver close to P2. */
  const list = [];
  await Promise.all(Object.entries(active).map(async ([driverUid, p1Id]) => {
    if (tried[p1Id]) return;
    const [p1, loc] = await Promise.all([
      val('rides/' + p1Id), val('driverLoc/' + driverUid)
    ]);
    if (!p1 || !loc || !p1.shared || p1.state !== 'ontrip') return;
    if (p1.poolWith || p1.poolAsk || p1.riderUid === p2.riderUid) return;
    if (!Pool.classesCompatible(p1.cls, p2.cls)) return;
    if (!Pool.gendersCompatible(p1.riderGender, p2.riderGender)) return;
    const km = C.haversine(loc, pickup);
    if (km <= SEARCH_KM) list.push({ p1Id, p1, loc, km });
  }));
  list.sort((a, b) => a.km - b.km);

  for (const c of list.slice(0, MAX_CHECKS)) {
    try {
      const p1Drop = last(c.p1.points);
      const original = await route([c.loc, p1Drop]);
      const p2At = Pool.projectOnRoute(drop, original.line).at;
      const order = Pool.dropOrder(1, p2At);

      /* The detour that matters is the one P1 sits through: from here, via
         P2's pickup (and P2's drop if it comes first), to P1's destination. */
      const via = order[0] === 'p2' ? [c.loc, pickup, drop, p1Drop] : [c.loc, pickup, p1Drop];
      const withPool = await route(via);

      const verdict = Pool.evaluateMatch(
        { shared: c.p1.shared, cls: c.p1.cls, state: c.p1.state, poolWith: c.p1.poolWith,
          riderGender: c.p1.riderGender, fare: { km: c.p1.fare.km, total: c.p1.fare.total } },
        { shared: p2.shared, cls: p2.cls, riderGender: p2.riderGender, pickup, drop,
          fare: { km: p2.fare.km, total: p2.fare.total } },
        { line: original.line, original, withPool, sharedKm: withPool.legs[1].km }
      );

      await ref('rides/' + p2Id + '/poolTried/' + c.p1Id).set(true);
      if (!verdict.ok) continue;

      /* Claim P1 atomically so two waiting riders can't both be offered
         the same seat. */
      const ask = {
        p2RideId: p2Id, stage: 'rider', tries: 1,
        expires: Date.now() + Pool.OFFER_SEC * 1000,
        order: verdict.order, split: verdict.split,
        addedKm: verdict.addedKm, addedMin: verdict.addedMin,
        p2Pickup: p2.addr[0], p2Drop: last(p2.addr)
      };
      const claim = await ref('rides/' + c.p1Id + '/poolAsk')
        .transaction(existing => (existing ? undefined : ask));
      if (!claim.committed) continue;

      /* Pause P2's normal dispatch while P1 and the driver decide. */
      const up = {
        ['rides/' + p2Id + '/state']: 'pool_pending',
        ['rides/' + p2Id + '/poolCandidate']: c.p1Id,
        ['rides/' + p2Id + '/currentOffer']: null,
        ['riderRides/' + p2.riderUid + '/' + p2Id + '/state']: 'pool_pending'
      };
      const fresh = await val('rides/' + p2Id + '/currentOffer');
      if (fresh) up['offers/' + fresh.uid + '/' + fresh.offerId] = null;
      await ref().update(up);

      return res.json({
        matched: true,
        youPay: verdict.split.p2.pays,
        aloneFare: verdict.split.p2.was,
        waitSec: Pool.OFFER_SEC
      });
    } catch (e) {
      console.warn('pool check skipped for ' + c.p1Id + ':', e.message);
    }
  }
  res.json({ matched: false, reason: 'no suitable shared trip nearby' });
});

/* P2 polls this while pool_pending. When it returns 'searching' again the
   pool fell through and normal dispatch has resumed. */
router.get('/pool/status/:rideId', C.auth, async (req, res) => {
  const p2 = await val('rides/' + req.params.rideId);
  if (!p2 || p2.riderUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });
  if (p2.poolCandidate) await settle(p2.poolCandidate);
  const now = await val('rides/' + req.params.rideId);
  res.json({
    state: now.state,
    pooled: !!now.poolWith,
    fare: now.poolFare || null
  });
});

/* ── 2. P1 is asked ── */
router.get('/pool/ask/:rideId', C.auth, async (req, res) => {
  const p1 = await settle(req.params.rideId);
  if (!p1 || p1.riderUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });
  const a = p1.poolAsk;
  if (!a || a.stage !== 'rider') return res.json({ ask: null, pooled: !!p1.poolWith });
  res.json({
    ask: {
      addedMin: a.addedMin, addedKm: a.addedKm,
      youSave: a.split.p1.saves, youPay: a.split.p1.pays,
      expires: a.expires
    },
    pooled: false
  });
});

router.post('/pool/respond', C.auth, async (req, res) => {
  const p1Id = req.body.rideId;
  const p1 = await settle(p1Id);
  if (!p1 || p1.riderUid !== req.user.uid)
    return res.status(403).json({ error: 'Not your ride.' });
  const a = p1.poolAsk;
  if (!a || a.stage !== 'rider')
    return res.status(409).json({ error: 'That request has expired.' });

  if (req.body.accept !== true) {
    await releaseAsk(p1Id, a);
    return res.json({ ok: true, accepted: false });
  }

  await ref('rides/' + p1Id + '/poolAsk').update({
    stage: 'driver', expires: Date.now() + Pool.OFFER_SEC * 1000
  });
  const prof = await val('drivers/' + p1.driverUid);
  push(prof && prof.fcmToken,
       'Shared ride request · +\u20b9' + Pool.P2_SURCHARGE,
       a.p2Pickup + ' \u2192 ' + a.p2Drop);
  res.json({ ok: true, accepted: true });
});

/* ── 3. Driver is asked, and sees the pooled plan once linked ── */
router.get('/pool/driver', C.auth, async (req, res) => {
  const uid = req.user.uid;
  const activeId = await val('driverActive/' + uid);
  if (!activeId) return res.json({ ask: null, plan: null });

  let cur = await val('rides/' + activeId);
  if (cur && cur.poolAsk) cur = await settle(activeId);
  if (!cur || cur.driverUid !== uid) return res.json({ ask: null, plan: null });

  let ask = null;
  if (cur.poolAsk && cur.poolAsk.stage === 'driver') {
    const a = cur.poolAsk;
    ask = {
      pickup: a.p2Pickup, drop: a.p2Drop,
      addedMin: a.addedMin, addedKm: a.addedKm,
      extra: Pool.P2_SURCHARGE, expires: a.expires
    };
  }

  let plan = null;
  if (cur.poolWith) {
    const other = await val('rides/' + cur.poolWith);
    const p1 = cur.poolRole === 'p1' ? cur : other;
    const p2 = cur.poolRole === 'p2' ? cur : other;
    const p1Id = cur.poolRole === 'p1' ? activeId : cur.poolWith;
    const p2Id = cur.poolRole === 'p2' ? activeId : cur.poolWith;
    const card = (id, r) => r && ({
      rideId: id, state: r.state, riderName: r.riderName, riderPhone: r.riderPhone,
      pickup: r.addr[0], drop: last(r.addr),
      pickupLat: r.points[0].lat, pickupLng: r.points[0].lng,
      dropLat: last(r.points).lat, dropLng: last(r.points).lng,
      collect: r.poolFare ? r.poolFare.pays + (r.waitCharge || 0) + (r.boost || 0) : null
    });
    plan = { order: p1 && p1.poolOrder, p1: card(p1Id, p1), p2: card(p2Id, p2) };
  }
  res.json({ ask, plan });
});

router.post('/pool/driver-respond', C.auth, async (req, res) => {
  const uid = req.user.uid;
  const p1Id = await val('driverActive/' + uid);
  const p1 = p1Id && await settle(p1Id);
  if (!p1 || p1.driverUid !== uid)
    return res.status(403).json({ error: 'Not your ride.' });
  const a = p1.poolAsk;
  if (!a || a.stage !== 'driver')
    return res.status(409).json({ error: 'That request has expired.' });

  if (req.body.accept !== true) {
    await releaseAsk(p1Id, a);
    return res.json({ ok: true, accepted: false });
  }

  /* Re-check both sides: either rider may have cancelled while we waited. */
  const p2Id = a.p2RideId;
  const p2 = await val('rides/' + p2Id);
  if (p1.state !== 'ontrip' || !p2 || p2.state !== 'pool_pending' || p2.poolCandidate !== p1Id) {
    await releaseAsk(p1Id, a);
    return res.status(409).json({ error: 'The second rider is no longer available.' });
  }

  const now = Date.now();
  await ref().update({
    ['rides/' + p2Id + '/state']: 'assigned',
    ['rides/' + p2Id + '/driverUid']: uid,
    ['rides/' + p2Id + '/driver']: p1.driver || null,
    ['rides/' + p2Id + '/assignedAt']: now,
    ['rides/' + p2Id + '/poolCandidate']: null,
    ['rides/' + p2Id + '/poolWith']: p1Id,
    ['rides/' + p2Id + '/poolRole']: 'p2',
    ['rides/' + p2Id + '/poolFare']: a.split.p2,
    ['riderRides/' + p2.riderUid + '/' + p2Id + '/state']: 'assigned',
    ['riderRides/' + p2.riderUid + '/' + p2Id + '/driver']: (p1.driver && p1.driver.name) || null,
    ['riderRides/' + p2.riderUid + '/' + p2Id + '/fare']: a.split.p2.pays,

    ['rides/' + p1Id + '/poolAsk']: null,
    ['rides/' + p1Id + '/poolWith']: p2Id,
    ['rides/' + p1Id + '/poolRole']: 'p1',
    ['rides/' + p1Id + '/poolFare']: a.split.p1,
    ['rides/' + p1Id + '/poolOrder']: a.order,
    ['riderRides/' + p1.riderUid + '/' + p1Id + '/fare']: a.split.p1.pays,

    ['driverRides/' + uid + '/' + p2Id]: true
  });
  res.json({ ok: true, accepted: true });
});

/* ── 4. Intercepts on existing routes ── */

/* Pooled drop. Enforces drop order, bills the split fare, keeps the
   surcharge out of commission, and frees the driver only after both. */
router.post('/ride/complete', C.auth, async (req, res, next) => {
  const id = req.body.rideId;
  const ride = await val('rides/' + id);
  if (!ride || !ride.poolWith) return next();
  const uid = req.user.uid;
  if (ride.driverUid !== uid) return res.status(403).json({ error: 'Not your ride.' });
  if (ride.state !== 'ontrip')
    return res.status(409).json({ error: 'Start this trip with the rider\u2019s OTP first.' });

  const other = await val('rides/' + ride.poolWith);
  const otherDone = !other || other.state === 'completed' ||
                    String(other.state).startsWith('cancelled');
  const p1 = ride.poolRole === 'p1' ? ride : other;
  const order = (p1 && p1.poolOrder) || ['p1', 'p2'];
  if (order[0] !== ride.poolRole && !otherDone)
    return res.status(409).json({ error: 'Drop the other rider first.' });

  const f = ride.poolFare;
  const collected = f.pays + (ride.waitCharge || 0) + (ride.boost || 0);
  const surcharge = f.surcharge || 0;   // only P2's fare carries it
  const commission = Math.round((collected - surcharge) * COMMISSION);

  const up = {
    ['rides/' + id + '/state']: 'completed',
    ['rides/' + id + '/endedAt']: Date.now(),
    ['rides/' + id + '/collected']: collected,
    ['rides/' + id + '/commission']: commission,
    ['drivers/' + uid + '/dues']: admin.database.ServerValue.increment(commission),
    ['drivers/' + uid + '/trips']: admin.database.ServerValue.increment(1),
    ['ledger/' + uid + '/' + id]: { collected, commission, pooled: true, at: Date.now() },
    ['riderRides/' + ride.riderUid + '/' + id + '/state']: 'completed',
    ['riderRides/' + ride.riderUid + '/' + id + '/fare']: collected,
    ['riderActive/' + ride.riderUid]: null
  };
  if (otherDone) {
    up['driverLoc/' + uid + '/state'] = 'idle';
    up['driverActive/' + uid] = null;
  } else {
    up['driverActive/' + uid] = ride.poolWith;   // driver app now shows the rider still aboard
  }
  await ref().update(up);
  res.json({ ok: true, collect: collected, yourShare: collected - commission, commission,
             driverFree: otherDone });
});

/* Rider cancel. P2 may cancel before pickup without touching the driver or
   P1's trip; nobody can cancel a pooled trip that is under way. A pending
   request is cleaned up, then the normal cancel runs. */
router.post('/ride/cancel', C.auth, async (req, res, next) => {
  const id = req.body.rideId;
  const ride = await val('rides/' + id);
  if (!ride || ride.riderUid !== req.user.uid) return next();

  if (ride.poolAsk) await releaseAsk(id, ride.poolAsk);
  if (ride.state === 'pool_pending' && ride.poolCandidate) {
    await ref('rides/' + ride.poolCandidate + '/poolAsk').remove();
    await ref('rides/' + id + '/poolCandidate').remove();
  }
  if (!ride.poolWith) return next();

  if (ride.state === 'ontrip')
    return res.status(409).json({ error: 'Your shared trip is under way. Ask the driver to end it at your stop.' });

  const fee = ride.assignedAt && (Date.now() - ride.assignedAt) > CANCEL.graceSec * 1000
    ? CANCEL.fee : 0;
  await ref().update({
    ['rides/' + id + '/state']: 'cancelled_rider',
    ['rides/' + id + '/cancelFee']: fee,
    ['riderRides/' + ride.riderUid + '/' + id + '/state']: 'cancelled_rider',
    ['riderActive/' + ride.riderUid]: null,
    ...unlinkPartner(ride)
  });
  res.json({ ok: true, fee });
});

/* Driver cancel. Before P2's pickup the driver can drop the pool and P2 goes
   back to normal dispatch; P1's trip carries on. Once either pooled rider is
   aboard, cancelling is refused. */
router.post('/ride/driver-cancel', C.auth, async (req, res, next) => {
  const id = req.body.rideId;
  const ride = await val('rides/' + id);
  if (!ride || ride.driverUid !== req.user.uid) return next();

  if (ride.poolAsk) await releaseAsk(id, ride.poolAsk);
  if (!ride.poolWith) return next();

  if (ride.poolRole !== 'p2' || ride.state === 'ontrip')
    return res.status(409).json({ error: 'A rider is on board. Complete the trip instead.' });

  await ref().update({
    ['rides/' + id + '/state']: 'searching',
    ['rides/' + id + '/driverUid']: null,
    ['rides/' + id + '/driver']: null,
    ['rides/' + id + '/assignedAt']: null,
    ['rides/' + id + '/arrivedAt']: null,
    ['rides/' + id + '/poolWith']: null,
    ['rides/' + id + '/poolRole']: null,
    ['rides/' + id + '/poolFare']: null,
    ['rides/' + id + '/createdAt']: Date.now(),
    ['riderRides/' + ride.riderUid + '/' + id + '/state']: 'searching',
    ['riderRides/' + ride.riderUid + '/' + id + '/fare']: ride.fare.total,
    ['drivers/' + req.user.uid + '/cancelCount']: admin.database.ServerValue.increment(1),
    ...unlinkPartner(ride)
  });
  await C.advance(id);
  res.json({ ok: true });
});

/* When P2 leaves before pickup, P1 goes back to their normal fare —
   the discount existed only because the trip was shared. */
function unlinkPartner(ride) {
  const p1Id = ride.poolWith;
  return {
    ['rides/' + p1Id + '/poolWith']: null,
    ['rides/' + p1Id + '/poolRole']: null,
    ['rides/' + p1Id + '/poolFare']: null,
    ['rides/' + p1Id + '/poolOrder']: null,
    ['driverRides/' + ride.driverUid + '/' + ride.id]: null
  };
}

module.exports = router;
      
