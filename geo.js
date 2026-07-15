// Vanilla JS WGS84 UTM <-> Lat/Lon <-> MGRS conversion
// No external dependencies - self-contained for offline use.

const GeoConv = (function () {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const e2p = e2 / (1 - e2); // e'^2
  const k0 = 0.9996;

  function deg2rad(d) { return (d * Math.PI) / 180; }
  function rad2deg(r) { return (r * 180) / Math.PI; }

  function zoneFromLonLat(lon, lat) {
    // Standard zones, with Norway/Svalbard exceptions
    let zone = Math.floor((lon + 180) / 6) + 1;
    if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32; // Norway
    if (lat >= 72 && lat < 84) {
      if (lon >= 0 && lon < 9) zone = 31;
      else if (lon >= 9 && lon < 21) zone = 33;
      else if (lon >= 21 && lon < 33) zone = 35;
      else if (lon >= 33 && lon < 42) zone = 37;
    }
    return zone;
  }

  function latLonToUTM(lat, lon, zoneOverride) {
    const zone = zoneOverride || zoneFromLonLat(lon, lat);
    const latRad = deg2rad(lat);
    const lonRad = deg2rad(lon);
    const lonOrigin = deg2rad(zone * 6 - 183);

    const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
    const T = Math.tan(latRad) ** 2;
    const C = e2p * Math.cos(latRad) ** 2;
    const A = Math.cos(latRad) * (lonRad - lonOrigin);

    const M =
      a *
      ((1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256) * latRad -
        ((3 * e2) / 8 + (3 * e2 * e2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * latRad) +
        ((15 * e2 * e2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * latRad) -
        ((35 * e2 ** 3) / 3072) * Math.sin(6 * latRad));

    let easting =
      k0 *
        N *
        (A +
          ((1 - T + C) * A ** 3) / 6 +
          ((5 - 18 * T + T * T + 72 * C - 58 * e2p) * A ** 5) / 120) +
      500000.0;

    let northing =
      k0 *
      (M +
        N *
          Math.tan(latRad) *
          ((A * A) / 2 +
            ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
            ((61 - 58 * T + T * T + 600 * C - 330 * e2p) * A ** 6) / 720));

    if (lat < 0) northing += 10000000.0;

    return { easting, northing, zone, hemisphere: lat < 0 ? 'S' : 'N' };
  }

  function utmToLatLon(easting, northing, zone, hemisphere) {
    const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    const x = easting - 500000.0;
    let y = northing;
    if (hemisphere === 'S') y -= 10000000.0;

    const lonOrigin = zone * 6 - 183;
    const M = y / k0;
    const mu = M / (a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 ** 3) / 256));

    const phi1 =
      mu +
      ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
      ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
      ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
      ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

    const N1 = a / Math.sqrt(1 - e2 * Math.sin(phi1) ** 2);
    const T1 = Math.tan(phi1) ** 2;
    const C1 = e2p * Math.cos(phi1) ** 2;
    const R1 = (a * (1 - e2)) / Math.pow(1 - e2 * Math.sin(phi1) ** 2, 1.5);
    const D = x / (N1 * k0);

    let lat =
      phi1 -
      ((N1 * Math.tan(phi1)) / R1) *
        ((D * D) / 2 -
          ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * e2p) * D ** 4) / 24 +
          ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * e2p - 3 * C1 * C1) * D ** 6) / 720);

    let lon =
      (D -
        ((1 + 2 * T1 + C1) * D ** 3) / 6 +
        ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * e2p + 24 * T1 * T1) * D ** 5) / 120) /
      Math.cos(phi1);

    lat = rad2deg(lat);
    lon = lonOrigin + rad2deg(lon);

    return { lat, lon };
  }

  // ---- MGRS ----
  const LAT_BANDS = 'CDEFGHJKLMNPQRSTUVWXX'; // X covers 72-84 (12 deg)

  function latBandLetter(lat) {
    if (lat < -80 || lat > 84) return null;
    if (lat === 84) return 'X';
    const idx = Math.floor((lat + 80) / 8);
    return LAT_BANDS[Math.min(idx, 20)];
  }

  // 100km square ID lookup tables (standard MGRS/USNG algorithm, set repeats every 6 zones)
  const E100K = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
  const N100K = ['ABCDEFGHJKLMNPQRSTUV', 'FGHJKLMNPQRSTUVABCDE'];

  function get100kSetForZone(zone) {
    let s = zone % 6;
    if (s === 0) s = 6;
    return s;
  }

  function get100kID(easting, northing, zone) {
    const setNum = get100kSetForZone(zone);
    const setBlock1 = ((setNum - 1) % 3); // 0,1,2 -> which column alphabet
    const colLetters = E100K[setBlock1];
    const rowLetters = N100K[setNum % 2 === 1 ? 0 : 1];

    const col = Math.floor(easting / 100000) - 1; // easting 100000-900000 -> col 0-7
    let row = Math.floor(northing / 100000) % 20;
    if (row < 0) row += 20;

    const colLetter = colLetters[col];
    const rowLetter = rowLetters[row];
    return colLetter + rowLetter;
  }

  function toMGRS(lat, lon, precision) {
    precision = precision === undefined ? 5 : precision; // digits per axis (5 = 1m)
    const utm = latLonToUTM(lat, lon);
    const band = latBandLetter(lat);
    const sq = get100kID(utm.easting, utm.northing, utm.zone);

    const eStr = String(Math.floor(utm.easting % 100000)).padStart(5, '0').substring(0, precision);
    const nStr = String(Math.floor(utm.northing % 100000)).padStart(5, '0').substring(0, precision);

    const zoneStr = String(utm.zone).padStart(2, '0');
    return `${zoneStr}${band}${sq}${eStr}${nStr}`;
  }

  function parseMGRS(mgrsStr) {
    mgrsStr = mgrsStr.toUpperCase().replace(/\s+/g, '');
    const m = mgrsStr.match(/^(\d{1,2})([C-HJ-NP-X])([A-Z]{2})(\d+)$/);
    if (!m) throw new Error('Invalid MGRS string');
    const zone = parseInt(m[1], 10);
    const band = m[2];
    const sq = m[3];
    const digits = m[4];
    const half = digits.length / 2;
    if (!Number.isInteger(half)) throw new Error('Invalid MGRS numeric part');
    const precision = half;
    const eDigits = digits.substring(0, half);
    const nDigits = digits.substring(half);
    const scale = Math.pow(10, 5 - precision);
    const eWithin100k = parseInt(eDigits, 10) * scale;
    const nWithin100k = parseInt(nDigits, 10) * scale;

    const hemisphere = 'CDEFGHJKLM'.includes(band) ? 'S' : 'N';

    const setNum = get100kSetForZone(zone);
    const setBlock1 = (setNum - 1) % 3;
    const colLetters = E100K[setBlock1];
    const rowLetters = N100K[setNum % 2 === 1 ? 0 : 1];

    const col = colLetters.indexOf(sq[0]);
    const rowBase = rowLetters.indexOf(sq[1]);
    if (col < 0 || rowBase < 0) throw new Error('Invalid MGRS 100km square id for this zone');

    const easting = (col + 1) * 100000 + eWithin100k;

    // Determine northing: rowBase repeats every 2,000,000m (20 rows * 100,000m).
    // Find the multiple of 2,000,000 that puts the point in the correct latitude band.
    const bandIdx = LAT_BANDS.indexOf(band);
    const bandMinLat = bandIdx * 8 - 80;

    let northing = null;
    for (let k = -2; k <= 12; k++) {
      const candidateRowStart = (rowBase + 20 * k) * 100000;
      const candidateNorthing = candidateRowStart + nWithin100k;
      const ll = utmToLatLon(easting, hemisphere === 'S' ? (candidateNorthing < 0 ? candidateNorthing + 10000000 : candidateNorthing) : candidateNorthing, zone, hemisphere);
      // check if within ~8 degree band (with margin)
      if (ll.lat >= bandMinLat - 0.2 && ll.lat < bandMinLat + 8.2) {
        northing = hemisphere === 'S' && candidateNorthing < 0 ? candidateNorthing + 10000000 : candidateNorthing;
        break;
      }
    }
    if (northing === null) throw new Error('Could not resolve MGRS northing to latitude band');

    const result = utmToLatLon(easting, northing, zone, hemisphere);
    return { lat: result.lat, lon: result.lon, zone, band, sq, easting, northing, hemisphere };
  }

  return { latLonToUTM, utmToLatLon, toMGRS, parseMGRS, zoneFromLonLat };
})();

if (typeof module !== 'undefined') module.exports = GeoConv;
