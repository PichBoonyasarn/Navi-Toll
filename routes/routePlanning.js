const express = require('express');
const router = express.Router();
const { withRetry } = require('../lib/retry');

// NAVITIME's Car Route Search, via the RapidAPI marketplace (free BASIC tier:
// 500 requests/month, 50/min) rather than a direct NAVITIME Japan contract.
// Chosen over Google's Routes API specifically because it returns structured
// interchange data: every route point carries a `highway: "on"/"off"` flag
// plus the actual place `name` directly - no more inferring entry/exit names
// by regex-parsing free-text turn instructions or guessing via a Places
// text-search fallback, which was the root cause of a whole session's worth
// of exit-IC bugs in the sibling toll-finder project.
const NAVITIME_API_KEY = process.env.NAVITIME_API_KEY || '';
const NAVITIME_HOST = 'navitime-route-car.p.rapidapi.com';
const ROUTE_URL = `https://${NAVITIME_HOST}/route_car`;
const SHAPE_URL = `https://${NAVITIME_HOST}/shape_car`;

function navitimeHeaders() {
  return { 'X-RapidAPI-Key': NAVITIME_API_KEY, 'X-RapidAPI-Host': NAVITIME_HOST };
}

// Returns the JST wall-clock date/time parts for a given instant, independent
// of the server's own timezone/locale settings.
function jstParts(date) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  });
  return Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
}

// NAVITIME applies real ETC time-of-day discounts (notably the 30% 深夜割引
// for any toll-road segment travelled between 0:00-4:00 JST) based on the
// actual departure time of the route. Defaulting to "depart now" means the
// same route can price ~30% lower or higher purely depending on what time of
// day someone happens to click search - confirmed live (2026-07-21): a "now"
// departure that happened to land a long route's arrival just after midnight
// showed ¥10,130, while pinning departure to a normal daytime hour for the
// identical route showed ¥14,470, matching NAVITIME's own site and Google
// Maps (¥14,070 / ¥14,000). Always requesting a fixed 09:00 JST departure
// (today if it hasn't passed yet, otherwise tomorrow) keeps trips of any
// realistic length clear of that midnight window, giving a consistent full
// (undiscounted, "worst case") toll price instead of one that varies with
// the clock.
function nextDaytimeDeparture() {
  const now = new Date();
  const p = jstParts(now);
  const target = new Date(Date.UTC(parseInt(p.year, 10), parseInt(p.month, 10) - 1, parseInt(p.day, 10)));
  if (parseInt(p.hour, 10) >= 9) target.setUTCDate(target.getUTCDate() + 1);
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(target.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T09:00`;
}

async function computeLeg(origin, destination) {
  return withRetry(async () => {
    const params = new URLSearchParams({
      start: `${origin.lat},${origin.lng}`,
      goal: `${destination.lat},${destination.lng}`,
      // turn_by_turn: includes interchange/exit names on route points.
      // etc=use: ETC-specific toll pricing (Japan's near-universal electronic
      // toll system) - same intent as Google's tollPasses: ['JP_ETC'].
      // start_time: see nextDaytimeDeparture() above - pins the fare to a
      // discount-free daytime departure instead of "now".
      // No `shape` param here - confirmed via live testing (2026-07-06) that
      // this RapidAPI wrapping's route_car doesn't have one (absent from its
      // own Params list); route geometry is a separate shape_car call below.
      options: 'turn_by_turn',
      etc: 'use',
      datum: 'wgs84',
      coord_unit: 'degree',
      start_time: nextDaytimeDeparture(),
    });
    const r = await fetch(`${ROUTE_URL}?${params.toString()}`, { headers: navitimeHeaders() });
    const json = await r.json();
    if (json.error) throw new Error(`NAVITIME API: ${JSON.stringify(json.error)}`);
    if (!json.items || !json.items.length) throw new Error('NAVITIME API: no route found');
    return json.items[0];
  }, { attempts: 3, delayMs: 800 });
}

// Separate endpoint for route geometry (see the no-shape-param note above).
// Returns [] on any failure - a missing map line shouldn't fail the whole
// request when the toll/IC data (the actual point of this app) is fine.
async function fetchShape(origin, destination) {
  try {
    const params = new URLSearchParams({
      start: `${origin.lat},${origin.lng}`,
      goal: `${destination.lat},${destination.lng}`,
      coord_unit: 'degree',
      datum: 'wgs84',
      // Same fixed departure as computeLeg, so the drawn path matches the
      // route the fare was actually computed for (time-of-day traffic
      // conditions can otherwise steer the route engine differently).
      start_time: nextDaytimeDeparture(),
    });
    const r = await fetch(`${SHAPE_URL}?${params.toString()}`, { headers: navitimeHeaders() });
    const json = await r.json();
    if (json.error) return [];
    // GeoJSON FeatureCollection - coordinates are always [lon, lat], the
    // opposite of the {lat, lng} shape the frontend/map expects.
    const features = json.features || json.items?.[0]?.features || [];
    const path = [];
    for (const f of features) {
      const geom = f.geometry;
      if (!geom) continue;
      if (geom.type === 'LineString') {
        for (const [lon, lat] of geom.coordinates) path.push({ lat, lng: lon });
      } else if (geom.type === 'MultiLineString') {
        for (const line of geom.coordinates) for (const [lon, lat] of line) path.push({ lat, lng: lon });
      }
    }
    return path;
  } catch {
    return [];
  }
}

// Fare is keyed as unit_{fareClassID}_{vehicleTypeID}. Verified live
// (2026-07-06) against a known reference price (Tokyo->Umeda, standard car/
// ETC ~=Y11,660 for 485.7km): for a 501.6km test route, unit_1025_2 gave
// Y12,200 (matches, scaled for the longer distance) while unit_1024_2 gave
// Y15,040 (way off). So fareClassID 1025's "_2" vehicle tier is the standard
// passenger-car ETC rate, not 1024 - not documented anywhere, reverse
// engineered from real pricing. Falls back to 1024 or any numeric value if
// 1025 isn't present on a given route (fare class IDs seem to vary somewhat
// by which toll operator/road is involved).
function extractTollEstimate(route) {
  const fare = route.summary?.move?.fare;
  if (!fare) return null;
  const amount = fare.unit_1025_2 ?? fare.unit_1024_2 ?? Object.values(fare).find(v => typeof v === 'number');
  if (amount == null) return null;
  return { currencyCode: 'JPY', amount: Math.round(amount) };
}

// Sections is a flat array alternating point/move objects. Point objects
// carry `highway: "on"|"off"|"junction"|"connection"` plus the real
// interchange `name` directly - this is the whole reason for using NAVITIME
// over Google here, so this function is deliberately simple: no heuristics,
// no fallback text search, just read the field.
function extractICs(route) {
  const points = (route.sections || []).filter(s => s.type === 'point' && s.highway);
  const entry = points.find(p => p.highway === 'on');
  const exit = [...points].reverse().find(p => p.highway === 'off');
  return {
    entryICs: entry?.name ? [entry.name] : [],
    exitICs: exit?.name ? [exit.name] : [],
  };
}

// Toll road names: move segments whose line_name is set, restricted to the
// stretch between the first "on" point and the last "off" point (the
// expressway portion of the trip) so surface-street names aren't included.
function extractTollRoadNames(route) {
  const sections = route.sections || [];
  const onIdx = sections.findIndex(s => s.type === 'point' && s.highway === 'on');
  const offIdx = sections.map(s => s.type === 'point' && s.highway === 'off').lastIndexOf(true);
  if (onIdx === -1 || offIdx === -1 || offIdx < onIdx) return [];

  const names = [];
  const seen = new Set();
  for (let i = onIdx; i <= offIdx; i++) {
    const s = sections[i];
    if (s.type === 'move' && s.line_name && !seen.has(s.line_name)) {
      seen.add(s.line_name);
      names.push(s.line_name);
    }
  }
  return names;
}

function parseCoord(req, res, prefix) {
  const lat = parseFloat(req.query[`${prefix}Lat`]);
  const lng = parseFloat(req.query[`${prefix}Lng`]);
  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: `${prefix}Lat and ${prefix}Lng are required` });
    return null;
  }
  return { lat, lng };
}

router.get('/leg', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!NAVITIME_API_KEY) return res.status(500).json({ error: 'NAVITIME_API_KEY is not configured' });

  const from = parseCoord(req, res, 'from'); if (!from) return;
  const to   = parseCoord(req, res, 'to');   if (!to) return;

  try {
    const [route, path] = await Promise.all([computeLeg(from, to), fetchShape(from, to)]);
    const { entryICs, exitICs } = extractICs(route);

    res.json({
      distanceMeters: route.summary?.move?.distance ?? null,
      durationSeconds: route.summary?.move?.time != null ? route.summary.move.time * 60 : null,
      path,
      tollEstimate: extractTollEstimate(route),
      tollRoads: extractTollRoadNames(route),
      entryICs,
      exitICs,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
