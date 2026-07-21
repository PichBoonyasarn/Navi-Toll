const express = require('express');
const router = express.Router();
const multer = require('multer');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const path = require('path');
const { planeRectangularToLatLon } = require('../lib/planeRectangular');
const { ocrImageToText, isGeminiConfigured } = require('../lib/geminiOcr');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Japan coordinate bounds
const LAT_MIN = 24, LAT_MAX = 46, LNG_MIN = 122, LNG_MAX = 154;

function normalize(text) {
  // NFKC converts full-width digits/punctuation (３５．６) → ASCII (35.6)
  return text.normalize('NFKC');
}

function dmsToDecimal(deg, min, sec, dir) {
  const decimal = parseFloat(deg) + parseFloat(min) / 60 + parseFloat(sec) / 3600;
  return (dir === 'S' || dir === 'W' || dir === '南' || dir === '西') ? -decimal : decimal;
}

function validateJapan(lat, lng) {
  return lat >= LAT_MIN && lat <= LAT_MAX && lng >= LNG_MIN && lng <= LNG_MAX;
}

// Pattern 1 — Japanese DMS: 北緯35度41分22秒 東経139度41分30秒
// Also accepts the plain 緯度/経度 labels (no 北/東 direction prefix) seen in
// some site-guide maps, e.g. "緯度:37度23分48.32秒 経度:136度50分34.33秒" —
// always North/East since this tool is Japan-only, same assumption as the
// other direction-optional patterns below.
const RE_JA_DMS = /(?:北緯|緯度)\s*[:：]?\s*(\d+)\s*度\s*(\d+)\s*分\s*([\d.]+)\s*秒\s*[、,\s]*(?:東経|経度)\s*[:：]?\s*(\d+)\s*度\s*(\d+)\s*分\s*([\d.]+)\s*秒/g;

// Pattern 2 — English DMS: 35°41'22"N 139°41'30"E  (also ′ ″ variants).
// The N/E direction letter is optional — some inspection-form PDFs print
// bare "34°53′37.33″ 135°12′14.98″" with no suffix, and since this tool is
// Japan-only, a missing direction always means North/East anyway.
// The direction letter can also come *before* the digits instead of after —
// e.g. a bridge inspection form's "位置情報" field OCR'd as
// "N35°25′49.4″ E136°45′00.7″" — so both a leading and trailing group are
// matched and the code below takes whichever one fired.
// The seconds mark also accepts two consecutive prime characters (′′) —
// NFKC normalization (applied below) decomposes a real ″ DOUBLE PRIME into
// exactly that, so a literal ″ never survives to reach this regex.
// Also tolerates 北緯/緯度 and 東経/経度 labels wrapping symbol-based DMS
// (e.g. OCR'd site maps read as "北緯 37°22′36.4″ 東経 139°15′30.2″") — the
// 東経/経度 label sits *between* the two DMS groups, not just before the
// whole match, so it has to be part of the connector, not a separate prefix.
const RE_EN_DMS = /(?:北緯|緯度)?\s*([NS])?\s*(\d+)[°˚]\s*(\d+)[′']\s*([\d.]+)(?:[″"]|[′']{2})\s*([NS])?\s*[,\s]*(?:東経|経度)?\s*([EW])?\s*(\d+)[°˚]\s*(\d+)[′']\s*([\d.]+)(?:[″"]|[′']{2})\s*([EW])?/g;

// Pattern 3 — Labeled decimal: 緯度: 35.6895 / 経度: 139.6917  (or lat/lon/latitude/longitude)
const RE_LABELED = /(?:緯度|lat(?:itude)?)\s*[:：]\s*([-\d.]+)\s*[\/,、\s]+(?:経度|lon(?:gitude)?|lng)\s*[:：]\s*([-\d.]+)/gi;

// Pattern 4 — Directional decimal: 35.6895N, 139.6917E
const RE_DIRECTIONAL = /([\d.]+)\s*([NS])\s*[,\s]+([\d.]+)\s*([EW])/g;

// Pattern 5 — Bare decimal pair: 35.6895, 139.6917 (4+ decimal places to reduce false positives)
const RE_BARE = /\b((?:2[4-9]|[34]\d|4[0-6])\.\d{4,})\s*[,、]\s*((?:12[2-9]|1[3-4]\d|15[0-4])\.\d{4,})\b/g;

// Pattern 6 — Google Maps URL: @35.6895,139.6917
const RE_GMAPS = /@((?:2[4-9]|[34]\d|4[0-6])\.\d{4,}),((?:12[2-9]|1[3-4]\d|15[0-4])\.\d{4,})/g;

// Pattern 7 — Bare decimal pair, longitude first: 139.6917, 35.6895
// Some sources (GeoJSON exports, GIS tools) write [lng, lat] order instead of
// Japan's usual lat-first convention. Safe to match independently rather than
// making order optional in Pattern 5 — the lat range (24-46) and lng range
// (122-154) never overlap, so there's no ambiguity about which number is which.
const RE_BARE_LNG_FIRST = /\b((?:12[2-9]|1[3-4]\d|15[0-4])\.\d{4,})\s*[,、]\s*((?:2[4-9]|[34]\d|4[0-6])\.\d{4,})\b/g;

// Pattern 8 — English DM (degree-minute, no seconds): 35°25.8'N 136°45.0'E
// Some GPS units and mobile-captured locations report only minutes, not full
// DMS. The negative lookaheads after each minute value are required: without
// them, this pattern would also match the first two components of a full DMS
// value like "35°41'22"N" (i.e. mistake it for 35°41' and silently drop the
// 22" seconds, a ~1.5km position error) — the lookahead rejects a match here
// whenever what immediately follows looks like a seconds component.
const RE_EN_DM = /(?:北緯|緯度)?\s*([NS])?\s*(\d+)[°˚]\s*([\d.]+)[′'](?!\s*[\d.]*\s*(?:[″"]|[′']{2}))\s*([NS])?\s*[,\s]*(?:東経|経度)?\s*([EW])?\s*(\d+)[°˚]\s*([\d.]+)[′'](?!\s*[\d.]*\s*(?:[″"]|[′']{2}))\s*([EW])?/g;

// Pattern 9 — Japanese DM (degree-minute, no seconds): 北緯35度25.8分 東経136度45.0分
// Same rationale and same seconds-lookahead guard as Pattern 8.
const RE_JA_DM = /(?:北緯|緯度)\s*[:：]?\s*(\d+)\s*度\s*([\d.]+)\s*分(?!\s*[\d.]*\s*秒)\s*[、,\s]*(?:東経|経度)\s*[:：]?\s*(\d+)\s*度\s*([\d.]+)\s*分(?!\s*[\d.]*\s*秒)/g;

// Pattern 12 — Hyphen-separated degree/minute anchor with seconds split into
// a structurally separate PDF table, e.g. "E 138 -55 N 37 -21" ... (unrelated
// form fields) ... "-09.10 -07.00". Seen in the MLIT standard bridge
// inspection form (点検調書) 位置情報 table: the degree+minute cell and the
// seconds cell are visually one row but come from two different table
// objects in the PDF, so pdf-parse's linear text emits them far apart with
// no shared label nearby. The two seconds values always appear in the same
// left-to-right order as the degree/minute anchor they belong to, so the
// anchor's direction letters (not fixed position) decide which is lng/lat.
const RE_DASH_DM_ANCHOR = /([EWNS])\s*(\d{1,3})\s*-?\s*(\d{1,2})\s*([EWNS])\s*(\d{1,3})\s*-?\s*(\d{1,2})/g;
const DASH_SECONDS_PAIR_RE = /-(\d{1,2}(?:\.\d+)?)\s+-(\d{1,2}(?:\.\d+)?)/;
const DASH_DM_SEARCH_WINDOW = 3000;

function findDashSplitDms(text) {
  const re = new RegExp(RE_DASH_DM_ANCHOR.source, 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    const [, dir1, deg1, min1, dir2, deg2, min2] = m;
    const isEW1 = dir1 === 'E' || dir1 === 'W';
    const isNS1 = dir1 === 'N' || dir1 === 'S';
    const isEW2 = dir2 === 'E' || dir2 === 'W';
    const isNS2 = dir2 === 'N' || dir2 === 'S';
    if (!((isEW1 && isNS2) || (isNS1 && isEW2))) continue;

    const windowStart = m.index + m[0].length;
    const window = text.slice(windowStart, windowStart + DASH_DM_SEARCH_WINDOW);
    const secMatch = DASH_SECONDS_PAIR_RE.exec(window);
    if (!secMatch) continue;

    const firstIsLng = isEW1;
    const lngDeg = firstIsLng ? deg1 : deg2;
    const lngMin = firstIsLng ? min1 : min2;
    const lngSec = firstIsLng ? secMatch[1] : secMatch[2];
    const lngDir = firstIsLng ? dir1 : dir2;
    const latDeg = firstIsLng ? deg2 : deg1;
    const latMin = firstIsLng ? min2 : min1;
    const latSec = firstIsLng ? secMatch[2] : secMatch[1];
    const latDir = firstIsLng ? dir2 : dir1;

    const lat = dmsToDecimal(latDeg, latMin, latSec, latDir);
    const lng = dmsToDecimal(lngDeg, lngMin, lngSec, lngDir);
    const end = windowStart + secMatch.index + secMatch[0].length;
    return { lat, lng, index: m.index, length: end - m.index };
  }
  return null;
}

function extractCoordinates(rawText) {
  const text = normalize(rawText);
  const results = [];
  const seen = new Set();

  const add = (lat, lng, index, len) => {
    if (!validateJapan(lat, lng)) return;
    const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const start = Math.max(0, index - 40);
    const end = Math.min(text.length, index + len + 60);
    const context = text.slice(start, end).replace(/[\r\n\t]+/g, ' ').trim();
    results.push({ lat, lng, context });
  };

  let m;

  // 1. Japanese DMS
  const re1 = new RegExp(RE_JA_DMS.source, 'g');
  while ((m = re1.exec(text)) !== null) {
    const lat = dmsToDecimal(m[1], m[2], m[3], '北');
    const lng = dmsToDecimal(m[4], m[5], m[6], '東');
    add(lat, lng, m.index, m[0].length);
  }

  // 2. English DMS
  const re2 = new RegExp(RE_EN_DMS.source, 'g');
  while ((m = re2.exec(text)) !== null) {
    const lat = dmsToDecimal(m[2], m[3], m[4], m[1] || m[5]);
    const lng = dmsToDecimal(m[7], m[8], m[9], m[6] || m[10]);
    add(lat, lng, m.index, m[0].length);
  }

  // 3. Labeled decimal
  const re3 = new RegExp(RE_LABELED.source, 'gi');
  while ((m = re3.exec(text)) !== null) {
    add(parseFloat(m[1]), parseFloat(m[2]), m.index, m[0].length);
  }

  // 4. Directional decimal
  const re4 = new RegExp(RE_DIRECTIONAL.source, 'g');
  while ((m = re4.exec(text)) !== null) {
    const lat = parseFloat(m[1]) * (m[2] === 'S' ? -1 : 1);
    const lng = parseFloat(m[3]) * (m[4] === 'W' ? -1 : 1);
    add(lat, lng, m.index, m[0].length);
  }

  // 5. Bare decimal pair
  const re5 = new RegExp(RE_BARE.source, 'g');
  while ((m = re5.exec(text)) !== null) {
    add(parseFloat(m[1]), parseFloat(m[2]), m.index, m[0].length);
  }

  // 6. Google Maps URL
  const re6 = new RegExp(RE_GMAPS.source, 'g');
  while ((m = re6.exec(text)) !== null) {
    add(parseFloat(m[1]), parseFloat(m[2]), m.index, m[0].length);
  }

  // 7. Bare decimal pair, longitude first
  const re7 = new RegExp(RE_BARE_LNG_FIRST.source, 'g');
  while ((m = re7.exec(text)) !== null) {
    add(parseFloat(m[2]), parseFloat(m[1]), m.index, m[0].length);
  }

  // 8. English DM (degree-minute, no seconds)
  const re8 = new RegExp(RE_EN_DM.source, 'g');
  while ((m = re8.exec(text)) !== null) {
    const lat = dmsToDecimal(m[2], m[3], 0, m[1] || m[4]);
    const lng = dmsToDecimal(m[6], m[7], 0, m[5] || m[8]);
    add(lat, lng, m.index, m[0].length);
  }

  // 9. Japanese DM (degree-minute, no seconds)
  const re9 = new RegExp(RE_JA_DM.source, 'g');
  while ((m = re9.exec(text)) !== null) {
    const lat = dmsToDecimal(m[1], m[2], 0, '北');
    const lng = dmsToDecimal(m[3], m[4], 0, '東');
    add(lat, lng, m.index, m[0].length);
  }

  // 10. Label proximity — some multi-page inspection-form PDFs flatten their
  // table layout so the label and value end up far apart, duplicated, or
  // tab-separated instead of adjacent (e.g. "経度 経度\t0137.454318 ...").
  // Instead of requiring strict adjacency, scan forward from each label
  // occurrence for the first in-range decimal number.
  const latHit = findNearbyLabeledValue(text, LAT_KEYWORDS, false);
  const lonHit = findNearbyLabeledValue(text, LON_KEYWORDS, true);
  if (latHit && lonHit) {
    const start = Math.min(latHit.index, lonHit.index);
    const end = Math.max(latHit.index + latHit.length, lonHit.index + lonHit.length);
    add(latHit.value, lonHit.value, start, end - start);
  }

  // 11. Japan Plane Rectangular Coordinate System (平面直角座標系) — a genuinely
  // different coordinate system (meters from one of 19 zone origins, not
  // degrees) that appears in some bridge/civil-engineering inspection forms.
  const planeRect = findPlaneRectangularCoords(text);
  if (planeRect) {
    add(planeRect.lat, planeRect.lng, planeRect.index, planeRect.length);
  }

  // 12. Hyphen degree/minute anchor with seconds split into a separate table
  const dashDms = findDashSplitDms(text);
  if (dashDms) {
    add(dashDms.lat, dashDms.lng, dashDms.index, dashDms.length);
  }

  return results.slice(0, 10);
}

const PLANE_RECT_LABEL = '平面直角座標系';
const PLANE_RECT_ZONE_WINDOW = 30;
// X and Y aren't necessarily adjacent to "X座標"/"Y座標" labels in flattened
// multi-page tables — in the one real sample seen so far, those labels only
// appear once, far away, as a header for an unrelated table, while X sits
// immediately after the zone label and Y is ~2000 characters further along
// with no label near it at all. A generous forward window covers this.
const PLANE_RECT_SEARCH_WINDOW = 5000;
// Both known values have a 5-digit integer part and exactly 4 decimal
// places (31236.4333 / -46496.4082) — distinctive enough that nothing else
// in a typical inspection form (dates, percentages, mm dimensions) matches.
const COORD_LIKE_NUMBER_RE = /-?\d{2,6}\.\d{3,}/g;
// Documents write the zone as a single Unicode roman-numeral glyph (Ⅶ), but
// NFKC normalization (applied above, needed for full-width digits) silently
// decomposes that into plain Latin letters — "Ⅶ" becomes "VII" — before this
// ever runs. Match the Latin-letter form directly rather than the glyph.
const ROMAN_TO_ZONE = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10,
  XI: 11, XII: 12, XIII: 13, XIV: 14, XV: 15, XVI: 16, XVII: 17, XVIII: 18, XIX: 19,
};
const ZONE_TOKEN_RE = /([IVX]+|\d{1,2})\s*系/;

function parseZoneToken(token) {
  if (/^\d+$/.test(token)) {
    const n = parseInt(token, 10);
    return (n >= 1 && n <= 19) ? n : null;
  }
  return ROMAN_TO_ZONE[token] || null;
}

function findPlaneRectangularCoords(text) {
  const zoneIdx = text.indexOf(PLANE_RECT_LABEL);
  if (zoneIdx === -1) return null;

  const zoneWindow = text.slice(zoneIdx, zoneIdx + PLANE_RECT_LABEL.length + PLANE_RECT_ZONE_WINDOW);
  const zoneMatch = ZONE_TOKEN_RE.exec(zoneWindow);
  const zone = zoneMatch ? parseZoneToken(zoneMatch[1]) : null;
  if (!zone) return null;

  const searchStart = zoneIdx + PLANE_RECT_LABEL.length;
  const window = text.slice(searchStart, searchStart + PLANE_RECT_SEARCH_WINDOW);
  const numRe = new RegExp(COORD_LIKE_NUMBER_RE.source, 'g');
  const hits = [];
  let m;
  while (hits.length < 2 && (m = numRe.exec(window)) !== null) {
    hits.push({ value: parseFloat(m[0]), index: searchStart + m.index, length: m[0].length });
  }
  if (hits.length < 2) return null;

  const [x, y] = hits;
  const latLon = planeRectangularToLatLon(x.value, y.value, zone);
  if (!latLon) return null;

  return { lat: latLon.lat, lng: latLon.lng, index: x.index, length: (y.index + y.length) - x.index };
}

const LABEL_PROXIMITY_WINDOW = 300;
const PROXIMITY_NUMBER_RE = /\d{1,4}\.\d{3,}/g;

// Scans forward from every occurrence of any keyword in `keywords` for the
// nearest number (within LABEL_PROXIMITY_WINDOW chars) that falls in the
// valid lat/lon range for Japan — skipping occurrences with nothing nearby
// (many pages repeat the label with no value, e.g. a blank template row).
function findNearbyLabeledValue(text, keywords, isLon) {
  const [lo, hi] = isLon ? [LNG_MIN, LNG_MAX] : [LAT_MIN, LAT_MAX];
  for (const kw of keywords) {
    let searchFrom = 0;
    let kwIndex;
    while ((kwIndex = text.indexOf(kw, searchFrom)) !== -1) {
      searchFrom = kwIndex + kw.length;
      const window = text.slice(searchFrom, searchFrom + LABEL_PROXIMITY_WINDOW);
      const numRe = new RegExp(PROXIMITY_NUMBER_RE.source, 'g');
      let m;
      while ((m = numRe.exec(window)) !== null) {
        const value = parseFloat(m[0]);
        if (value >= lo && value <= hi) {
          return { value, index: searchFrom + m.index, length: m[0].length };
        }
      }
    }
  }
  return null;
}

// Japanese government inspection forms store coordinates as compact DMS
// numbers (DDMMSS.S / DDDMMSS.S) in the cell next to a 緯度/経度 label,
// not as plain decimal or standard DMS text — the generic regex patterns
// above can't see this until it's normalized into a "緯度: / 経度:" line.
const LAT_KEYWORDS = ['緯度', '北緯'];
const LON_KEYWORDS = ['経度', '東経'];
const LAT_COMPACT_MIN = 240000, LAT_COMPACT_MAX = 465959;   // 24°-46°N
const LON_COMPACT_MIN = 1230000, LON_COMPACT_MAX = 1545959; // 123°-154°E

function normalizeLabel(s) {
  return s.replace(/[ 　]/g, '').trim();
}

function compactDmsToDecimal(value, isLon) {
  const [lo, hi] = isLon ? [LON_COMPACT_MIN, LON_COMPACT_MAX] : [LAT_COMPACT_MIN, LAT_COMPACT_MAX];
  if (value < lo || value > hi) return null;

  const intPart = Math.trunc(value);
  const fracPart = value - intPart;
  const deg = isLon ? Math.trunc(intPart / 10000) : Math.trunc(intPart / 10000);
  const min = Math.trunc((intPart % 10000) / 100);
  const sec = (intPart % 100) + fracPart;

  return Math.round((deg + min / 60 + sec / 3600) * 1e6) / 1e6;
}

// Some inspection forms store the value next to the label as a plain decimal
// degree (e.g. 35.397777) instead of compact DMS — try that first since its
// range never overlaps compact DMS (24-46 / 122-154 vs 240000+ / 1230000+).
function inJapanRange(value, isLon) {
  const [lo, hi] = isLon ? [LNG_MIN, LNG_MAX] : [LAT_MIN, LAT_MAX];
  return value >= lo && value <= hi;
}

function numberToDecimal(value, isLon) {
  if (inJapanRange(value, isLon)) return value;
  return compactDmsToDecimal(value, isLon);
}

// Other forms store the value as a formatted DMS string in the cell itself,
// e.g. 36° 58' 18.68" — no direction letter, since it's implied by which
// label (緯度/経度) the cell sits next to. Straight and curly prime/quote
// marks both appear in practice depending on how the form was typed.
const DMS_STRING_RE = /^\s*(\d+)[°˚]\s*(\d+)[′']\s*([\d.]+)(?:[″"]|[′']{2})?\s*$/;

function dmsStringToDecimal(str, isLon) {
  const m = DMS_STRING_RE.exec(str);
  if (!m) return null;
  const decimal = parseFloat(m[1]) + parseFloat(m[2]) / 60 + parseFloat(m[3]) / 3600;
  return inJapanRange(decimal, isLon) ? decimal : null;
}

function adjacentValueToDecimal(rawValue, isLon) {
  if (typeof rawValue === 'number') return numberToDecimal(rawValue, isLon);
  return dmsStringToDecimal(String(rawValue), isLon);
}

function findCoordsByLabel(workbook) {
  for (const sheet of workbook.worksheets) {
    let latVal = null, lonVal = null;

    for (const row of sheet._rows || []) {
      if (!row) continue;
      for (const cell of row._cells || []) {
        if (!cell || cell.value === null || cell.value === undefined) continue;
        const label = normalizeLabel(String(cell.value));

        const isLat = LAT_KEYWORDS.some(k => label.includes(k));
        const isLon = LON_KEYWORDS.some(k => label.includes(k));
        if (!isLat && !isLon) continue;

        // scan the 5 cells to the right for the first parseable value
        // (plain number, compact-DMS number, or a "36° 58' 18.68"" DMS string)
        for (let offset = 1; offset <= 5; offset++) {
          const adj = sheet.getCell(cell.row, cell.col + offset);
          if (adj.value === null || adj.value === undefined) continue;
          const decimal = adjacentValueToDecimal(adj.value, isLon);
          if (decimal === null) continue;
          if (isLat) latVal = decimal; else lonVal = decimal;
          break;
        }

        if (latVal !== null && lonVal !== null) return { lat: latVal, lng: lonVal };
      }
    }
  }
  return null;
}

async function extractExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const coords = findCoordsByLabel(workbook);

  const texts = [];
  for (const sheet of workbook.worksheets) {
    sheet.eachRow(row => {
      row.eachCell(cell => {
        if (cell.value !== null && cell.value !== undefined) {
          const s = String(cell.value).trim();
          if (s) texts.push(s);
        }
      });
    });
  }

  const flatText = texts.join('\n');
  if (coords) {
    return `緯度: ${coords.lat.toFixed(6)}\n経度: ${coords.lng.toFixed(6)}\n${flatText}`;
  }
  return flatText;
}

async function extractText(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (ext === '.pdf') {
    // pdf-parse v2 replaced the old callable-function API with a class
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  if (ext === '.xlsx' || ext === '.xls') {
    return extractExcel(buffer);
  }

  return buffer.toString('utf-8');
}

// multer/busboy decode multipart filenames as latin1 by default, but browsers
// send them as UTF-8 — reversing the (mis)decoding recovers the original bytes.
// A no-op for pure-ASCII names, so this is always safe to apply.
function fixFilenameEncoding(name) {
  return Buffer.from(name, 'latin1').toString('utf8');
}

// OCR fallback for image-based PDFs (scanned documents, or coordinate info
// baked into a diagram rather than the text layer) that pdf-parse extracts
// nothing usable from. Capped at OCR_MAX_PAGES and stops at the first page
// that yields a real coordinate match — Gemini's free tier is generous
// (1,500 requests/day) but there's no reason to burn extra calls once an
// answer is found, and the location info has consistently shown up on an
// early page in every real document seen so far.
const OCR_MAX_PAGES = 3;

// Returns the OCR'd text alongside any coordinates found so the caller can
// still show the user what was actually read off the page — including when
// no coordinate matched, since OCR misreads are exactly when a user most
// needs to see the raw transcription to spot the problem themselves.
async function ocrFallbackCoordinates(buffer) {
  if (!isGeminiConfigured()) return { coordinates: [], text: '' };
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: buffer });
  try {
    const info = await parser.getInfo();
    const pageCount = Math.min(OCR_MAX_PAGES, info.total || 1);
    const pageNumbers = Array.from({ length: pageCount }, (_, i) => i + 1);
    const screenshots = await parser.getScreenshot({ partial: pageNumbers });

    const pageTexts = [];
    for (const page of screenshots.pages) {
      if (!page.data) continue;
      const base64 = Buffer.from(page.data).toString('base64');
      const text = await ocrImageToText(base64);
      if (!text) continue;
      pageTexts.push(text);
      const coords = extractCoordinates(text);
      if (coords.length > 0) return { coordinates: coords, text };
    }
    return { coordinates: [], text: pageTexts.join('\n\n---\n\n') };
  } catch {
    return { coordinates: [], text: '' };
  } finally {
    await parser.destroy();
  }
}

router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'ファイルが選択されていません' });

  const filename = fixFilenameEncoding(req.file.originalname);

  try {
    const text = await extractText(req.file.buffer, filename);
    let coordinates = extractCoordinates(text);
    let extractedText = text;

    if (coordinates.length === 0 && path.extname(filename).toLowerCase() === '.pdf') {
      const ocrResult = await ocrFallbackCoordinates(req.file.buffer);
      coordinates = ocrResult.coordinates;
      if (ocrResult.text) extractedText = ocrResult.text;
    }

    res.json({ coordinates, filename, extractedText });
  } catch (err) {
    console.error('documentParse error:', err.message);
    res.status(500).json({ error: `ファイルの解析に失敗しました: ${err.message}` });
  }
});

module.exports = router;
module.exports.extractCoordinates = extractCoordinates;
module.exports.extractText = extractText;
