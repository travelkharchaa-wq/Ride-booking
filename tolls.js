/* RideX tolls and interstate charges.
 *
 * Toll rates are revised by NHAI roughly every April, so these live in one
 * editable registry rather than scattered through the fare code. Each entry
 * carries the date it was last checked — an estimate quoted from a two-year
 * old rate is worse than no estimate, because the customer is told a number
 * that will not match what the driver actually pays.
 *
 * VERIFY BEFORE RELYING ON THESE. Only Kherki Daula has been confirmed
 * against a current source. The rest are placeholders marked unverified and
 * are deliberately excluded from quotes until someone checks them.
 */

/* Two- and three-wheelers are exempt from toll on national highways in
   India, so a bike or auto never pays. Only the cab classes do. */
const TOLLED_CLASSES = ['mini', 'prime'];

const PLAZAS = [
  {
    id: 'kherki-daula',
    name: 'Kherki Daula',
    lat: 28.395604, lng: 76.98176,
    highway: 'NH-48',
    oneWay: 100,          // car / jeep / van, single journey
    sameDayReturn: 150,
    checked: '2026-04-01',
    verified: true
  },
  /* Add the rest for your corridor here. Each needs its coordinates and the
     current car rate from the NHAI plaza page. Leave verified:false until
     checked, and the quote will skip it rather than guess. */
  { id: 'panchgaon',  name: 'Panchgaon',  lat: 28.3120, lng: 76.8900,
    highway: 'NH-48', oneWay: 0, sameDayReturn: 0, checked: null, verified: false },
  { id: 'shahjahanpur', name: 'Shahjahanpur', lat: 27.9300, lng: 76.4600,
    highway: 'NH-48', oneWay: 0, sameDayReturn: 0, checked: null, verified: false }
];

/* A driver dropping a passenger past a toll has to pay it again to come
   back. Charging the full return rate on a short local hop would feel like
   gouging, so the default is one-way only; set this true for long runs where
   the driver genuinely cannot pick up a return fare. */
const CHARGE_RETURN_TOLL = false;

/* Interstate charge. A Haryana taxi crossing into Delhi or Rajasthan needs a
   permit, and the cost is real but varies by permit type. Set to 0 by default
   so nothing is charged until you have a figure you can defend to a customer
   who asks what it is for. */
const INTERSTATE_CHARGE = 0;

/* How close the route must pass to count as going through the plaza. Toll
   booths sit on the carriageway, so 400 m is generous enough for GPS drift
   without catching a parallel service road that bypasses the booth. */
const PLAZA_HIT_KM = 0.4;

const rad = d => d * Math.PI / 180;
function haversine(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat/2)**2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng/2)**2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/* Perpendicular distance to a segment, so a plaza beside a long straight
   stretch is not missed just because the route has few vertices there. */
function distToSegment(p, a, b) {
  const mid = (a.lat + b.lat) / 2;
  const toXY = q => ({ x: q.lng * Math.cos(rad(mid)) * 111.32, y: q.lat * 110.57 });
  const P = toXY(p), A = toXY(a), B = toXY(b);
  const dx = B.x - A.x, dy = B.y - A.y;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) return haversine(p, a);
  let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(P.x - (A.x + t*dx), P.y - (A.y + t*dy));
}

function routePassesPlaza(line, plaza) {
  if (!Array.isArray(line) || line.length < 2) return false;
  for (let i = 0; i < line.length - 1; i++) {
    if (distToSegment(plaza, line[i], line[i+1]) <= PLAZA_HIT_KM) return true;
  }
  return false;
}

/* Which plazas this route goes through, and what they cost.
   Unverified entries are skipped entirely — quoting a number we have not
   checked is worse than quoting none, because the customer will be told one
   figure and the driver will pay another. */
function tollsForRoute(line, cls) {
  if (!TOLLED_CLASSES.includes(cls)) {
    return { total: 0, plazas: [], exempt: true };
  }
  const hits = [];
  let total = 0;
  for (const p of PLAZAS) {
    if (!p.verified) continue;
    if (!routePassesPlaza(line, p)) continue;
    const amount = CHARGE_RETURN_TOLL ? p.sameDayReturn : p.oneWay;
    hits.push({ id: p.id, name: p.name, amount });
    total += amount;
  }
  return { total, plazas: hits, exempt: false };
}

/* State lookup.
   A bounding box cannot do this job on the Rewari corridor: Gurgaon sits
   inside any box drawn around Delhi, so a Rewari-to-Gurgaon trip — both
   Haryana, and the most common long run here — would be wrongly billed as
   interstate. Delhi is therefore tested against a simplified outline of the
   NCT boundary, and everything else falls back to boxes.
   Returns null when unsure, and an unknown state never triggers a charge. */
const DELHI_NCT = [
  [28.880, 77.150], [28.855, 77.230], [28.830, 77.285], [28.700, 77.330],
  [28.620, 77.345], [28.530, 77.320], [28.425, 77.295],   // south-east, Badarpur
  [28.480, 77.180], [28.502, 77.100],                     // Rajokri
  [28.522, 77.030], [28.545, 76.960],                     // Kapashera, west of airport
  [28.570, 76.880], [28.640, 76.845],                     // Najafgarh
  [28.760, 76.930], [28.840, 77.060]
];

/* Ray casting: count how many times a ray from the point crosses the
   boundary. Odd means inside. */
function pointInPolygon(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    const hits = (yi > pt.lat) !== (yj > pt.lat) &&
                 pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi;
    if (hits) inside = !inside;
  }
  return inside;
}

/* Boxes are only accurate near the Rewari corridor, which is all RideX
   serves. Rajasthan and Uttar Pradesh overlap badly in the east, so a point
   deep inside UP can read as Rajasthan — irrelevant at 250 km from base, but
   it must be fixed before operating anywhere near that border. */
const STATE_BOXES = [
  { state: 'HR', minLat: 27.65, maxLat: 30.93, minLng: 74.46, maxLng: 77.60 },
  { state: 'RJ', minLat: 23.03, maxLat: 30.19, minLng: 69.48, maxLng: 77.30 },
  { state: 'UP', minLat: 23.87, maxLat: 30.41, minLng: 77.09, maxLng: 84.63 }
];

function stateOf(pt) {
  if (!pt || typeof pt.lat !== 'number' || typeof pt.lng !== 'number') return null;
  if (pointInPolygon(pt, DELHI_NCT)) return 'DL';
  for (const b of STATE_BOXES) {
    if (pt.lat >= b.minLat && pt.lat <= b.maxLat &&
        pt.lng >= b.minLng && pt.lng <= b.maxLng) return b.state;
  }
  return null;
}

function interstateCharge(pickup, drop) {
  const a = stateOf(pickup), b = stateOf(drop);
  if (!a || !b || a === b) return { amount: 0, from: a, to: b, crosses: false };
  return { amount: INTERSTATE_CHARGE, from: a, to: b, crosses: true };
}

/* Everything a quote needs, as separate named lines so the customer can see
   exactly what they are paying for rather than one opaque total. */
function extrasForTrip(line, cls, pickup, drop) {
  const toll = tollsForRoute(line, cls);
  const inter = interstateCharge(pickup, drop);
  return {
    toll: toll.total,
    tollPlazas: toll.plazas,
    tollExempt: toll.exempt,
    interstate: inter.amount,
    crossesState: inter.crosses,
    fromState: inter.from, toState: inter.to,
    total: toll.total + inter.amount
  };
}

module.exports = {
  PLAZAS, TOLLED_CLASSES, PLAZA_HIT_KM,
  CHARGE_RETURN_TOLL, INTERSTATE_CHARGE,
  routePassesPlaza, tollsForRoute, stateOf, pointInPolygon, DELHI_NCT,
  interstateCharge, extrasForTrip
};

