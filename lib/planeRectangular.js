// Converts Japan's Plane Rectangular Coordinate System (平面直角座標系) — the
// standard surveying coordinate system used in Japanese civil-engineering
// documents — to decimal-degree lat/lon (JGD2000/JGD2011, GRS80 ellipsoid).
//
// This is a genuinely different coordinate system from lat/lon, not another
// notation for it: X/Y are meters measured from one of 19 zone-specific
// origins, and (unlike the usual convention) X is the north-south axis while
// Y is east-west.
//
// Port of the widely-used Kawase (2011) / GSI series-expansion algorithm.
// Verified against https://gist.github.com/vpcf/d7e497ba7dd9b182b2663f62169501c8
// and round-trip tested (lat/lon -> X/Y -> lat/lon) to sub-millimeter
// precision. Zone origins cross-checked against 日本地図センター's published
// table (jmc.or.jp).
const GRS80_A = 6378137;
const GRS80_F = 298.257222101;
const M0 = 0.9999;

// [origin latitude, origin longitude] in degrees, per 平成14年国土交通省告示第9号
const ZONE_ORIGINS = {
  1: [33, 129 + 30 / 60], 2: [33, 131], 3: [36, 132 + 10 / 60],
  4: [33, 133 + 30 / 60], 5: [36, 134 + 20 / 60], 6: [36, 136],
  7: [36, 137 + 10 / 60], 8: [36, 138 + 30 / 60], 9: [36, 139 + 50 / 60],
  10: [40, 140 + 50 / 60], 11: [44, 140 + 15 / 60], 12: [44, 142 + 15 / 60],
  13: [44, 144 + 15 / 60], 14: [26, 142], 15: [26, 127 + 30 / 60],
  16: [26, 124], 17: [26, 131], 18: [20, 136], 19: [26, 154],
};

const toRad = deg => deg * Math.PI / 180;
const toDeg = rad => rad * 180 / Math.PI;

function planeRectangularToLatLon(x, y, zone) {
  const origin = ZONE_ORIGINS[zone];
  if (!origin) return null;
  const lat0 = toRad(origin[0]);
  const lon0 = toRad(origin[1]);

  const n = 1 / (2 * GRS80_F - 1);
  const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;

  const A = [
    1 + (1 / 4) * n2 + (1 / 64) * n4,
    -(3 / 2) * (n - (1 / 8) * n3 - (1 / 64) * n5),
    (15 / 16) * (n2 - (1 / 4) * n4),
    -(35 / 48) * (n3 - (5 / 16) * n5),
    (315 / 512) * n4,
    -(693 / 1280) * n5,
  ];

  const beta = [0,
    0.5 * n - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5,
    (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5,
    (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5,
    (4397 / 161280) * n4 - (11 / 504) * n5,
    (4583 / 161280) * n5,
  ];

  const delta = [0,
    2 * n - (2 / 3) * n2 - 2 * n3 + (116 / 45) * n4 + (26 / 45) * n5 - (2854 / 675) * n6,
    (7 / 3) * n2 - (8 / 5) * n3 - (227 / 45) * n4 + (2704 / 315) * n5 + (2323 / 945) * n6,
    (56 / 15) * n3 - (136 / 35) * n4 - (1262 / 105) * n5 + (73815 / 2835) * n6,
    (4279 / 630) * n4 - (332 / 35) * n5 - (399572 / 14175) * n6,
    (4174 / 315) * n5 - (144838 / 6237) * n6,
    (601676 / 22275) * n6,
  ];

  const Abar = (M0 * GRS80_A) / (1 + n) * A[0];
  let Sbar = A[0] * lat0;
  for (let j = 1; j <= 5; j++) Sbar += A[j] * Math.sin(2 * j * lat0);
  Sbar *= (M0 * GRS80_A) / (1 + n);

  const xi = (x + Sbar) / Abar;
  const eta = y / Abar;

  let xiPrime = xi, etaPrime = eta;
  for (let j = 1; j <= 5; j++) {
    xiPrime -= beta[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etaPrime -= beta[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const chi = Math.asin(Math.sin(xiPrime) / Math.cosh(etaPrime));
  let lat = chi;
  for (let j = 1; j <= 6; j++) lat += delta[j] * Math.sin(2 * j * chi);
  const lon = lon0 + Math.atan(Math.sinh(etaPrime) / Math.cos(xiPrime));

  return { lat: toDeg(lat), lng: toDeg(lon) };
}

module.exports = { planeRectangularToLatLon, ZONE_ORIGINS };
