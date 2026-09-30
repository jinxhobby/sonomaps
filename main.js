import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

let audioCtx = null;
let isRunning = false;
let liveGpsEnabled = true;
let isMuted = false;
let lastKnownGpsCoords = null;
let bpm = 120;
let nextPulseTime = 0;
let stepCount = 0;

let userMix = { music: 1.0, ambience: 1.0, voice: 1.0 };
const scale = [110.00, 123.47, 130.81, 146.83, 164.81, 174.61, 196.00, 220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88];

let zones = [];
let pendingZoneData = null;
let editingZoneId = null;
let currentCarouselIndex = 0;

let historyStack = [];
let redoStack = [];

const map = L.map('map', { zoomControl: false, doubleClickZoom: false }).setView([42.1550, -80.0950], 13);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 16, attribution: 'Tiles &copy; Esri' }).addTo(map);

// FIX 1: Native Geoman tools cleanly injected.
map.pm.addControls({ position: 'topleft', drawMarker: false, drawCircleMarker: false, drawPolyline: false, drawText: false, cutPolygon: false, rotateMode: false, drawRectangle: false });
map.pm.setGlobalOptions({ snappable: true, snapDistance: 60, snapTolerance: 60, pathOptions: { color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.3 } });

const userMarker = L.marker([42.1098, -80.1555], {
  draggable: false, icon: L.divIcon({ className: 'custom-pin', html: '<div id="pin-dot" style="background:#10b981;width:20px;height:20px;border-radius:50%;border:3px solid #1e293b;box-shadow:0 0 10px rgba(0,0,0,0.6);cursor:default;"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), zIndexOffset: 1000
}).addTo(map);

userMarker.on('drag', (e) => { updateAudio(e.target.getLatLng().lat, e.target.getLatLng().lng); });

// Touch-Safe Draggable Studio Panel
const studioPanel = document.getElementById('studio-panel');
const studioHeader = document.getElementById('studio-drag-handle');
let isDragging = false, startX, startY, initialX, initialY;

function startDrag(e) {
  if (e.target.tagName === 'BUTTON') return;
  isDragging = true; 
  startX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX; 
  startY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
  const rect = studioPanel.getBoundingClientRect();
  initialX = rect.left; initialY = rect.top;
  document.addEventListener('mousemove', onDrag);
  document.addEventListener('mouseup', stopDrag);
  document.addEventListener('touchmove', onDrag, {passive: false});
  document.addEventListener('touchend', stopDrag);
}
studioHeader.addEventListener('mousedown', startDrag);
studioHeader.addEventListener('touchstart', startDrag, {passive: true});

function onDrag(e) {
  if (!isDragging) return;
  if (e.type.includes('touch')) e.preventDefault(); 
  const clientX = e.type.includes('mouse') ? e.clientX : e.touches[0].clientX;
  const clientY = e.type.includes('mouse') ? e.clientY : e.touches[0].clientY;
  const dx = clientX - startX; const dy = clientY - startY;
  studioPanel.style.left = `${initialX + dx}px`;
  studioPanel.style.top = `${initialY + dy}px`;
  studioPanel.style.right = 'auto'; 
}
function stopDrag() { 
  isDragging = false; 
  document.removeEventListener('mousemove', onDrag); 
  document.removeEventListener('mouseup', stopDrag); 
  document.removeEventListener('touchmove', onDrag); 
  document.removeEventListener('touchend', stopDrag); 
}

window.addEventListener('DOMContentLoaded', async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const sceneId = urlParams.get('scene');
  if (sceneId) {
    document.getElementById('gateway-start-btn').innerText = "Loading Sonomap...";
    try {
      const { data, error } = await supabase.from('scenes').select('*').eq('id', sceneId).single();
      if (error) throw error;
      document.querySelector('.brand-title').innerText = data.title;
      document.getElementById('save-project-title').value = data.title;
      if (data.description) document.getElementById('album-desc').value = data.description;
      map.setView([data.initial_lat, data.initial_lng], data.initial_zoom);
      window.sharedSceneData = data;
      document.getElementById('gateway-start-btn').innerText = "▶ Tap to Walk & Listen";
    } catch (err) { alert("Failed to load shared scene: " + err.message); document.getElementById('gateway-start-btn').innerText = "▶ Start Empty Session"; }
  }
});

function saveHistoryState() {
  const state = zones.map(z => ({ ...z, layer: null, stems: [], latlngs: z.latlngs ? [...z.latlngs] : null }));
  historyStack.push(state); redoStack = []; updateHistoryButtons();
}
function updateHistoryButtons() {
  document.getElementById('btn-undo').disabled = historyStack.length === 0;
  document.getElementById('btn-redo').disabled = redoStack.length === 0;
}
document.getElementById('btn-undo').addEventListener('click', () => {
  if (historyStack.length === 0) return;
  redoStack.push(zones.map(z => ({ ...z, layer: null, stems: [], latlngs: z.latlngs ? [...z.latlngs] : null })));
  restoreState(historyStack.pop());
});
document.getElementById('btn-redo').addEventListener('click', () => {
  if (redoStack.length === 0) return;
  historyStack.push(zones.map(z => ({ ...z, layer: null, stems: [], latlngs: z.latlngs ? [...z.latlngs] : null })));
  restoreState(redoStack.pop());
});
function restoreState(newState) {
  [...zones].forEach(z => {
    if (z.layer) map.removeLayer(z.layer);
    if (z.stems) z.stems.forEach(s => { if (s.gain) s.gain.gain.setValueAtTime(0, audioCtx.currentTime); if (s.audio) s.audio.pause(); if (s.osc) s.osc.stop(); });
    if (z.masterGain) z.masterGain.disconnect();
  });
  zones = [];
  newState.forEach(zData => {
    let layer = zData.shapeType === 'circle' ? L.circle([zData.lat, zData.lng], { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, radius: zData.radius }).addTo(map) : L.polygon(zData.latlngs, { color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.3 }).addTo(map);
    zData.layer = layer;
    setupZoneStems(zData, zData.savedSources || {});
    zones.push(zData);
    attachEditListener(zData.layer, zData);
  });
  updateAudio(userMarker.getLatLng().lat, userMarker.getLatLng().lng);
  renderCarousel(); updateHistoryButtons();
}

document.getElementById('btn-create-mode').addEventListener('click', () => {
  document.getElementById('btn-create-mode').classList.add('active-mode'); document.getElementById('btn-play-mode').classList.remove('active-mode');
  document.getElementById('explore-hud').style.opacity = '0'; document.getElementById('now-playing-media').style.display = 'none'; 
  setTimeout(() => document.getElementById('explore-hud').style.display = 'none', 200); document.getElementById('studio-panel').style.display = 'flex';
  
  const pmToolbar = document.querySelector('.leaflet-pm-toolbar');
  if (pmToolbar) pmToolbar.style.display = 'block';

  setGpsTracking(false); renderCarousel();
});

document.getElementById('btn-play-mode').addEventListener('click', () => {
  document.getElementById('btn-play-mode').classList.add('active-mode'); document.getElementById('btn-create-mode').classList.remove('active-mode');
  document.getElementById('studio-panel').style.display = 'none'; document.getElementById('explore-hud').style.display = 'block'; document.getElementById('now-playing-media').style.display = 'block'; 
  setTimeout(() => document.getElementById('explore-hud').style.opacity = '1', 10);
  
  const pmToolbar = document.querySelector('.leaflet-pm-toolbar');
  if (pmToolbar) pmToolbar.style.display = 'none';

  map.pm.disableDraw(); map.pm.disableGlobalEditMode(); cancelFreehand();
  setGpsTracking(true);
});

document.getElementById('btn-toggle-advanced').addEventListener('click', () => {
  const panel = document.getElementById('advanced-settings-panel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('cfg-fx-filter').addEventListener('input', (e) => { document.getElementById('val-filter').innerText = e.target.value === '0' ? 'Off' : e.target.value + '%'; });
document.getElementById('cfg-fx-delay').addEventListener('input', (e) => { document.getElementById('val-delay').innerText = e.target.value + '%'; });

document.getElementById('cfg-time-of-day').addEventListener('change', (e) => {
  if (e.target.value === 'split') {
    document.getElementById('standard-stems-container').style.display = 'none';
    document.getElementById('fragment-stems-container').style.display = 'block';
    document.getElementById('cfg-fragment-times').style.display = 'flex';
  } else {
    document.getElementById('standard-stems-container').style.display = 'block';
    document.getElementById('fragment-stems-container').style.display = 'none';
    document.getElementById('cfg-fragment-times').style.display = 'none';
  }
});

const triggerUpdate = () => { updateAudio(lastKnownGpsCoords && liveGpsEnabled ? lastKnownGpsCoords.latitude : userMarker.getLatLng().lat, lastKnownGpsCoords && liveGpsEnabled ? lastKnownGpsCoords.longitude : userMarker.getLatLng().lng); };
document.getElementById('mix-music').addEventListener('input', (e) => { userMix.music = parseFloat(e.target.value); triggerUpdate(); });
document.getElementById('mix-ambi').addEventListener('input', (e) => { userMix.ambience = parseFloat(e.target.value); triggerUpdate(); });
document.getElementById('mix-voice').addEventListener('input', (e) => { userMix.voice = parseFloat(e.target.value); triggerUpdate(); });

document.getElementById('btn-master-mute').addEventListener('click', (e) => {
  if (!audioCtx) return; isMuted = !isMuted;
  if (isMuted) { audioCtx.suspend(); e.target.innerHTML = 'UNMUTE'; e.target.classList.add('active'); } else { audioCtx.resume(); e.target.innerHTML = 'MUTE'; e.target.classList.remove('active'); }
});

document.getElementById('btn-master-reset').addEventListener('click', () => { stepCount = 0; zones.forEach(z => { if (z.stems) z.stems.forEach(s => { if (s.audio) s.audio.currentTime = 0; }); }); });

function createSingleStemNode(type, source, freq, shiftTag, targetMixBus) {
  const gain = audioCtx.createGain(); gain.gain.cancelScheduledValues(audioCtx.currentTime); gain.gain.setValueAtTime(0, audioCtx.currentTime);
  const panner = audioCtx.createStereoPanner ? audioCtx.createStereoPanner() : null;
  let targetNode = panner || gain;

  if (source instanceof Blob || (typeof source === 'string' && source.length > 0)) {
    const url = (source instanceof Blob) ? URL.createObjectURL(source) : source;
    const audio = new Audio(url); audio.loop = true; audio.crossOrigin = 'anonymous';
    const track = audioCtx.createMediaElementSource(audio); track.connect(targetNode);
    if (panner) panner.connect(gain); gain.connect(targetMixBus); audio.play().catch(() => {});
    return { type, category: type, audio, gain, panner, baseVol: 1.0, rawSource: source, shift: shiftTag };
  }

  if (type === 'music') {
    const osc = audioCtx.createOscillator(); osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
    osc.connect(targetNode); if (panner) panner.connect(gain); gain.connect(targetMixBus); osc.start();
    return { type, category: 'music', osc, gain, panner, baseVol: 0.8, rawSource: null, shift: shiftTag };
  } return null;
}

function setupZoneStems(zone, sources = {}) {
  if (zone.stems) { zone.stems.forEach(s => { if (s.gain) s.gain.gain.setValueAtTime(0, audioCtx.currentTime); if (s.audio) s.audio.pause(); if (s.osc) s.osc.stop(); }); }
  if (zone.masterGain) zone.masterGain.disconnect();
  
  zone.masterGain = audioCtx.createGain();
  const filterNode = audioCtx.createBiquadFilter(); filterNode.type = 'lowpass';
  const filterVal = zone.fxFilter || 0; filterNode.frequency.value = filterVal > 0 ? 20000 - (filterVal * 195) : 20000;
  zone.masterGain.connect(filterNode);
  
  const delayAmount = (zone.fxDelay || 0) / 100;
  if (delayAmount > 0) {
    const delayNode = audioCtx.createDelay(); delayNode.delayTime.value = 0.5;
    const feedback = audioCtx.createGain(); feedback.gain.value = 0.4;
    const delayVol = audioCtx.createGain(); delayVol.gain.value = delayAmount;
    filterNode.connect(delayNode); delayNode.connect(feedback); feedback.connect(delayNode); delayNode.connect(delayVol);
    delayVol.connect(audioCtx.destination);
  }
  filterNode.connect(audioCtx.destination);
  
  zone.stems = []; zone.savedSources = sources; 
  
  if (zone.timeOfDay === 'split') {
    const dM = createSingleStemNode('music', sources.shift1Music, zone.freq, 'shift1', zone.masterGain); if(dM) zone.stems.push(dM);
    const dA = createSingleStemNode('ambience', sources.shift1Ambi, zone.freq, 'shift1', zone.masterGain); if(dA) zone.stems.push(dA);
    if(sources.shift1Voice) { const dV = createSingleStemNode('voice', sources.shift1Voice, zone.freq, 'shift1', zone.masterGain); if(dV) zone.stems.push(dV); }
    
    const nM = createSingleStemNode('music', sources.shift2Music, zone.freq, 'shift2', zone.masterGain); if(nM) zone.stems.push(nM);
    const nA = createSingleStemNode('ambience', sources.shift2Ambi, zone.freq, 'shift2', zone.masterGain); if(nA) zone.stems.push(nA);
    if(sources.shift2Voice) { const nV = createSingleStemNode('voice', sources.shift2Voice, zone.freq, 'shift2', zone.masterGain); if(nV) zone.stems.push(nV); }
  } else {
    const m = createSingleStemNode('music', sources.music, zone.freq, 'any', zone.masterGain); if(m) zone.stems.push(m);
    const a = createSingleStemNode('ambience', sources.ambience, zone.freq, 'any', zone.masterGain); if(a) zone.stems.push(a);
    if(sources.voice) { const v = createSingleStemNode('voice', sources.voice, zone.freq, 'any', zone.masterGain); if(v) zone.stems.push(v); }
  }
}

function startMasterClock() { nextPulseTime = audioCtx.currentTime; schedulePulses(); }
function schedulePulses() {
  const stepDuration = (60.0 / bpm) / 4;
  while (nextPulseTime < audioCtx.currentTime + 0.1) {
    zones.forEach((zone, idx) => {
      if (zone.targetVolume > 0.005) {
        zone.stems.forEach(stem => {
          if (stem.osc && stepCount % (idx % 2 === 0 ? 4 : 2) === 0) {
            let userMult = userMix[stem.category] !== undefined ? userMix[stem.category] : 1.0;
            if (zone.timeOfDay === 'split') {
              const now = new Date();
              if (stem.shift === 'shift1' && !isTimeInShift(zone.shift1Start, zone.shift1End, now)) userMult = 0;
              if (stem.shift === 'shift2' && !isTimeInShift(zone.shift2Start, zone.shift2End, now)) userMult = 0;
            }
            const target = zone.targetVolume * stem.baseVol * userMult;
            stem.gain.gain.setValueAtTime(target, nextPulseTime); stem.gain.gain.linearRampToValueAtTime(0.0, nextPulseTime + (60 / bpm / 2));
          }
        });
      }
    });
    nextPulseTime += stepDuration; stepCount = (stepCount + 1) % 16;
  } setTimeout(schedulePulses, 30);
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; const toRad = deg => (deg * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}
function isPointInPolygon(point, vs) {
  const x = point.lng, y = point.lat; let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const intersect = ((vs[i].lat > y) !== (vs[j].lat > y)) && (x < (vs[j].lng - vs[i].lng) * (y - vs[i].lat) / (vs[j].lat - vs[i].lat) + vs[i].lng);
    if (intersect) inside = !inside;
  } return inside;
}
function distToPolygon(point, vs) {
  if (isPointInPolygon(point, vs)) return 0;
  let minDist = Infinity;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const l2 = ((vs[i].lat - vs[j].lat) ** 2) + ((vs[i].lng - vs[j].lng) ** 2);
    let t = l2 === 0 ? 0 : ((point.lat - vs[i].lat) * (vs[j].lat - vs[i].lat) + (point.lng - vs[i].lng) * (vs[j].lng - vs[i].lng)) / l2;
    t = Math.max(0, Math.min(1, t));
    const d = getDistance(point.lat, point.lng, vs[i].lat + t * (vs[j].lat - vs[i].lat), vs[i].lng + t * (vs[j].lng - vs[i].lng));
    if (d < minDist) minDist = d;
  } return minDist;
}

function isTimeInShift(startStr, endStr, dateObj) {
  if(!startStr || !endStr) return true;
  const currentMin = dateObj.getHours() * 60 + dateObj.getMinutes();
  const sParts = startStr.split(':'); const sMin = parseInt(sParts[0])*60 + parseInt(sParts[1]);
  const eParts = endStr.split(':'); const eMin = parseInt(eParts[0])*60 + parseInt(eParts[1]);
  if (sMin <= eMin) return currentMin >= sMin && currentMin < eMin;
  return currentMin >= sMin || currentMin < eMin; 
}

function updateAudio(lat, lng) {
  if (!audioCtx) return;
  const point = { lat, lng }; let activeZones = [];
  const now = new Date();
  
  zones.forEach(zone => {
    let vol = 0; let dist = 0; let targetLng = zone.lng;
    
    if (zone.shapeType === 'circle') {
      dist = getDistance(lat, lng, zone.lat, zone.lng);
      if (dist < zone.radius) vol = 1 - (dist / zone.radius);
    } else if (zone.shapeType === 'polygon') {
      dist = distToPolygon(point, zone.latlngs);
      if (dist === 0) vol = 1.0; else if (dist < zone.fadeBuffer) vol = 1 - (dist / zone.fadeBuffer);
      targetLng = zone.latlngs.reduce((sum, p) => sum + p.lng, 0) / zone.latlngs.length;
    }
    
    zone.targetVolume = vol;
    
    zone.stems.forEach(stem => {
      let userMult = userMix[stem.category] !== undefined ? userMix[stem.category] : 1.0;
      if (zone.timeOfDay === 'split') {
        if (stem.shift === 'shift1' && !isTimeInShift(zone.shift1Start, zone.shift1End, now)) userMult = 0;
        if (stem.shift === 'shift2' && !isTimeInShift(zone.shift2Start, zone.shift2End, now)) userMult = 0;
      }
      
      const isAudible = (vol * userMult) > 0.005; 
      const stemGainTarget = isAudible ? (vol * stem.baseVol * userMult) : 0.0;
      
      if (stem.panner) stem.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, (targetLng - lng) * 400)), audioCtx.currentTime, 0.05);
      if (stem.audio) { if (!isAudible) { stem.gain.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.1); } else { stem.gain.gain.setTargetAtTime(stemGainTarget, audioCtx.currentTime, 0.05); } } 
      else if (stem.osc && !isAudible) { stem.gain.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.1); }
    });
    
    if (vol > 0.05) activeZones.push({ name: zone.name, vol: Math.round(vol * 100), media: zone.media, desc: zone.desc });
  });

  const npContainer = document.getElementById('now-playing-media');
  const npMedia = document.getElementById('np-media-container');
  const npDesc = document.getElementById('np-desc');

  if (activeZones.length > 0) {
    document.getElementById('hud-zone-name').innerText = activeZones.map(z => z.name).join(' + ');
    document.getElementById('hud-details').innerText = `Soundscape active: ${activeZones.map(z => z.name + ' (' + z.vol + '%)').join(', ')}`;
    
    activeZones.sort((a, b) => b.vol - a.vol);
    const primaryZone = activeZones[0];

    if (primaryZone.media || primaryZone.desc) {
      if (npContainer.dataset.zoneName !== primaryZone.name) {
        npContainer.dataset.zoneName = primaryZone.name;
        let mediaHtml = '';
        if (primaryZone.media) {
          const src = (primaryZone.media instanceof Blob) ? URL.createObjectURL(primaryZone.media) : primaryZone.media;
          const isVideo = (primaryZone.media instanceof Blob && primaryZone.media.type.startsWith('video/')) || (typeof primaryZone.media === 'string' && primaryZone.media.match(/\.(mp4|webm|mov)$/i));
          if (isVideo) { mediaHtml = `<video src="${src}" autoplay loop muted playsinline></video>`; } 
          else { mediaHtml = `<img src="${src}">`; }
        }
        npMedia.innerHTML = mediaHtml;
        npDesc.innerText = primaryZone.desc || '';
        npContainer.classList.remove('hidden');
      }
    } else { hideNowPlaying(); }
  } else {
    document.getElementById('hud-zone-name').innerText = 'Exploring peninsula...';
    document.getElementById('hud-details').innerText = liveGpsEnabled ? (zones.length > 0 ? 'Walk into any marked sound zone to trigger audio.' : 'No zones available. Switch to CREATE/EDIT to build.') : 'Drag the pin to audition locations.';
    hideNowPlaying();
  }

  function hideNowPlaying() {
    if (npContainer.dataset.zoneName !== '') {
      npContainer.classList.add('hidden'); npContainer.dataset.zoneName = '';
      setTimeout(() => { if(npContainer.dataset.zoneName === '') { npMedia.innerHTML = ''; npDesc.innerText = ''; } }, 300);
    }
  }
}

function setGpsTracking(enabled) {
  liveGpsEnabled = enabled;
  const walkBtn = document.getElementById('btn-toggle-walk'); const exploreBtn = document.getElementById('btn-toggle-explore'); const pinDot = document.getElementById('pin-dot');
  if (liveGpsEnabled) {
    walkBtn.className = 'btn-hud btn-hud-gps'; exploreBtn.className = 'btn-hud btn-hud-virtual'; userMarker.dragging.disable();
    if (pinDot) { pinDot.style.background = '#10b981'; pinDot.style.cursor = 'default'; }
    if (lastKnownGpsCoords) { userMarker.setLatLng([lastKnownGpsCoords.latitude, lastKnownGpsCoords.longitude]); map.panTo([lastKnownGpsCoords.latitude, lastKnownGpsCoords.longitude], { animate: true }); updateAudio(lastKnownGpsCoords.latitude, lastKnownGpsCoords.longitude); }
    recenterGps();
  } else {
    walkBtn.className = 'btn-hud btn-hud-virtual'; exploreBtn.className = 'btn-hud btn-hud-gps'; userMarker.dragging.enable();
    if (pinDot) { pinDot.style.background = '#f59e0b'; pinDot.style.cursor = 'grab'; }
    document.getElementById('hud-details').innerText = 'Audition mode: Drag the orange pin along the map to test.';
  }
}

function recenterGps() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      lastKnownGpsCoords = pos.coords;
      if (liveGpsEnabled) { map.setView([pos.coords.latitude, pos.coords.longitude], 15); userMarker.setLatLng([pos.coords.latitude, pos.coords.longitude]); updateAudio(pos.coords.latitude, pos.coords.longitude); document.getElementById('hud-accuracy').innerText = `±${Math.round(pos.coords.accuracy)}m`; }
    }, err => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
  );
}

document.getElementById('gateway-start-btn').addEventListener('click', async () => {
  if (isRunning) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)(); await audioCtx.resume();
  startMasterClock(); document.getElementById('gateway-splash').classList.add('hidden'); setGpsTracking(true);
  
  if (window.sharedSceneData) {
    (window.sharedSceneData.zones || []).forEach(zData => {
      let layer = zData.shapeType === 'circle' ? L.circle([zData.lat, zData.lng], { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, radius: zData.radius }).addTo(map) : L.polygon(zData.latlngs, { color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.3 }).addTo(map);
      if (layer) { 
        zData.layer = layer; 
        zData.media = zData.mediaUrl;
        const stemSources = {}; (zData.layers || []).forEach(l => { if (l.url) stemSources[l.category] = l.url; }); registerSoundZone(zData, stemSources); 
      }
    });
  }

  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      pos => {
        lastKnownGpsCoords = pos.coords;
        if (liveGpsEnabled) { userMarker.setLatLng([pos.coords.latitude, pos.coords.longitude]); map.panTo([pos.coords.latitude, pos.coords.longitude], { animate: true, duration: 1.0 }); updateAudio(pos.coords.latitude, pos.coords.longitude); document.getElementById('hud-accuracy').innerText = `±${Math.round(pos.coords.accuracy)}m`; }
      }, err => {}, { enableHighAccuracy: true, maximumAge: 1000 }
    );
  }
  isRunning = true;
});

document.getElementById('btn-toggle-walk').addEventListener('click', () => setGpsTracking(true));
document.getElementById('btn-toggle-explore').addEventListener('click', () => setGpsTracking(false));

function attachEditListener(layer, targetZone) {
  layer.on('pm:edit', () => {
    saveHistoryState();
    if (targetZone.shapeType === 'circle') {
      const newLl = layer.getLatLng(); targetZone.lat = newLl.lat; targetZone.lng = newLl.lng; targetZone.radius = layer.getRadius();
    } else {
      const newLl = layer.getLatLngs(); targetZone.latlngs = Array.isArray(newLl[0]) ? newLl[0] : newLl;
    } updateAudio(userMarker.getLatLng().lat, userMarker.getLatLng().lng);
  });
}

function registerSoundZone(zone, stemSources = {}) {
  saveHistoryState();
  setupZoneStems(zone, stemSources); 
  zones.push(zone); attachEditListener(zone.layer, zone);
  updateAudio(userMarker.getLatLng().lat, userMarker.getLatLng().lng); 
  currentCarouselIndex = zones.length - 1;
  renderCarousel();
}

window.removeZone = function(id) {
  saveHistoryState();
  const index = zones.findIndex(z => z.id === id);
  if (index !== -1) {
    const zone = zones[index]; 
    if (zone.layer) map.removeLayer(zone.layer);
    if (zone.stems) zone.stems.forEach(s => { if (s.gain) { s.gain.gain.cancelScheduledValues(audioCtx.currentTime); s.gain.gain.setValueAtTime(0, audioCtx.currentTime); } if (s.audio) s.audio.pause(); if (s.osc) s.osc.stop(); });
    zones.splice(index, 1); updateAudio(userMarker.getLatLng().lat, userMarker.getLatLng().lng); renderCarousel();
  }
}

window.editZone = function(id) {
  const zone = zones.find(z => z.id === id);
  if (!zone) return;
  
  editingZoneId = id; pendingZoneData = zone;
  
  document.getElementById('advanced-settings-panel').style.display = 'none';
  document.getElementById('modal-title').innerText = 'Edit Sound Zone';
  document.getElementById('cfg-name').value = zone.name;
  document.getElementById('cfg-zone-desc').value = zone.desc || '';
  document.getElementById('cfg-time-of-day').value = zone.timeOfDay || 'always';
  
  if (zone.timeOfDay === 'split') {
    document.getElementById('standard-stems-container').style.display = 'none';
    document.getElementById('fragment-stems-container').style.display = 'block';
    document.getElementById('cfg-fragment-times').style.display = 'flex';
  } else {
    document.getElementById('standard-stems-container').style.display = 'block';
    document.getElementById('fragment-stems-container').style.display = 'none';
    document.getElementById('cfg-fragment-times').style.display = 'none';
  }
  
  if (zone.shift1Start) document.getElementById('cfg-shift1-start').value = zone.shift1Start;
  if (zone.shift1End) document.getElementById('cfg-shift1-end').value = zone.shift1End;
  if (zone.shift2Start) document.getElementById('cfg-shift2-start').value = zone.shift2Start;
  if (zone.shift2End) document.getElementById('cfg-shift2-end').value = zone.shift2End;

  const idsToClear = ['cfg-music-file', 'cfg-music-url', 'cfg-ambi-file', 'cfg-ambi-url', 'cfg-voice-file', 'cfg-voice-url', 
                      'cfg-shift1-music', 'cfg-shift1-ambi', 'cfg-shift1-voice', 'cfg-shift2-music', 'cfg-shift2-ambi', 'cfg-shift2-voice', 'cfg-zone-media'];
  idsToClear.forEach(elId => { const el = document.getElementById(elId); if(el) el.value = ''; });
  
  document.getElementById('cfg-fx-filter').value = zone.fxFilter || 0;
  document.getElementById('val-filter').innerText = zone.fxFilter > 0 ? zone.fxFilter + '%' : 'Off';
  document.getElementById('cfg-fx-delay').value = zone.fxDelay || 0;
  document.getElementById('val-delay').innerText = (zone.fxDelay || 0) + '%';
  
  document.getElementById('cfg-radius-group').style.display = zone.shapeType === 'circle' ? 'block' : 'none';
  document.getElementById('cfg-fade-group').style.display = zone.shapeType === 'polygon' ? 'block' : 'none';
  if (zone.shapeType === 'circle') document.getElementById('cfg-radius').value = Math.round(zone.radius); 
  else document.getElementById('cfg-fade').value = Math.round(zone.fadeBuffer);
  
  document.getElementById('config-modal').style.display = 'flex';
}

function renderCarousel() {
  const container = document.getElementById('zone-carousel-view');
  const indicator = document.getElementById('carousel-indicator');
  if (!container) return;
  if (zones.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:#94a3b8;padding:10px;text-align:center;border:1px dashed #475569;border-radius:8px;">No zones created. Use the map tools to draw one.</div>';
    indicator.innerText = '0 / 0'; return;
  }
  if (currentCarouselIndex >= zones.length) currentCarouselIndex = Math.max(0, zones.length - 1);
  if (currentCarouselIndex < 0) currentCarouselIndex = 0;
  
  indicator.innerText = `${currentCarouselIndex + 1} / ${zones.length}`;
  const z = zones[currentCarouselIndex];
  
  let mediaHtml = '';
  if (z.media) {
    const src = (z.media instanceof Blob) ? URL.createObjectURL(z.media) : z.media;
    const isVideo = (z.media instanceof Blob && z.media.type.startsWith('video/')) || (typeof z.media === 'string' && z.media.match(/\.(mp4|webm|mov)$/i));
    if (isVideo) { mediaHtml = `<video src="${src}" class="carousel-media-preview" autoplay loop muted playsinline></video>`; } 
    else { mediaHtml = `<img src="${src}" class="carousel-media-preview">`; }
  }
  
  let scheduleBadge = '';
  if (z.timeOfDay === 'split') scheduleBadge = `<span style="background:#064e3b;color:#34d399;border:1px solid #059669;padding:2px 6px;border-radius:4px;font-size:9px;margin-left:8px;font-weight:bold;">🌗 FRAGMENT</span>`;

  container.innerHTML = `
    <div class="carousel-card">
      <div class="carousel-card-header">
        <span class="carousel-card-title">${z.name} ${scheduleBadge}</span>
        <div>
          <button onclick="window.editZone('${z.id}')" style="background:#3b82f6;border:none;color:#fff;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:bold;margin-right:4px;">✎ Edit</button>
          <button onclick="window.removeZone('${z.id}')" style="background:#ef4444;border:none;color:#fff;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;font-weight:bold;">✕</button>
        </div>
      </div>
      ${mediaHtml}
      ${z.desc ? `<div class="carousel-card-desc">"${z.desc}"</div>` : ''}
      <div style="font-size:10px; color:#64748b; margin-top:4px;">Stems active: ${z.stems.length}</div>
    </div>
  `;
}

document.getElementById('btn-car-prev').addEventListener('click', () => { if (zones.length > 0) { currentCarouselIndex = (currentCarouselIndex - 1 + zones.length) % zones.length; renderCarousel(); } });
document.getElementById('btn-car-next').addEventListener('click', () => { if (zones.length > 0) { currentCarouselIndex = (currentCarouselIndex + 1) % zones.length; renderCarousel(); } });


// BULLETPROOF TOUCH-SAFE PENCIL TOOL
let isPencilMode = false; let isDrawingPencil = false; let pencilPoints = []; let pencilLine = null;

function endPencil() {
  if (!isDrawingPencil) return;
  isDrawingPencil = false; isPencilMode = false; 
  map.dragging.enable(); document.getElementById('map').classList.remove('pencil-mode');
  
  if (pencilLine) { map.removeLayer(pencilLine); pencilLine = null; }

  if (pencilPoints.length > 2) {
    const layer = L.polygon(pencilPoints, { color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.3 }).addTo(map);
    editingZoneId = null;
    let zoneData = { id: 'zone-' + Date.now(), shapeType: 'polygon', defaultName: `Custom Zone ${zones.length + 1}`, freq: scale[zones.length % scale.length], layer: layer };
    zoneData.latlngs = [...pencilPoints]; zoneData.fadeBuffer = 50;
    setTimeout(() => openNewZoneModal(zoneData), 100);
  }
  pencilPoints = [];
}

document.getElementById('draw-pencil-btn').addEventListener('click', () => { 
  map.pm.disableDraw(); isPencilMode = true; map.dragging.disable(); document.getElementById('map').classList.add('pencil-mode'); 
});

map.on('mousedown', (e) => { 
  if (!isPencilMode) return; 
  isDrawingPencil = true; pencilPoints = [e.latlng]; 
  if (pencilLine) map.removeLayer(pencilLine);
  pencilLine = L.polygon(pencilPoints, { color: '#f97316', fillColor: '#f97316', fillOpacity: 0.3, weight: 3, interactive: false }).addTo(map); 
});

map.on('mousemove', (e) => { 
  if (!isDrawingPencil || !pencilLine) return; 
  pencilPoints.push(e.latlng); pencilLine.setLatLngs(pencilPoints); 
});

map.on('mouseup', endPencil);
document.addEventListener('mouseup', (e) => { if(isDrawingPencil) endPencil(); });
document.addEventListener('touchend', (e) => { if(isDrawingPencil) endPencil(); });

// STANDARD GEOMAN DRAW BUTTONS
document.getElementById('draw-poly-btn').addEventListener('click', () => { isPencilMode = false; map.dragging.enable(); document.getElementById('map').classList.remove('pencil-mode'); map.pm.enableDraw('Polygon'); });
document.getElementById('draw-circle-btn').addEventListener('click', () => { isPencilMode = false; map.dragging.enable(); document.getElementById('map').classList.remove('pencil-mode'); map.pm.enableDraw('Circle'); });

// FIX 2: Safely delay disableDraw() to prevent Geoman event crash
map.on('pm:create', (e) => {
  const layer = e.layer; const shape = e.shape; 
  
  try {
    if (shape === 'Circle') layer.setStyle({ color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25 }); 
    else layer.setStyle({ color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.3 });
  } catch(err) {}

  editingZoneId = null;
  let zoneData = { id: 'zone-' + Date.now(), shapeType: shape === 'Circle' ? 'circle' : 'polygon', defaultName: `Custom Zone ${zones.length + 1}`, freq: scale[zones.length % scale.length], layer: layer };
  
  if (shape === 'Circle') { const ll = layer.getLatLng(); zoneData.lat = ll.lat; zoneData.lng = ll.lng; zoneData.radius = layer.getRadius(); } 
  else { const ll = layer.getLatLngs(); zoneData.latlngs = Array.isArray(ll[0]) ? ll[0] : ll; zoneData.fadeBuffer = 50; }
  
  setTimeout(() => {
    map.pm.disableDraw();
    openNewZoneModal(zoneData);
  }, 100); 
});

map.on('pm:remove', (e) => {
  const targetZone = zones.find(z => z.layer === e.layer);
  if (targetZone) window.removeZone(targetZone.id);
});

// SAFE MODAL OPENER
function openNewZoneModal(zoneData) {
  try {
    pendingZoneData = zoneData; 
    document.getElementById('modal-title').innerText = editingZoneId ? 'Edit Sound Zone' : 'Configure Sound Zone'; 
    document.getElementById('advanced-settings-panel').style.display = 'none';
    document.getElementById('cfg-name').value = zoneData.defaultName;
    
    const idsToClear = ['cfg-music-file', 'cfg-music-url', 'cfg-ambi-file', 'cfg-ambi-url', 'cfg-voice-file', 'cfg-voice-url', 
                        'cfg-shift1-music', 'cfg-shift1-ambi', 'cfg-shift1-voice', 'cfg-shift2-music', 'cfg-shift2-ambi', 'cfg-shift2-voice', 'cfg-zone-media', 'cfg-zone-desc'];
    idsToClear.forEach(elId => { const el = document.getElementById(elId); if(el) el.value = ''; });
    
    document.getElementById('cfg-time-of-day').value = 'always';
    document.getElementById('standard-stems-container').style.display = 'block';
    document.getElementById('fragment-stems-container').style.display = 'none';
    document.getElementById('cfg-fragment-times').style.display = 'none';
    
    document.getElementById('cfg-radius-group').style.display = zoneData.shapeType === 'circle' ? 'block' : 'none';
    document.getElementById('cfg-fade-group').style.display = zoneData.shapeType === 'polygon' ? 'block' : 'none';
    if (zoneData.shapeType === 'circle') document.getElementById('cfg-radius').value = Math.round(zoneData.radius); 
    else document.getElementById('cfg-fade').value = Math.round(zoneData.fadeBuffer);
    
    document.getElementById('config-modal').style.display = 'flex';
  } catch(err) {
    alert("Modal Error: " + err.message);
  }
}

document.getElementById('cfg-save-btn').addEventListener('click', () => {
  if (editingZoneId) saveHistoryState();
  
  pendingZoneData.name = document.getElementById('cfg-name').value || pendingZoneData.defaultName;
  pendingZoneData.desc = document.getElementById('cfg-zone-desc').value.trim();
  pendingZoneData.timeOfDay = document.getElementById('cfg-time-of-day').value;
  pendingZoneData.fxFilter = parseInt(document.getElementById('cfg-fx-filter').value);
  pendingZoneData.fxDelay = parseInt(document.getElementById('cfg-fx-delay').value);
  
  if (pendingZoneData.timeOfDay === 'split') {
    pendingZoneData.shift1Start = document.getElementById('cfg-shift1-start').value;
    pendingZoneData.shift1End = document.getElementById('cfg-shift1-end').value;
    pendingZoneData.shift2Start = document.getElementById('cfg-shift2-start').value;
    pendingZoneData.shift2End = document.getElementById('cfg-shift2-end').value;
  }
  
  const mediaFile = document.getElementById('cfg-zone-media').files[0];
  if (mediaFile) pendingZoneData.media = mediaFile;

  if (pendingZoneData.shapeType === 'circle') { pendingZoneData.radius = parseFloat(document.getElementById('cfg-radius').value) || pendingZoneData.radius; pendingZoneData.layer.setRadius(pendingZoneData.radius); }
  else { pendingZoneData.fadeBuffer = parseFloat(document.getElementById('cfg-fade').value) || pendingZoneData.fadeBuffer; }
  
  let oldS = pendingZoneData.savedSources || {};
  let finalSources = {};

  if (pendingZoneData.timeOfDay === 'split') {
    finalSources.shift1Music = document.getElementById('cfg-shift1-music').files[0] || oldS.shift1Music;
    finalSources.shift1Ambi = document.getElementById('cfg-shift1-ambi').files[0] || oldS.shift1Ambi;
    finalSources.shift1Voice = document.getElementById('cfg-shift1-voice').files[0] || oldS.shift1Voice;
    finalSources.shift2Music = document.getElementById('cfg-shift2-music').files[0] || oldS.shift2Music;
    finalSources.shift2Ambi = document.getElementById('cfg-shift2-ambi').files[0] || oldS.shift2Ambi;
    finalSources.shift2Voice = document.getElementById('cfg-shift2-voice').files[0] || oldS.shift2Voice;
  } else {
    finalSources.music = document.getElementById('cfg-music-file').files[0] || document.getElementById('cfg-music-url').value.trim() || oldS.music;
    finalSources.ambience = document.getElementById('cfg-ambi-file').files[0] || document.getElementById('cfg-ambi-url').value.trim() || oldS.ambience;
    finalSources.voice = document.getElementById('cfg-voice-file').files[0] || document.getElementById('cfg-voice-url').value.trim() || oldS.voice;
  }

  if (editingZoneId) {
    setupZoneStems(pendingZoneData, finalSources);
    updateAudio(userMarker.getLatLng().lat, userMarker.getLatLng().lng); 
    renderCarousel();
  } else {
    registerSoundZone(pendingZoneData, finalSources);
  }
  
  document.getElementById('config-modal').style.display = 'none'; 
  pendingZoneData = null; editingZoneId = null; map.pm.disableDraw();
});

document.getElementById('cfg-cancel-btn').addEventListener('click', () => {
  if (!editingZoneId && pendingZoneData && pendingZoneData.layer) map.removeLayer(pendingZoneData.layer);
  document.getElementById('config-modal').style.display = 'none'; pendingZoneData = null; editingZoneId = null; map.pm.disableDraw();
});

document.getElementById('btn-save-menu').addEventListener('click', () => { document.getElementById('save-modal').style.display = 'flex'; });
document.getElementById('btn-load-menu').addEventListener('click', () => {
  if (zones.length > 0) {
    if (!confirm("You currently have an active Sonomap project.\n\nSave it first?\n\n(Click 'OK' to open Save Menu, or 'Cancel' to load new map)")) { document.getElementById('import-file').click(); }
    else { document.getElementById('save-modal').style.display = 'flex'; }
  } else { document.getElementById('import-file').click(); }
});

document.getElementById('btn-publish-share').addEventListener('click', async (e) => {
  const btn = e.target; btn.innerText = "⏳ Uploading to Cloud..."; btn.disabled = true;
  try {
    const projectTitle = document.getElementById('save-project-title').value || "Custom Sonomap";
    const albumDesc = document.getElementById('album-desc').value.trim();
    const albumFile = document.getElementById('album-media-file').files[0];
    let globalAlbumUrl = null;

    if (albumFile) {
      const ext = albumFile.name.split('.').pop();
      const filePath = `album_${Date.now()}.${ext}`;
      const { error } = await supabase.storage.from('sonomap-assets').upload(filePath, albumFile);
      if (!error) globalAlbumUrl = supabase.storage.from('sonomap-assets').getPublicUrl(filePath).data.publicUrl;
    }

    const dbZones = [];
    for (let z of zones) {
      const zoneDef = { 
        id: z.id, name: z.name, shapeType: z.shapeType, lat: z.lat, lng: z.lng, radius: z.radius, 
        latlngs: z.latlngs, fadeBuffer: z.fadeBuffer, freq: z.freq, layers: [], desc: z.desc || '', 
        timeOfDay: z.timeOfDay || 'always', shift1Start: z.shift1Start, shift1End: z.shift1End, shift2Start: z.shift2Start, shift2End: z.shift2End,
        fxFilter: z.fxFilter, fxDelay: z.fxDelay
      };
      
      if (z.media instanceof Blob) {
        const ext = z.media.name.split('.').pop();
        const filePath = `zone_media_${Date.now()}_${z.id}.${ext}`;
        const { error } = await supabase.storage.from('sonomap-assets').upload(filePath, z.media);
        if (!error) zoneDef.mediaUrl = supabase.storage.from('sonomap-assets').getPublicUrl(filePath).data.publicUrl;
      } else if (typeof z.media === 'string') {
        zoneDef.mediaUrl = z.media;
      }

      for (let s of z.stems) {
        const stemDef = { category: s.category, baseVolume: s.baseVol, shift: s.shift || 'any' };
        if (s.rawSource instanceof Blob) {
          const ext = (s.rawSource.name && s.rawSource.name.split('.').pop()) || 'mp3';
          const filePath = `${Date.now()}_${z.id}_${s.category}_${s.shift || 'any'}.${ext}`;
          const { error } = await supabase.storage.from('sonomap-assets').upload(filePath, s.rawSource);
          if (!error) stemDef.url = supabase.storage.from('sonomap-assets').getPublicUrl(filePath).data.publicUrl;
        } else if (typeof s.rawSource === 'string') { stemDef.url = s.rawSource; }
        zoneDef.layers.push(stemDef);
      }
      dbZones.push(zoneDef);
    }

    const { data: rowData, error: dbError } = await supabase.from('scenes').insert([{ 
      title: projectTitle, description: albumDesc, cover_url: globalAlbumUrl,
      bpm: bpm, initial_lat: map.getCenter().lat, initial_lng: map.getCenter().lng, initial_zoom: map.getZoom(), zones: dbZones 
    }]).select().single();

    if (dbError) throw dbError;
    const shareLink = `${window.location.origin}/?scene=${rowData.id}`;
    await navigator.clipboard.writeText(shareLink);
    btn.innerText = "✅ Link Copied!";
    setTimeout(() => { btn.innerText = "☁ Publish to Sonomaps Cloud"; btn.disabled = false; }, 3000);

  } catch (err) { alert("Publish failed: " + err.message); btn.innerText = "☁️ Publish to Sonomaps Cloud"; btn.disabled = false; }
});

document.getElementById('btn-download-sonomap').addEventListener('click', async () => {
  document.getElementById('save-modal').style.display = 'none';
  const zip = new JSZip(); const audioFolder = zip.folder("audio"); const mediaFolder = zip.folder("media"); 
  const projectTitle = document.getElementById('save-project-title').value || "Custom Sonomap";
  const albumDesc = document.getElementById('album-desc').value.trim();
  const safeTitle = projectTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  
  const sceneData = { version: 1, projectId: "sonomap-" + Date.now(), name: projectTitle, description: albumDesc, bpm: bpm, initialRegion: { latitude: map.getCenter().lat, longitude: map.getCenter().lng, zoom: map.getZoom() }, zones: [] };

  const albumFile = document.getElementById('album-media-file').files[0];
  if (albumFile) {
    const ext = albumFile.name.split('.').pop();
    mediaFolder.file(`album_cover.${ext}`, albumFile);
    sceneData.coverFile = `media/album_cover.${ext}`;
  }

  for (let z of zones) {
    const zoneDef = { 
      id: z.id, name: z.name, shapeType: z.shapeType, lat: z.lat, lng: z.lng, radius: z.radius, 
      latlngs: z.latlngs, fadeBuffer: z.fadeBuffer, freq: z.freq, layers: [], desc: z.desc || '', 
      timeOfDay: z.timeOfDay || 'always', shift1Start: z.shift1Start, shift1End: z.shift1End, shift2Start: z.shift2Start, shift2End: z.shift2End,
      fxFilter: z.fxFilter, fxDelay: z.fxDelay
    };
    
    if (z.media instanceof Blob) {
       const ext = z.media.name.split('.').pop();
       const filename = `${z.id}_media.${ext}`; mediaFolder.file(filename, z.media); zoneDef.mediaFile = `media/${filename}`;
    } else if (typeof z.media === 'string') { zoneDef.mediaUrl = z.media; }

    for (let s of z.stems) {
      const stemDef = { category: s.category, baseVolume: s.baseVol, shift: s.shift || 'any' };
      if (s.rawSource instanceof Blob) {
        const ext = (s.rawSource.name && s.rawSource.name.split('.').pop()) || 'mp3';
        const filename = `${z.id}_${s.category}_${s.shift || 'any'}.${ext}`; audioFolder.folder(s.category).file(filename, s.rawSource); stemDef.file = `audio/${s.category}/${filename}`;
      } else if (typeof s.rawSource === 'string') stemDef.url = s.rawSource;
      zoneDef.layers.push(stemDef);
    } sceneData.zones.push(zoneDef);
  }
  zip.file("scene.json", JSON.stringify(sceneData, null, 2));
  const content = await zip.generateAsync({ type: "blob" });
  const a = document.createElement('a'); a.href = URL.createObjectURL(content); a.download = `${safeTitle}.sonomap`; a.click();
});

document.getElementById('import-file').addEventListener('change', async (e) => {
  if (!e.target.files[0]) return;
  try {
    const zip = await JSZip.loadAsync(e.target.files[0]);
    const sceneFile = zip.file("scene.json"); if (!sceneFile) throw new Error("Missing scene.json");
    const sceneJSON = JSON.parse(await sceneFile.async("text")); const assetBlobs = {};
    const assetFiles = Object.keys(zip.files).filter(k => (k.startsWith('audio/') || k.startsWith('media/')) && !zip.files[k].dir);
    for (let path of assetFiles) assetBlobs[path] = await zip.files[path].async("blob");
    
    saveHistoryState();
    [...zones].forEach(z => window.removeZone(z.id));
    
    if (sceneJSON.name) { document.querySelector('.brand-title').innerText = sceneJSON.name; document.getElementById('save-project-title').value = sceneJSON.name; }
    if (sceneJSON.description) document.getElementById('album-desc').value = sceneJSON.description;

    (sceneJSON.zones || []).forEach(zData => {
      let layer = zData.shapeType === 'circle' ? L.circle([zData.lat, zData.lng], { color: '#10b981', fillColor: '#10b981', fillOpacity: 0.25, radius: zData.radius }).addTo(map) : L.polygon(zData.latlngs, { color: '#8b5cf6', fillColor: '#8b5cf6', fillOpacity: 0.3 }).addTo(map);
      if (layer) {
        zData.layer = layer; 
        if (zData.mediaFile && assetBlobs[zData.mediaFile]) zData.media = assetBlobs[zData.mediaFile]; else if (zData.mediaUrl) zData.media = zData.mediaUrl;
        
        const sourceMap = {};
        (zData.layers || []).forEach(l => { 
          const key = l.shift && l.shift !== 'any' ? l.shift + l.category.charAt(0).toUpperCase() + l.category.slice(1) : l.category;
          if (l.file && assetBlobs[l.file]) sourceMap[key] = assetBlobs[l.file]; else if (l.url) sourceMap[key] = l.url; 
        });
        registerSoundZone(zData, sourceMap);
      }
    });
  } catch (err) { alert('Could not open .sonomap: ' + err.message); }
});
