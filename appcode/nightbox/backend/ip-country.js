const fs = require('node:fs');
const net = require('node:net');
const { Reader } = require('maxmind');

// This CC0 country database is bundled with the backend image so view
// attribution does not depend on a remote lookup service or a client header.
const databasePath = require.resolve('@ip-location-db/geo-whois-asn-country-mmdb/geo-whois-asn-country.mmdb');
const reader = new Reader(fs.readFileSync(databasePath));

function ipCountry(ip) {
  const raw = String(ip || '').trim();
  const normalized = raw.startsWith('::ffff:') && net.isIP(raw.slice(7)) === 4 ? raw.slice(7) : raw;
  if (!net.isIP(normalized)) return 'ZZ';
  const country = reader.get(normalized)?.country_code;
  return /^[A-Z]{2}$/.test(country || '') ? country : 'ZZ';
}

module.exports = ipCountry;
