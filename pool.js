/* RideX shared rides — matching rules and fare split.
 *
 * Kept separate from core dispatch deliberately: pooling adds a second
 * passenger to a trip that is already in progress, and every rule here has
 * to hold before a running trip is disturbed. A wrong match costs the first
 * rider real time, so the checks are strict and fail closed.
 */

const PICKUP_RADIUS_KM = 1.0;   // how far off-route P2's pickup may be
const MAX_DETOUR_KM    = 1.5;   // added distance vs the original trip
const MAX_DETOUR_MIN   = 6;     // added time vs the original trip

/* Modelled against real Rewari fares (₹100–320). At a ₹50 surcharge with a
   40% discount, only a third of realistic trip pairings left P2 better off
   than riding alone — the rest would have paid MORE for sharing, which is
   the one outcome that would destroy trust in the feature. ₹30 with a 50%
   discount leaves both riders ahead on every pairing tested, and still pays
   the driver roughly ₹53 extra per pooled trip. */
const P2_SURCHARGE   = 30;      // paid by P2, passed to the driver untouched
const SHARE_DISCOUNT = 0.50;    // fare reduction on the shared segment

/* Sharing needs a spare seat and a second stranger in the vehicle.
   A bike carries one passenger, so it can never pool. Parcel is goods rather
   than a person — pairing a passenger with someone else's delivery is a
   different product with different liability, so it is excluded too. */
const POOL_CLASSES = ['auto', 'mini', 'prime'];
const POOL_SEATS   = { auto: 3, mini: 4, prime: 6 };

const OFFER_SEC   = 30;         // how long P1 has to answer one request
const OFFER_TRIES = 2;          // how many times the same rider is asked

/* Both riders must be in a class that pools, and in the same class — someone
   who paid for a Cab Prime should not be moved into an auto. */
function canPool(cls) { return POOL_CLASSES.includes(cls); }
function classesCompatible(a, b) { return canPool(a) && a === b; }

const rad = d => d * Math.PI / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/* Perpendicular distance from a point to a line segment, in km. Distance to
   the nearest route *vertex* is not good enough — on a long straight stretch
   the vertices can be a kilometre apart, so a pickup right beside the road
   would measure as far away and be wrongly rejected. */
function distToSegment(p, a, b) {
  const toXY = q => ({
    x: q.lng * Math.cos(rad((a.lat + b.lat) / 2)) * 111.32,
    y: q.lat * 110.57
  });
  const P = toXY(p), A = toXY(a), B = toXY(b);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return haversine(p, a);
  let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const proj = { x: A.x + t*dx, y: A.y + t*dy };
  return Math.hypot(P.x - proj.x, P.y - proj.y);
}

/* Closest approach of a point to the whole route, and how far along the route
   that happens (0 = origin, 1 = destination). The fraction is what tells us
   whether P2's drop falls before or after P1's. */
function projectOnRoute(point, line) {
  let best = Infinity, bestAt = 0, acc = 0, total = 0;
  for (let i = 0; i < line.length - 1; i++) total += haversine(line[i], line[i+1]);
  for (let i = 0; i < line.length - 1; i++) {
    const segLen = haversine(line[i], line[i+1]);
    const d = distToSegment(point, line[i], line[i+1]);
    if (d < best) { best = d; bestAt = total ? (acc + segLen/2) / total : 0; }
    acc += segLen;
  }
  return { km: best, at: bestAt, routeKm: total };
}

/* Is this pickup close enough to the road the driver is already on? */
function pickupIsNearRoute(pickup, line) {
  const p = projectOnRoute(pickup, line);
  return { ok: p.km <= PICKUP_RADIUS_KM, offRouteKm: +p.km.toFixed(2), at: p.at };
}

/* The decisive test. `original` and `withPool` come from the Directions API:
   the trip as it stands, and the trip re-routed through P2's pickup and drop.
   A radius check alone is not enough — a pickup 400 m off the road can still
   cost fifteen minutes if it is across a divided highway or down a dead end,
   and that time comes entirely out of the first rider's evening. */
function detourWithinLimits(original, withPool) {
  const addedKm  = withPool.km - original.km;
  const addedMin = withPool.minutes - original.minutes;
  return {
    ok: addedKm <= MAX_DETOUR_KM && addedMin <= MAX_DETOUR_MIN,
    addedKm: +addedKm.toFixed(2),
    addedMin: Math.round(addedMin)
  };
}

/* Fare split.
   Both riders pay their normal rate for the distance they travel alone, and
   a reduced rate for the distance they share. P2 additionally pays a flat
   surcharge passed to the driver untouched — the driver does more work for
   the same trip, and that has to be worth their while or they will decline
   every pool and the feature dies whatever the app does. */
function splitFares(p1, p2, sharedKm) {
  const p1Shared = Math.min(sharedKm, p1.km);
  const p2Shared = Math.min(sharedKm, p2.km);

  const p1Discount = p1.km > 0
    ? Math.round((p1Shared / p1.km) * p1.total * SHARE_DISCOUNT) : 0;
  const p2Discount = p2.km > 0
    ? Math.round((p2Shared / p2.km) * p2.total * SHARE_DISCOUNT) : 0;

  const p1Pays = Math.max(0, p1.total - p1Discount);
  const p2Pays = Math.max(0, p2.total - p2Discount) + P2_SURCHARGE;

  return {
    sharedKm: +sharedKm.toFixed(2),
    p1: { was: p1.total, pays: p1Pays, saves: p1Discount },
    p2: { was: p2.total, pays: p2Pays, saves: p2Discount, surcharge: P2_SURCHARGE },
    // the surcharge is not commissionable — it exists to compensate the driver
    driverExtra: P2_SURCHARGE
  };
}

/* A pool is only worth offering if BOTH riders end up better off. Without
   this check a short overlap produces a discount smaller than P2's surcharge,
   so P2 pays more than riding alone. P1 also needs a saving worth the
   interruption — being asked to accept a stranger to save four rupees is not
   a fair trade. */
const MIN_P1_SAVING = 15;   // rupees
const MIN_P2_SAVING = 10;   // rupees, net of the surcharge

function poolIsWorthwhile(split) {
  const p2Net = split.p2.was - split.p2.pays;   // negative means P2 loses out
  return {
    ok: split.p1.saves >= MIN_P1_SAVING && p2Net >= MIN_P2_SAVING,
    p1Saves: split.p1.saves,
    p2Net,
    reason: split.p1.saves < MIN_P1_SAVING ? 'p1 saving too small'
          : p2Net < MIN_P2_SAVING ? 'p2 would not save enough' : null
  };
}

/* Which rider is dropped first. Returned as an explicit order so the driver
   and both riders work from one decision, rather than each deciding for
   themselves and disagreeing. */
function dropOrder(p1DropAt, p2DropAt) {
  return p2DropAt < p1DropAt ? ['p2', 'p1'] : ['p1', 'p2'];
}

/* Single entry point: can this waiting rider join that moving trip?
   Fails closed — any missing input is a rejection, never a maybe. */
function evaluateMatch(ongoing, waiting, routes) {
  const no = reason => ({ ok: false, reason });

  if (!ongoing || !waiting || !routes) return no('missing data');
  if (!ongoing.shared || !waiting.shared) return no('not a shared ride');
  if (!classesCompatible(ongoing.cls, waiting.cls)) return no('vehicle class');
  if (ongoing.state !== 'ontrip') return no('trip not under way');
  if (ongoing.poolWith) return no('already carrying a second rider');

  const near = pickupIsNearRoute(waiting.pickup, routes.line);
  if (!near.ok) return no('pickup ' + near.offRouteKm + ' km off route');

  const det = detourWithinLimits(routes.original, routes.withPool);
  if (!det.ok) return no('detour +' + det.addedKm + ' km / +' + det.addedMin + ' min');

  const split = splitFares(ongoing.fare, waiting.fare, routes.sharedKm);
  const worth = poolIsWorthwhile(split);
  if (!worth.ok) return no(worth.reason);

  const p2At = projectOnRoute(waiting.drop, routes.line).at;
  return {
    ok: true,
    offRouteKm: near.offRouteKm,
    addedKm: det.addedKm, addedMin: det.addedMin,
    split,
    order: dropOrder(1, p2At)   // P1's drop is the end of the route, at = 1
  };
}

module.exports = {
  PICKUP_RADIUS_KM, MAX_DETOUR_KM, MAX_DETOUR_MIN,
  P2_SURCHARGE, SHARE_DISCOUNT,
  POOL_CLASSES, POOL_SEATS, OFFER_SEC, OFFER_TRIES,
  MIN_P1_SAVING, MIN_P2_SAVING,
  canPool, classesCompatible,
  haversine, distToSegment, projectOnRoute,
  pickupIsNearRoute, detourWithinLimits,
  splitFares, poolIsWorthwhile, dropOrder, evaluateMatch
};

