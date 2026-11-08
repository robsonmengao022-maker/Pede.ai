'use strict';
// Distância em linha reta e geocodificação (OpenStreetMap / Nominatim, gratuito, ~1 consulta por segundo).
const GEOCODER_URL = process.env.GEOCODER_URL || 'https://nominatim.openstreetmap.org/search';
const MAX_KM = 15;
const cache = new Map();
let chain = Promise.resolve();
let lastCall = 0;

function haversineKm(a, b) {
  const R = 6371, rad = d => d * Math.PI / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Arredonda pra cima: 0,3 km conta como 1 km.
const kmFromPoints = (a, b) => Math.max(1, Math.ceil(haversineKm(a, b)));

// Lista de 15 posições (1 km ... 15 km). null = não entrega nessa distância.
function parseFees(raw) {
  let arr;
  try { arr = typeof raw === 'string' ? JSON.parse(raw || 'null') : raw; } catch { return null; }
  if (!Array.isArray(arr) || arr.length !== MAX_KM) return null;
  if (!arr.every(v => v === null || (typeof v === 'number' && v >= 0))) return null;
  if (!arr.some(v => v !== null)) return null;
  return arr;
}

function throttled(fn) {
  const run = chain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastCall));
    if (wait) await new Promise(r => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  chain = run.catch(() => {});
  return run;
}

async function geocode(query) {
  const key = query.trim().toLowerCase();
  if (!key) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 864e5) return hit.point;
  let point = null;
  try {
    point = await throttled(async () => {
      const url = `${GEOCODER_URL}?format=json&limit=1&countrycodes=br&q=${encodeURIComponent(query)}`;
      const r = await fetch(url, { headers: { 'User-Agent': 'Pedeai/1.0 (plataforma de delivery)', 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json();
      return j[0] ? { lat: Number(j[0].lat), lng: Number(j[0].lon) } : null;
    });
  } catch { return null; }
  if (point) cache.set(key, { point, at: Date.now() });
  return point;
}

module.exports = { geocode, haversineKm, kmFromPoints, parseFees, MAX_KM };
