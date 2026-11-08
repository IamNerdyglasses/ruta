(() => {
  'use strict';
  const DATA_URL = 'https://tiles.drometra.com/releases/p20/20260922T192344Z-654ab56aa89d8207/chile/peajes/chile-peajes.json';
  const DATA_LABEL = 'MOP/DGC 2026 · ubicaciones OpenStreetMap · registro publicado 22-09-2026';
  const STORE = 'rastro-tolls-v1';
  const VEHICLE_KEY = 'rastro-vehicle-class-v1';
  const CLASSES = [
    ['M', 'Moto / motoneta / cuatrimoto'], ['L', 'Auto / camioneta / station wagon'],
    ['LR', 'Auto o camioneta con remolque'], ['D', 'Camioneta doble rueda trasera'],
    ['B2', 'Bus de 2 ejes'], ['B3', 'Bus de más de 2 ejes'],
    ['C2', 'Camión de 2 ejes'], ['C3', 'Camión de más de 2 ejes'],
    ['CR', 'Camión con remolque'], ['SD', 'Sobredimensionado'], ['SDX', 'Sobredimensionado (tramo mayor)']
  ];
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let tollPoints = [], tollTotal = [], pendingEntries = [], running = false, previousFix = null;
  let lastPass = new Map(), dataReady = false, currentTripTolls = 0;
  const fmtCLP = n => '$' + Math.round(n).toLocaleString('es-CL');

  function load() { try { return JSON.parse(localStorage.getItem(STORE) || '[]'); } catch { return []; } }
  function persist() { localStorage.setItem(STORE, JSON.stringify(tollTotal)); }
  function vehicleCode() { return $('vehicleClass')?.value || 'L'; }
  function addUI() {
    const savedClass = localStorage.getItem(VEHICLE_KEY);
    if (savedClass && CLASSES.some(([c]) => c === savedClass)) $('vehicleClass').value = savedClass;
    $('vehicleClass').addEventListener('change', () => {
      localStorage.setItem(VEHICLE_KEY, vehicleCode());
      toast('Tipo de vehículo guardado');
    });
    renderTolls();
  }
  function status(text, ready = false) {
    const el = $('tollDataState');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('ready', ready);
  }
  function toast(text) {
    const el = $('toast');
    if (!el) return;
    el.textContent = text; el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 2600);
  }
  async function loadData() {
    try {
      let data;
      try {
        const res = await fetch(DATA_URL, { cache: 'default' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch {
        const proxy = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(DATA_URL);
        const res = await fetch(proxy, { cache: 'default' });
        if (!res.ok) throw new Error('No se pudo consultar la fuente de tarifas');
        data = await res.json();
      }
      tollPoints = (data.points || []).filter(p => p.status === 'active' && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      window.rastroTollPoints = tollPoints;
      window.rastroTollMetadata = data;
      window.rastroTollDataLoaded = true;
      dataReady = true;
      status(`${tollPoints.length} pórticos y peajes activos · tarifas ${data.validity?.from || '2026'} a ${data.validity?.to || '2026'} · ${DATA_LABEL}`, true);
    } catch (err) {
      status('No se pudo cargar la base de pórticos. Revisa la conexión e inténtalo de nuevo.');
    }
  }
  function distance(a, b) {
    const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  }
  function segmentDistance(a, b, p) {
    const rad = Math.PI / 180, lat0 = (a.lat + b.lat + p.lat) / 3 * rad;
    const xy = q => ({ x: (q.lon - a.lon) * rad * Math.cos(lat0) * 6371000, y: (q.lat - a.lat) * rad * 6371000 });
    const end = xy(b), target = xy(p), length2 = end.x * end.x + end.y * end.y;
    if (!length2) return { distance: distance(a, p), t: 0 };
    const t = Math.max(0, Math.min(1, (target.x * end.x + target.y * end.y) / length2));
    return { distance: Math.hypot(target.x - t * end.x, target.y - t * end.y), t };
  }
  function bearing(a, b) {
    const rad = Math.PI / 180, y = Math.sin((b.lon - a.lon) * rad) * Math.cos(b.lat * rad);
    const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lon - a.lon) * rad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function dayType(date) {
    const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Santiago', weekday: 'short' }).format(date);
    return day === 'Sun' ? 'domingo' : day === 'Sat' ? 'sabado' : 'laboral';
  }
  function chileTime(date) {
    return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Santiago', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
  }
  function bandFor(tariff, date) {
    const bands = tariff?.bands || [];
    if (!bands.length) return null;
    const day = dayType(date), now = chileTime(date);
    const schedule = tariff.schedule?.[day] || {};
    let selected = bands.find(b => b === 'normal') || bands[0];
    for (const band of ['TBFP', 'normal', 'TBP', 'TS']) {
      if (!bands.includes(band)) continue;
      const windows = schedule[band] || [];
      if (band === 'TBFP' && !bands.some(b => ['normal', 'TBP', 'TS'].includes(b))) selected = band;
      if (windows.some(w => {
        const [from, to] = w.split('-');
        return from <= to ? now >= from && now < to : now >= from || now < to;
      })) selected = band;
    }
    return selected;
  }
  function priceFor(point, date) {
    const tariff = point.tariff;
    if (!tariff) return null;
    const cls = vehicleCode(), band = bandFor(tariff, date);
    const raw = tariff.byClass?.[cls]?.[band];
    if (!Number.isFinite(raw)) return null;
    const multiplier = tariff.type === 'per_km' ? Number(point.lengthKm || 1) : 1;
    return { amount: raw * multiplier, band: band || 'normal', source: tariff.source || '' };
  }
  function priceForPair(pair, date) {
    const tariff = pair;
    if (!tariff?.byClass) return null;
    const band = bandFor(tariff, date), raw = tariff.byClass?.[vehicleCode()]?.[band];
    return Number.isFinite(raw) ? { amount: raw * (tariff.type === 'per_km' ? Number(pair.lengthKm || 1) : 1), band: band || 'normal', source: tariff.source || '' } : null;
  }
  // La base entrega categoría física, no modalidad confirmada de pago.
  // Solo marcar manual cuando la fuente lo indique expresamente; los demás
  // cobros se presentan como TAG automático según la preferencia del usuario.
  function paymentLabel(point) {
    const text = [point.payment, point.paymentMethod, point.collection, point.modality, point.payment_type]
      .filter(Boolean).join(' ').toLowerCase();
    return /manual|cash|efectivo/.test(text) ? 'Manual' : 'TAG automático';
  }
  window.rastroPaymentLabel = paymentLabel;
  window.rastroPriceFor = priceFor;
  window.rastroPriceForPair = priceForPair;
  window.rastroVehicleCode = vehicleCode;
  window.rastroCurrentTripTolls = 0;
  function renderTolls() {
    const list = $('tollLog');
    if (!list) return;
    if (!tollTotal.length) {
      list.className = 'toll-empty';
      list.textContent = running ? 'Buscando pasos probables por pórticos…' : 'Inicia un recorrido para registrar los pórticos cercanos.';
      $('tollSum').textContent = fmtCLP(0); return;
    }
    const sum = tollTotal.reduce((n, p) => n + (p.amount || 0), 0);
    $('tollSum').textContent = fmtCLP(sum);
    list.className = '';
    list.innerHTML = tollTotal.slice().reverse().map(p => `<div class="toll-item"><span class="ti"><strong>${esc(p.name)} · ${esc(p.payment || 'TAG automático')}</strong><small>${new Date(p.at).toLocaleString('es-CL')} · ${esc(p.vehicle)} · señal ±${esc(p.accuracy)} m${p.review ? ' · revisar' : ''}${p.band ? ' · ' + esc(p.band) : ''}</small></span><b>${p.amount == null ? 'Revisar' : fmtCLP(p.amount)}</b><button class="remove-toll" data-id="${esc(p.id)}" aria-label="Eliminar este paso">×</button></div>`).join('');
    list.querySelectorAll('.remove-toll').forEach(b => b.onclick = () => { tollTotal = tollTotal.filter(p => p.id !== b.dataset.id); persist(); renderTolls(); });
  }
  function recordPass(point, fix, d, price, label = '', highConfidence = false) {
    const at = new Date(fix.timestamp || Date.now());
    const event = {
      id: `${point.id}-${at.getTime()}`, pointId: point.id, name: label || point.name,
      at: at.toISOString(), amount: price?.amount == null ? null : Math.round(price.amount),
      band: price?.band || '', source: price?.source || '', vehicle: vehicleCode(), payment: paymentLabel(point),
      accuracy: fix.coords.accuracy || 0, distance: Math.round(d), review: !highConfidence
    };
    tollTotal.push(event); if (running && Number.isFinite(event.amount)) { currentTripTolls += event.amount; window.rastroCurrentTripTolls = currentTripTolls; window.rastroUpdateLiveCosts?.(); } persist(); renderTolls();
    toast(event.amount == null ? `Paso detectado: ${event.name}` : `${event.name}: ${fmtCLP(event.amount)} estimados`);
  }
  function processFix(fix) {
    const now = fix.timestamp || Date.now();
    const current = { lat: fix.coords.latitude, lon: fix.coords.longitude, at: now };
    if (previousFix && now > previousFix.at) {
      const elapsed = (now - previousFix.at) / 1000;
      const speed = distance(current, previousFix) / elapsed;
        const course = Number.isFinite(fix.coords.heading) ? fix.coords.heading : bearing(previousFix, current);
      if (speed >= 1.5 && speed <= 65 && elapsed <= 20 && (fix.coords.accuracy || 100) <= 35) {
        let nearest = null, nearDist = Infinity, highConfidence = false;
        for (const p of tollPoints) {
          if (p.status !== 'active') continue;
          const gate = (p.gates || []).reduce((best, g) => {
            const gd = distance(current, { lat: g.lat ?? p.lat, lon: g.lon ?? p.lon });
            return !best || gd < best.d ? { g, d: gd } : best;
          }, null);
          const spot = gate ? { lat: gate.g.lat ?? p.lat, lon: gate.g.lon ?? p.lon } : { lat: p.lat, lon: p.lon };
          const d = distance(current, spot), prevD = distance(previousFix, spot);
          const crossing = segmentDistance(previousFix, current, spot);
          const radius = Math.max(24, Math.min(38, (fix.coords.accuracy || 20) + 10));
          const crossed = crossing.distance <= radius && crossing.t > 0.03 && crossing.t < 0.97 && prevD > 18;
          if ((d <= radius && prevD > 18 || crossed) && Math.min(d, crossing.distance) < nearDist) {
            if (course != null && Number.isFinite(gate?.g?.heading)) {
              const delta = Math.abs(((course - gate.g.heading + 540) % 360) - 180);
              if (delta > 65 && !gate.g.bidirectional) continue;
            }
            nearest = p; nearDist = Math.min(d, crossing.distance);
            highConfidence = crossed && crossing.distance <= 15 && (fix.coords.accuracy || 99) <= 18;
          }
        }
        if (nearest && now - (lastPass.get(nearest.id) || 0) > 8 * 60 * 1000) {
          lastPass.set(nearest.id, now);
          const fee = priceFor(nearest, new Date(now));
          if (fee) {
            recordPass(nearest, fix, nearDist, fee, '', highConfidence);
          } else {
            let matched = false;
            const waiting = pendingEntries.filter(x => now - x.at < 4 * 60 * 60 * 1000);
            for (const entry of waiting) {
              const pair = entry.point.pairs?.find(x => x.exit === nearest.id);
              if (!pair || entry.point.id === nearest.id) continue;
              const pairedFee = priceForPair(pair, new Date(now));
              recordPass(nearest, fix, nearDist, pairedFee, `${entry.point.name} → ${nearest.name}`, highConfidence);
              pendingEntries = pendingEntries.filter(x => x !== entry);
              matched = true;
              break;
            }
            if (!matched && nearest.pairs?.length) pendingEntries.push({ point: nearest, fix, d: nearDist, at: now });
            else if (!matched) recordPass(nearest, fix, nearDist, null, '', highConfidence);
          }
        }
      }
    }
    previousFix = current;
  }
  function installGPSHook() {
    const geo = navigator.geolocation;
    if (!geo) return;
    try {
      const base = geo.watchPosition.bind(geo);
      Object.defineProperty(geo, 'watchPosition', {
        configurable: true,
        value: (success, error, options) => base(pos => { if (running && dataReady) processFix(pos); success(pos); }, error, options)
      });
    } catch {
      status('El navegador no permite conectar la detección GPS.');
    }
  }
  addUI();
  tollTotal = load();
  renderTolls();
  window.rastroTollDataReady = loadData();
  installGPSHook();
  $('start').addEventListener('click', () => {
    running = true; previousFix = null; pendingEntries = []; lastPass.clear(); currentTripTolls = 0; window.rastroCurrentTripTolls = 0; window.rastroUpdateLiveCosts?.(); renderTolls();
  }, true);
  $('finish').addEventListener('click', () => { running = false; previousFix = null; renderTolls(); }, true);
})();
