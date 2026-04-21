// ==========================================
// DRIVERWATCH — SMART ROUTE ADVISOR v2
// Data sources:
//  1. Community impact hotspots (Firestore — anonymized lat/lng, impact events only)
//  2. OSM road hazards via Overpass API (accidents, speed cameras, hazards)
//  3. OSM traffic data (signals, congestion, calming)
// Privacy: NO driver name / UID shared. Coordinates only.
// ==========================================

let dwMap = null;
let mapInitialized = false;
let userMarker = null;
let currentRouteLayer = null; // OSRM Path
let activeRouteData = null;   // Stored destination coords + instructions
let hazardLayers = [];   // OSM Overpass layers

function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (d) => (d * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
let communityLayers = []; // Firestore community layers
let hazardPoints = [];
let communityPoints = [];

let lastHazardFetchPos      = null;
let lastHazardFetchTime     = 0;
let lastCommunityFetchTime  = 0;
let lastProximityWarnTime   = 0;

const HAZARD_FETCH_COOLDOWN_MS     = 5 * 60 * 1000;  // 5 min
const COMMUNITY_FETCH_COOLDOWN_MS  = 10 * 60 * 1000; // 10 min
const PROXIMITY_WARN_RADIUS_M      = 600;
const PROXIMITY_WARN_COOLDOWN_MS   = 3 * 60 * 1000;

// ── Map Init ──────────────────────────────────────────────
function initMap() {
    if (mapInitialized) return;
    const mapEl = document.getElementById('leaflet-map');
    if (!mapEl || typeof L === 'undefined') return;

    const lat = currentGeoPosition ? parseFloat(currentGeoPosition.lat) : -1.9441;
    const lng = currentGeoPosition ? parseFloat(currentGeoPosition.lng) : 30.0619;

    dwMap = L.map('leaflet-map', { center: [lat, lng], zoom: 15, zoomControl: true });

    // CARTO Dark Matter — premium dark tiles, free, no API key
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://osm.org/copyright" target="_blank">OSM</a> &copy; <a href="https://carto.com/" target="_blank">CARTO</a>',
        subdomains: 'abcd', maxZoom: 19
    }).addTo(dwMap);

    mapInitialized = true;
    logEvent('MAP: Route Advisor initialized.', 't-info');

    if (currentGeoPosition) {
        placeUserDot(lat, lng);
        refreshAllMapData(lat, lng);
    }

    // Attach search and routing listeners
    const searchBtn = document.getElementById('btn-route-go');
    const searchInput = document.getElementById('map-search-input');
    const clearBtn = document.getElementById('btn-route-clear');

    if (searchBtn) searchBtn.onclick = () => startRouting();
    if (searchInput) {
        searchInput.onkeypress = (e) => { if (e.key === 'Enter') startRouting(); };
    }
    if (clearBtn) clearBtn.onclick = () => clearActiveRoute();
}

// ── Routing Logic (OSRM) ──────────────────────────────────
async function startRouting() {
    const query = document.getElementById('map-search-input')?.value.trim();
    if (!query || !currentGeoPosition) {
        logEvent('MAP: Enter a destination and ensure GPS is active.', 't-warn');
        return;
    }

    const searchInput = document.getElementById('map-search-input');
    const searchBtn = document.getElementById('btn-route-go');

    logEvent(`MAP: Searching for "${query}"...`, 't-info');
    if (searchInput) searchInput.disabled = true;
    if (searchBtn) searchBtn.style.opacity = '0.5';

    try {
        // Step 1: Geocode (Nominatim) - Added User-Agent for better reliability
        const geoRes = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`, {
            headers: { 'User-Agent': 'DriverWatch-Enterprise/1.0' }
        });
        const geoData = await geoRes.json();

        if (!geoData || geoData.length === 0) {
            logEvent('MAP: Location not found. Try a more specific name.', 't-warn');
            return;
        }

        const destLat = parseFloat(geoData[0].lat);
        const destLng = parseFloat(geoData[0].lon);
        const locationName = geoData[0].display_name.split(',')[0];

        // Step 2: Route (OSRM)
        const startLat = Number(currentGeoPosition.lat);
        const startLng = Number(currentGeoPosition.lng);
        
        const routeRes = await fetch(`https://router.project-osrm.org/route/v1/driving/${startLng},${startLat};${destLng},${destLat}?overview=full&geometries=geojson`);
        const routeData = await routeRes.json();

        if (routeData.code !== 'Ok' || !routeData.routes?.length) {
            logEvent('MAP: No drivable route found to that target.', 't-warn');
            return;
        }

        const route = routeData.routes[0];
        activeRouteData = {
            dest: { lat: destLat, lng: destLng },
            distance: route.distance, 
            duration: route.duration  
        };

        drawRouteOnMap(route.geometry);
        updateRoutePanel(route.distance, route.duration);
        
        logEvent(`MAP: Destination set to ${locationName}.`, 't-succ');
        
        if (dwMap) {
           const poly = L.geoJSON(route.geometry);
           dwMap.fitBounds(poly.getBounds(), { padding: [60, 60], animate: true });
        }
    } catch (e) {
        console.error('Routing Error:', e);
        logEvent('MAP: Service unavailable. Check your internet.', 't-warn');
    } finally {
        if (searchInput) searchInput.disabled = false;
        if (searchBtn) searchBtn.style.opacity = '1';
    }
}

function drawRouteOnMap(geometry) {
    if (currentRouteLayer && dwMap) dwMap.removeLayer(currentRouteLayer);
    
    currentRouteLayer = L.geoJSON(geometry, {
        style: {
            color: '#6366f1',
            weight: 6,
            opacity: 0.8,
            lineCap: 'round'
        }
    }).addTo(dwMap);
}

function updateRoutePanel(distMeters, durSeconds) {
    const panel = document.getElementById('route-info-panel');
    const etaVal = document.getElementById('route-eta-val');
    const distVal = document.getElementById('route-dist-val');
    if (!panel) return;

    panel.classList.remove('hidden');

    const km = (distMeters / 1000).toFixed(1);
    const mins = Math.ceil(durSeconds / 60);
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;

    distVal.innerText = `${km} km`;
    etaVal.innerText = hours > 0 ? `${hours}h ${remMins}m` : `${mins} min`;
}

function clearActiveRoute() {
    if (currentRouteLayer && dwMap) dwMap.removeLayer(currentRouteLayer);
    currentRouteLayer = null;
    activeRouteData = null;
    
    const panel = document.getElementById('route-info-panel');
    if (panel) panel.classList.add('hidden');
    
    const input = document.getElementById('map-search-input');
    if (input) input.value = '';
    
    logEvent('MAP: Route cleared.', 't-info');
}

// ── User dot ─────────────────────────────────────────────
function placeUserDot(lat, lng) {
    if (!dwMap) return;
    const icon = L.divIcon({
        className: '',
        html: `<div class="map-user-dot"><div class="map-user-pulse"></div></div>`,
        iconSize: [18, 18], iconAnchor: [9, 9]
    });
    if (!userMarker) {
        userMarker = L.marker([lat, lng], { icon, zIndexOffset: 1000 }).addTo(dwMap);
    } else {
        userMarker.setLatLng([lat, lng]);
    }
    dwMap.panTo([lat, lng], { animate: true, duration: 0.6 });
}

// ── GPS update hook (called from app.js location tracking) ─
function onGpsUpdateForMap(lat, lng) {
    if (!mapInitialized) return;
    placeUserDot(lat, lng);

    // If active route, update ETA or check if arrived
    if (activeRouteData) {
        const d = haversineKm(lat, lng, activeRouteData.dest.lat, activeRouteData.dest.lng);
        if (d < 0.05) { // 50m arrival
            logEvent('MAP: Arrival reached. Navigation complete.', 't-succ');
            clearActiveRoute();
        } else {
            // Passive update: just update the distance remaining
            const distVal = document.getElementById('route-dist-val');
            if (distVal) distVal.innerText = `${d.toFixed(1)} km`;
        }
    }

    const now = Date.now();
    const moved = lastHazardFetchPos
        ? haversineKm(lastHazardFetchPos.lat, lastHazardFetchPos.lng, lat, lng) > 2
        : true;

    if (moved || now - lastHazardFetchTime > HAZARD_FETCH_COOLDOWN_MS) {
        refreshAllMapData(lat, lng);
    } else {
        checkProximityWarning(lat, lng);
    }
}

async function refreshAllMapData(lat, lng) {
    await Promise.allSettled([
        fetchOsmData(lat, lng),
        loadCommunityHotspots(lat, lng)
    ]);
    checkProximityWarning(lat, lng);
}

// ── 1. OSM Hazard + Traffic Data ─────────────────────────
async function fetchOsmData(lat, lng) {
    lastHazardFetchPos  = { lat, lng };
    lastHazardFetchTime = Date.now();
    const R = 10000; // 10km

    const q = `
[out:json][timeout:20];
(
  node["accident"](around:${R},${lat},${lng});
  node["hazard"](around:${R},${lat},${lng});
  node["highway"="speed_camera"](around:${R},${lat},${lng});
  node["highway"="traffic_signals"](around:${R},${lat},${lng});
  node["highway"="stop"](around:${R},${lat},${lng});
  node["barrier"="bump"](around:${R},${lat},${lng});
  node["traffic_calming"](around:${R},${lat},${lng});
  node["traffic_sign"~"danger|maxspeed"](around:${R},${lat},${lng});
  node["highway"="crossing"](around:${R},${lat},${lng});
  node["amenity"="fuel"](around:${R},${lat},${lng});
  node["highway"="mini_roundabout"](around:${R},${lat},${lng});
  node["junction"="roundabout"](around:${R},${lat},${lng});
);
out body;
    `.trim();

    try {
        const res  = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: q });
        const data = await res.json();
        const els  = (data.elements || []).filter(e => e.lat != null && e.lon != null);

        hazardLayers.forEach(l => { try { dwMap.removeLayer(l); } catch (_) {} });
        hazardLayers = [];
        hazardPoints = [];

        els.forEach(el => {
            const h = classifyOsmNode(el.tags);
            hazardPoints.push({ lat: el.lat, lng: el.lon, type: h.id, name: el.tags?.name || h.label });

            const circle = L.circle([el.lat, el.lon], {
                radius: h.radius, color: h.color, fillColor: h.color,
                fillOpacity: 0.13, weight: 1.5, opacity: 0.7
            }).addTo(dwMap);

            circle.bindPopup(`<div class="map-popup"><b style="color:${h.color}">${h.label}</b><br><small>${escapeHtml(el.tags?.name || el.tags?.description || '')}</small></div>`);
            hazardLayers.push(circle);
        });

        updateMapStatus(els.length, communityPoints.length);
        logEvent(`MAP: ${els.length} road feature${els.length !== 1 ? 's' : ''} loaded from OSM.`, 't-succ');
    } catch (e) {
        logEvent('MAP: OSM data fetch failed — check connection.', 't-warn');
    }
}

function classifyOsmNode(tags) {
    if (!tags) return { id: 'general', label: '📍 Road Feature', color: '#22d3ee', radius: 55 };

    if (tags.accident)                      return { id: 'accident',  label: '⚠️ Accident Zone',     color: '#ef4444', radius: 280 };
    if (tags.hazard)                        return { id: 'hazard',    label: '⚠️ Road Hazard',       color: '#ef4444', radius: 160 };
    if (tags.highway  === 'speed_camera')   return { id: 'camera',    label: '📷 Speed Camera',       color: '#f59e0b', radius: 130 };
    if (tags.highway  === 'traffic_signals')return { id: 'signals',   label: '🚦 Traffic Signal',    color: '#6366f1', radius: 50  };
    if (tags.highway  === 'stop')           return { id: 'stop',      label: '🛑 Stop Sign',          color: '#f59e0b', radius: 45  };
    if (tags.barrier  === 'bump' || tags.traffic_calming) return { id: 'calming', label: '🚧 Traffic Calming', color: '#f59e0b', radius: 40 };
    if (tags.traffic_sign)                  return { id: 'sign',      label: '⚡ Speed Sign',         color: '#f59e0b', radius: 55  };
    if (tags.highway  === 'crossing')       return { id: 'crossing',  label: '🚶 Pedestrian Crossing', color: '#22d3ee', radius: 40  };
    if (tags.highway  === 'mini_roundabout' || tags.junction === 'roundabout') return { id: 'roundabout', label: '🔄 Roundabout', color: '#22d3ee', radius: 60 };
    if (tags.amenity  === 'fuel')           return { id: 'fuel',      label: '⛽ Fuel Station',       color: '#10b981', radius: 50  };

    return { id: 'general', label: '📍 Road Feature', color: '#22d3ee', radius: 55 };
}

// ── 2. Community Impact Hotspots (Firestore) ─────────────
async function loadCommunityHotspots(lat, lng) {
    const now = Date.now();
    if (now - lastCommunityFetchTime < COMMUNITY_FETCH_COOLDOWN_MS) return;
    lastCommunityFetchTime = now;

    try {
        // Read from public `communityHotspots` collection — anonymized impact coords only
        // Fetch hotspots within a bounding box (~15km)
        const delta = 0.135; // ~15km
        const snapshot = await db.collection('communityHotspots')
            .where('lat', '>=', lat - delta)
            .where('lat', '<=', lat + delta)
            .where('type', '==', 'impact')
            .orderBy('lat')
            .limit(200)
            .get();

        communityLayers.forEach(l => { try { dwMap.removeLayer(l); } catch (_) {} });
        communityLayers = [];
        communityPoints = [];

        snapshot.forEach(doc => {
            const d = doc.data();
            if (d.lat == null || d.lng == null) return;
            // Additional lng filter (Firestore can't do 2D range query natively)
            if (d.lng < lng - delta || d.lng > lng + delta) return;

            communityPoints.push({ lat: d.lat, lng: d.lng, type: 'community-impact' });

            const marker = L.circleMarker([d.lat, d.lng], {
                radius: 10,
                color: '#ef4444', fillColor: '#ef4444',
                fillOpacity: 0.55, weight: 2
            }).addTo(dwMap);

            const readableTime = d.timestamp?.toDate
                ? d.timestamp.toDate().toLocaleDateString()
                : 'Unknown date';

            marker.bindPopup(`<div class="map-popup"><b style="color:#ef4444">💥 Community Impact Report</b><br><small>Reported: ${readableTime}<br>Anonymous DriverWatch incident</small></div>`);
            communityLayers.push(marker);
        });

        updateMapStatus(hazardPoints.length, communityPoints.length);
        if (communityPoints.length > 0) {
            logEvent(`MAP: ${communityPoints.length} community crash report${communityPoints.length !== 1 ? 's' : ''} found nearby.`, 't-warn');
        }
    } catch (e) {
        // Firestore index may need deploying — fail silently, OSM data still shows
        console.warn('Community hotspots fetch failed:', e);
    }
}

// ── Community hotspot upload (called from app.js on impact) ─
async function uploadCommunityImpact(lat, lng) {
    if (lat == null || lng == null) return;
    try {
        await db.collection('communityHotspots').add({
            lat: parseFloat(parseFloat(lat).toFixed(4)),  // truncate to ~11m precision
            lng: parseFloat(parseFloat(lng).toFixed(4)),
            type: 'impact',
            timestamp: firebase.firestore.FieldValue.serverTimestamp(),
            appVersion: 'dw-v7'
            // NO uid, NO driver name, NO plate — fully anonymous
        });
        logEvent('MAP: Anonymous impact location shared with community.', 't-info');
    } catch (e) {
        console.warn('Community hotspot upload failed:', e);
    }
}

// ── Proximity voice + toast warning ──────────────────────
function checkProximityWarning(lat, lng) {
    const allPoints = [...hazardPoints, ...communityPoints];
    if (!allPoints.length) return;
    const now = Date.now();
    if (now - lastProximityWarnTime < PROXIMITY_WARN_COOLDOWN_MS) return;

    const danger = allPoints.find(h =>
        (h.type === 'accident' || h.type === 'hazard' || h.type === 'community-impact') &&
        haversineKm(lat, lng, h.lat, h.lng) * 1000 < PROXIMITY_WARN_RADIUS_M
    );
    if (!danger) return;

    lastProximityWarnTime = now;
    const isCommunity = danger.type === 'community-impact';
    const label = isCommunity
        ? 'Other DriverWatch users reported a collision here. Stay alert.'
        : (danger.name || 'Known accident or hazard zone');

    showMapAdvisory(label);

    if (typeof getBestVoice === 'function' && typeof synth !== 'undefined' && synth) {
        try {
            synth.resume();
            const msg = isCommunity
                ? 'Caution. A collision was previously reported near this location. Please slow down.'
                : 'Caution. You are approaching a known road hazard. Please slow down and stay alert.';
            const u = new SpeechSynthesisUtterance(msg);
            u.rate = 1.0; u.volume = 0.95;
            const v = getBestVoice();
            if (v) u.voice = v;
            synth.speak(u);
        } catch (_) {}
    }
    logEvent(`MAP: ⚠️ Danger zone within ${PROXIMITY_WARN_RADIUS_M}m — driver advised.`, 't-warn');
}

// ── Advisory toast ────────────────────────────────────────
function showMapAdvisory(text) {
    const el     = document.getElementById('map-advisory');
    const textEl = document.getElementById('map-advisory-text');
    if (!el) return;
    if (textEl) textEl.innerText = escapeHtml(text);
    // Shift up if route panel is visible so they don't overlap
    const routePanel = document.getElementById('route-info-panel');
    el.style.bottom = (routePanel && !routePanel.classList.contains('hidden')) ? '96px' : '10px';
    el.classList.remove('hidden');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => el.classList.add('hidden'), 9000);
}

// ── Status bar update ─────────────────────────────────────
function updateMapStatus(osmCount, communityCount) {
    const el = document.getElementById('map-status-bar');
    if (!el) return;
    const parts = [];
    if (osmCount > 0)       parts.push(`${osmCount} road features`);
    if (communityCount > 0) parts.push(`${communityCount} community reports`);
    el.innerText = parts.length ? parts.join(' · ') : 'No hazards found in range';
}

// ── Called on tab open ────────────────────────────────────
function onMapTabOpened() {
    if (!mapInitialized) {
        initMap();
    } else {
        setTimeout(() => { if (dwMap) dwMap.invalidateSize(); }, 120);
    }
}
