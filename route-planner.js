(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const OSRM = 'https://router.project-osrm.org/route/v1/driving/';
  const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
  let currentOrigin = null, lastRoute = null, tripLayer = null, previewMap = null, routeMarkers = null;
  let googleMap = null, googlePolyline = null, googleMarkers = [], googleTrafficLayer = null, googleScriptPromise = null;
  const GOOGLE_KEY_STORE='rastro-google-maps-key-v1';
  const fmtCLP = n => '$' + Math.round(n).toLocaleString('es-CL');
  const FUEL_KEY = 'rastro-fuel-settings-v1';
  function fuelSettings() { return { type: $('fuelType')?.value || 'gasolina93', price: Number($('fuelPrice')?.value), efficiency: Number($('fuelEfficiency')?.value) }; }
  function fuelCost(km) { const f=fuelSettings(); if (!(f.price>0) || !(f.efficiency>0)) return null; return f.type==='electric' ? km*f.efficiency/100*f.price : km/f.efficiency*f.price; }
  window.rastroFuelCost = fuelCost;
  window.rastroUpdateLiveCosts = function(km) {
    if (!Number.isFinite(km)) { const raw=$('distance')?.textContent||'0'; km=Number(raw.replace(/[^0-9,.]/g,'').replace(/\./g,'').replace(',','.'))||0; }
    const fuel=fuelCost(km), toll=Number(window.rastroCurrentTripTolls||0);
    const tagsReady=window.rastroTollDataLoaded===true; $('liveFuelCost').textContent=fuel===null?'—':fmtCLP(fuel); $('liveTollCost').textContent=tagsReady?fmtCLP(toll):'—'; $('liveTripCost').textContent=fuel===null||!tagsReady?'—':fmtCLP(fuel+toll);
  };
  function updateFuelUnits() { const electric=$('fuelType').value==='electric'; $('fuelPriceUnit').textContent=electric?'kWh':'litro'; $('fuelEfficiencyUnit').textContent=electric?'kWh/100 km':'km/L'; }
  function saveFuel() { localStorage.setItem(FUEL_KEY,JSON.stringify(fuelSettings())); updateFuelUnits(); if(lastRoute)showTolls(routeTolls(lastRoute.route),lastRoute.route,lastRoute.origin,lastRoute.destination); window.rastroUpdateLiveCosts?.(); }
  const fmtKm = n => (n / 1000).toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' km';
  const formatDuration = seconds => {
    const mins = Math.round(seconds / 60), hours = Math.floor(mins / 60), rem = mins % 60;
    return hours ? `${hours} h ${rem} min` : `${Math.max(1, rem)} min`;
  };
  function loadGoogleMaps(key) {
    if (window.google?.maps) return Promise.resolve();
    if (googleScriptPromise) return googleScriptPromise;
    googleScriptPromise=new Promise((resolve,reject)=>{
      window.__rastroGoogleMapsReady=resolve;
      const script=document.createElement('script'); script.async=true; script.defer=true;
      script.src='https://maps.googleapis.com/maps/api/js?key='+encodeURIComponent(key)+'&callback=__rastroGoogleMapsReady';
      script.onerror=()=>reject(new Error('Google Maps no cargó. Revisa la clave, facturación y restricciones del dominio.'));
      document.head.appendChild(script);
    });
    return googleScriptPromise;
  }
  async function renderRoutePreview(route, origin, destination) {
    const box=$('planMap'); box.classList.add('visible');
    const key=localStorage.getItem(GOOGLE_KEY_STORE);
    if (key) {
      $('trafficStatus').textContent='Cargando mapa y tráfico de Google…';
      try {
        await loadGoogleMaps(key);
        if (previewMap) { previewMap.remove(); previewMap=null; }
        if (!googleMap) googleMap=new google.maps.Map(box,{center:{lat:origin.lat,lng:origin.lon},zoom:7,mapTypeControl:false,streetViewControl:false});
        if (googlePolyline) googlePolyline.setMap(null); googleMarkers.forEach(m=>m.setMap(null)); googleMarkers=[];
        const path=route.geometry.coordinates.map(c=>({lat:c[1],lng:c[0]}));
        googlePolyline=new google.maps.Polyline({path,strokeColor:'#147b49',strokeOpacity:.95,strokeWeight:6,map:googleMap});
        googleMarkers.push(new google.maps.Marker({position:{lat:origin.lat,lng:origin.lon},map:googleMap,title:'Partida: '+origin.label}));
        googleMarkers.push(new google.maps.Marker({position:{lat:destination.lat,lng:destination.lon},map:googleMap,title:'Destino: '+destination.label}));
        if (!googleTrafficLayer) googleTrafficLayer=new google.maps.TrafficLayer(); googleTrafficLayer.setMap(googleMap);
        const bounds=new google.maps.LatLngBounds(); path.forEach(p=>bounds.extend(p)); googleMap.fitBounds(bounds);
        $('trafficStatus').textContent='Tráfico de Google activo. La cobertura puede variar según la zona.';
        setTimeout(()=>google.maps.event.trigger(googleMap,'resize'),80); box.scrollIntoView({behavior:'smooth',block:'nearest'}); return;
      } catch (error) { $('trafficStatus').textContent=error.message; }
    }
    if (!window.L) { box.textContent='No se pudo cargar el mapa de vista previa.'; return; }
    if (googleMap) { googleMap=null; box.replaceChildren(); }
    if (!previewMap) {
      previewMap=L.map(box,{zoomControl:true,scrollWheelZoom:false}).setView([origin.lat,origin.lon],7);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(previewMap);
    }
    if (tripLayer) tripLayer.remove(); if (routeMarkers) routeMarkers.remove();
    tripLayer=L.geoJSON(route.geometry,{style:{color:'#41b975',weight:6,opacity:.95}}).addTo(previewMap);
    routeMarkers=L.featureGroup([
      L.marker([origin.lat,origin.lon]).bindTooltip('Partida: '+origin.label),
      L.marker([destination.lat,destination.lon]).bindTooltip('Destino: '+destination.label)
    ]).addTo(previewMap);
    previewMap.fitBounds(tripLayer.getBounds(),{padding:[24,24]});
    setTimeout(()=>previewMap.invalidateSize(),80);
    box.scrollIntoView({behavior:'smooth',block:'nearest'});
  }
  function setStatus(message, error = false) {
    const el = $('planStatus'); el.textContent = message; el.classList.toggle('error', error);
  }
  function getCurrentLocation() {
    if (!navigator.geolocation) return setStatus('Este navegador no permite obtener la ubicación.', true);
    setStatus('Buscando tu ubicación…');
    navigator.geolocation.getCurrentPosition(pos => {
      currentOrigin = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Mi ubicación actual' };
      $('originPlace').value = 'Mi ubicación actual';
      setStatus('Origen GPS fijado. Escribe el destino y calcula la ruta.');
    }, err => setStatus(err.code === 1 ? 'Permite la ubicación para usarla como origen.' : 'No se pudo obtener la ubicación GPS.', true), { enableHighAccuracy: true, timeout: 15000 });
  }
  async function geocode(query) {
    const url = `${NOMINATIM}?format=jsonv2&countrycodes=cl&limit=1&accept-language=es&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'default' });
    if (!res.ok) throw new Error('No se pudo buscar esa dirección.');
    const results = await res.json();
    if (!results.length) throw new Error(`No encontré “${query}”. Prueba con dirección y comuna.`);
    return { lat: Number(results[0].lat), lon: Number(results[0].lon), label: results[0].display_name };
  }
  async function geocodePair() {
    const originText = $('originPlace').value.trim(), destinationText = $('destinationPlace').value.trim();
    if (!currentOrigin && !originText) throw new Error('Escribe una ubicación de partida o usa el GPS.');
    if (!destinationText) throw new Error('Escribe el destino.');
    let origin = currentOrigin;
    if (!origin) origin = await geocode(originText);
    await new Promise(resolve => setTimeout(resolve, 1100));
    const destination = await geocode(destinationText);
    return { origin, destination };
  }
  function bearing(a, b) {
    const rad = Math.PI / 180, y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
    const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  function haversine(a, b) {
    const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 12742000 * Math.asin(Math.sqrt(h));
  }
  function closestAlongRoute(point, coords) {
    let best = { distance: Infinity, along: 0, heading: null }, traversed = 0;
    const p = [point.lon, point.lat];
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i], length = haversine(a, b);
      const lat0 = (a[1] + b[1] + p[1]) / 3 * Math.PI / 180;
      const project = q => ({ x: (q[0] - p[0]) * Math.PI / 180 * Math.cos(lat0) * 6371000, y: (q[1] - p[1]) * Math.PI / 180 * 6371000 });
      const av = project(a), bv = project(b), dx = bv.x - av.x, dy = bv.y - av.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(av.x * dx + av.y * dy) / len2)) : 0;
      const d = Math.hypot(av.x + t * dx, av.y + t * dy);
      if (d < best.distance) best = { distance: d, along: traversed + length * t, heading: bearing(a, b) };
      traversed += length;
    }
    return best;
  }
  function routeTolls(route) {
    const points = window.rastroTollPoints || [], geometry = route.geometry.coordinates;
    const candidates = [];
    for (const p of points) {
      if (p.status !== 'active') continue;
      const nearest = closestAlongRoute(p, geometry);
      if (nearest.distance > 42) continue;
      const gate = p.gates?.reduce((best, g) => {
        const distance = closestAlongRoute({ lat: g.lat ?? p.lat, lon: g.lon ?? p.lon }, geometry).distance;
        return !best || distance < best.distance ? { g, distance } : best;
      }, null)?.g;
      if (gate && Number.isFinite(gate.heading) && !gate.bidirectional) {
        const delta = Math.abs(((nearest.heading - gate.heading + 540) % 360) - 180);
        if (delta > 95) continue;
      }
      candidates.push({ point: p, along: nearest.along, offset: nearest.distance });
    }
    candidates.sort((a, b) => a.along - b.along);
    const date = new Date(), direct = [], pending = [];
    for (const candidate of candidates) {
      const p = candidate.point, fee = window.rastroPriceFor?.(p, date);
      if (fee) {
        direct.push({ ...candidate, fee, label: p.name });
        continue;
      }
      let paired = false;
      for (const entry of pending) {
        if (entry.matched) continue;
        const pair = entry.point.pairs?.find(x => x.exit === p.id);
        if (!pair) continue;
        const pairFee = window.rastroPriceForPair?.(pair, date);
        direct.push({ ...candidate, fee: pairFee, label: `${entry.point.name} → ${p.name}` });
        paired = true; entry.matched = true; break;
      }
      if (!paired && p.pairs?.length) pending.push({ point: p, matched: false });
      else if (!paired) direct.push({ ...candidate, fee: null, label: p.name });
    }
    return direct;
  }
  function showTolls(items, route, origin, destination) {
    const box = $('planTolls'), priced = items.filter(x => Number.isFinite(x.fee?.amount));
    const total = priced.reduce((sum, x) => sum + x.fee.amount, 0);
    const date = new Date();
    const vehicle = $('vehicleClass').selectedOptions[0]?.textContent || 'Vehículo elegido';
    const labelKind = p => p.kind === 'portico' ? 'Pórtico' : p.kind === 'lateral' ? 'Peaje lateral' : 'Peaje troncal';
    const rows = items.length ? items.map(item => `<div class="plan-toll"><span>${item.label}<small>${window.rastroPaymentLabel?.(item.point) || 'TAG automático'} · ${labelKind(item.point)} · ${item.fee?.band || 'tarifa no publicada'} · ${Math.round(item.offset)} m de la ruta${item.fee ? '' : ' · no sumado al total'}</small></span><b>${item.fee ? fmtCLP(item.fee.amount) : '—'}</b></div>`).join('') : '<div class="plan-status">No se detectaron puntos de cobro en esta ruta.</div>';
    const km=route.distance/1000, fuel=fuelCost(km), tagsAvailable=window.rastroTollDataLoaded===true, combined=fuel===null||!tagsAvailable?null:total+fuel;
    $('planSummary').hidden=false;
    box.innerHTML = rows + `<div class="plan-total"><span>Total estimado de TAG</span><span>${tagsAvailable?fmtCLP(total):'Sin datos'}</span></div><div class="plan-total"><span>Combustible (${fmtKm(route.distance)})</span><span>${fuel===null?'Ingresa precio y rendimiento':fmtCLP(fuel)}</span></div><div class="plan-total"><span>Total estimado del viaje</span><span>${combined===null?'Completa valores / datos TAG':fmtCLP(combined)}</span></div>`;
    const meta = window.rastroTollMetadata;
    const from = meta?.validity?.from || '2026-01-01', to = meta?.validity?.to || '2026-12-31';
    $('planSource').textContent = `Consulta ${date.toLocaleString('es-CL')} · ${vehicle}. Tarifas de referencia ${from} a ${to}, fuentes DGC/MOP; ubicaciones OpenStreetMap. No reemplaza la boleta TAG. La ruta estima el recorrido más rápido, ${origin.label} → ${destination.label}.`;
  }
  async function calculate() {
    const button = $('calculateTrip'); button.disabled = true;
    $('openWaze').hidden=true; $('wazeNote').hidden=true;
    $('planSummary').hidden = true; $('planTolls').innerHTML = ''; $('planSource').textContent = '';
    setStatus('Buscando ubicaciones…');
    try {
      const { origin, destination } = await geocodePair();
      setStatus('Calculando ruta por carretera…');
      const url = `${OSRM}${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=full&geometries=geojson&alternatives=false`;
      const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'default' });
      if (!response.ok) throw new Error('No se pudo calcular la ruta. Revisa las ubicaciones o inténtalo de nuevo.');
      const data = await response.json();
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No encontré una ruta en carretera entre esos puntos.');
      lastRoute = { route: data.routes[0], origin, destination };
      const wazeUrl=new URL('https://waze.com/ul');
      wazeUrl.searchParams.set('ll',`${destination.lat},${destination.lon}`); wazeUrl.searchParams.set('navigate','yes'); wazeUrl.searchParams.set('utm_source','rastro-tracker');
      $('openWaze').href=wazeUrl.toString(); $('openWaze').hidden=false; $('wazeNote').hidden=false;
      $('tripDistance').textContent = fmtKm(data.routes[0].distance);
      $('tripDuration').textContent = formatDuration(data.routes[0].duration);
      $('planSummary').hidden = false;
      await renderRoutePreview(data.routes[0], origin, destination);
      const dataPromise = window.rastroTollDataReady;
      if (dataPromise) await dataPromise;
      if (window.rastroTollPoints?.length) {
        showTolls(routeTolls(data.routes[0]), data.routes[0], origin, destination);
        setStatus('Ruta lista. El mapa muestra el trayecto y el total resume los TAG detectados.');
      } else {
        showTolls([], data.routes[0], origin, destination);
        setStatus('Distancia y combustible calculados. No se pudo cargar la base de tarifas TAG.', true);
      }
    } catch (err) {
      setStatus(err.message || 'Ocurrió un error al calcular el viaje.', true);
    } finally { button.disabled = false; }
  }
  $('originPlace').addEventListener('input', () => { currentOrigin = null; });
  $('useCurrentLocation').addEventListener('click', getCurrentLocation);
  $('calculateTrip').addEventListener('click', calculate);
  $('destinationPlace').addEventListener('keydown', e => { if (e.key === 'Enter') calculate(); });
  $('vehicleClass').addEventListener('change', () => {
    if (lastRoute && window.rastroTollPoints?.length) showTolls(routeTolls(lastRoute.route), lastRoute.route, lastRoute.origin, lastRoute.destination);
  });
  const savedGoogleKey=localStorage.getItem(GOOGLE_KEY_STORE); if(savedGoogleKey)$('googleMapsApiKey').value=savedGoogleKey;
  $('saveTrafficKey').addEventListener('click',()=>{const key=$('googleMapsApiKey').value.trim();if(!key){localStorage.removeItem(GOOGLE_KEY_STORE);$('trafficStatus').textContent='Clave eliminada. Se usará el mapa normal.';return;}localStorage.setItem(GOOGLE_KEY_STORE,key);$('trafficStatus').textContent=lastRoute?'Activando tráfico de Google…':'Clave guardada. Calcula la ruta para ver la capa de tráfico.';if(lastRoute)renderRoutePreview(lastRoute.route,lastRoute.origin,lastRoute.destination);});
  try { const saved=JSON.parse(localStorage.getItem(FUEL_KEY)||'null'); if(saved){$('fuelType').value=saved.type==='gasolina'?'gasolina93':(saved.type||'gasolina93');$('fuelPrice').value=saved.price||'';$('fuelEfficiency').value=saved.efficiency||'';} } catch {}
  $('fuelType').addEventListener('change',saveFuel); $('fuelPrice').addEventListener('input',saveFuel); $('fuelEfficiency').addEventListener('input',saveFuel); updateFuelUnits(); window.rastroUpdateLiveCosts(0);
  setInterval(() => window.rastroUpdateLiveCosts(), 1000);
})();
