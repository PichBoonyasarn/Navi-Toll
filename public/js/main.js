let googleMapsKey = '';
let mapInstance = null;
let mapOverlays = [];
let selectedDestCoord = null; // set when user picks a coord from a document

// ── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function setStatus(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
}

function formatDuration(seconds) {
  if (seconds == null) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

function formatDistance(meters) {
  if (meters == null) return '—';
  return (meters / 1000).toFixed(1) + ' km';
}

function formatToll(tollEstimate) {
  if (!tollEstimate) return null;
  const { currencyCode, amount } = tollEstimate;
  return currencyCode === 'JPY' ? `¥${amount.toLocaleString('ja-JP')}` : `${amount.toLocaleString()} ${currencyCode}`;
}

// ── Collapsible origin/destination fields ──────────────────────────────────────

const FIELD_EMPTY_TEXT = { origin: '—', dest: 'ドキュメントをアップロードすると自動入力されます' };
const FIELD_EMPTY_LABEL = { origin: '変更', dest: '入力' };

function expandField(prefix) {
  document.getElementById(`${prefix}SummaryValue`).style.display = 'none';
  document.getElementById(`${prefix}InputRow`).style.display = 'flex';
  document.getElementById(`${prefix}ToggleBtn`).textContent = '閉じる';
  document.getElementById(`${prefix}Input`).focus();
}

function collapseField(prefix) {
  const valueEl = document.getElementById(`${prefix}SummaryValue`);
  const input = document.getElementById(`${prefix}Input`);
  const val = input.value.trim();

  valueEl.textContent = val || FIELD_EMPTY_TEXT[prefix];
  valueEl.classList.toggle('none', !val);
  valueEl.style.display = '';
  document.getElementById(`${prefix}InputRow`).style.display = 'none';
  document.getElementById(`${prefix}ToggleBtn`).textContent = val ? '変更' : FIELD_EMPTY_LABEL[prefix];
}

function setFieldSummary(prefix, text) {
  const valueEl = document.getElementById(`${prefix}SummaryValue`);
  valueEl.textContent = text;
  valueEl.classList.remove('none');
  valueEl.style.display = '';
  document.getElementById(`${prefix}InputRow`).style.display = 'none';
  document.getElementById(`${prefix}ToggleBtn`).textContent = '変更';
}

function toggleField(prefix) {
  const isEditing = document.getElementById(`${prefix}InputRow`).style.display !== 'none';
  if (isEditing) collapseField(prefix); else expandField(prefix);
}

// ── Copy-ready result line ──────────────────────────────────────────────────────

function copyWithFeedback(btn, text, idleLabel, copiedLabel) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = copiedLabel;
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = idleLabel; btn.classList.remove('copied'); }, 1500);
  });
}

function buildCopyLine(data, entryText, exitText, distanceText, durationText, tollText) {
  return [
    `距離 ${distanceText}`,
    `所要時間 ${durationText}`,
    `ETC料金 ${tollText}`,
    `入口IC ${entryText || '検出できませんでした'}`,
    `出口IC ${exitText || '検出できませんでした'}`,
  ].join('　');
}

// ── Google Maps loading ───────────────────────────────────────────────────────

function loadGoogleMapsScript(key, callback) {
  if (window._googleMapsReady) { callback(); return; }
  window._onGoogleMapsReady = callback;
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=places&language=ja&callback=initGoogleMaps`;
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
}

// ── Map rendering ─────────────────────────────────────────────────────────────

function clearOverlays() {
  mapOverlays.forEach(o => o.setMap(null));
  mapOverlays = [];
}

function renderMap(data, fromPos, toPos, fromLabel, toLabel) {
  const mapEl = document.getElementById('map');
  const mapWrap = document.getElementById('mapWrap');

  if (!data.path || !data.path.length) { mapWrap.style.display = 'none'; return; }
  mapWrap.style.display = 'block';

  if (!mapInstance) {
    mapInstance = new google.maps.Map(mapEl, {
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy',
      // Google's own scroll-to-zoom (scrollwheel: true) is tied to
      // gestureHandling: with 'cooperative' it requires ctrl+scroll but shows
      // a dimming "use ctrl+scroll to zoom" overlay every time; with 'greedy'
      // it zooms on any scroll with no overlay. Neither matches "require
      // ctrl, but never show the hint" — so scrollwheel zoom is disabled
      // here entirely and reimplemented by hand below.
      scrollwheel: false,
    });
    mapEl.addEventListener('wheel', e => {
      if (!e.ctrlKey && !e.metaKey) return; // let the page scroll normally
      e.preventDefault();
      mapInstance.setZoom(mapInstance.getZoom() + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }
  clearOverlays();

  const bounds = new google.maps.LatLngBounds();

  const addMarker = (position, title, color) => {
    const marker = new google.maps.Marker({
      position, map: mapInstance, title,
      icon: { url: `http://maps.google.com/mapfiles/ms/icons/${color}-dot.png` },
    });
    mapOverlays.push(marker);
    bounds.extend(position);
  };

  addMarker(fromPos, fromLabel, 'blue');
  addMarker(toPos, toLabel, 'red');

  const polyline = new google.maps.Polyline({
    path: data.path, map: mapInstance,
    strokeColor: '#4a6354', strokeWeight: 4, strokeOpacity: 0.85,
  });
  mapOverlays.push(polyline);
  data.path.forEach(p => bounds.extend(p));

  mapInstance.fitBounds(bounds);
}

// ── Result card ───────────────────────────────────────────────────────────────

function renderResult(data) {
  const wrap = document.getElementById('resultWrap');
  wrap.style.display = 'block';

  const setVal = (id, text, noneClass) => {
    const el = document.getElementById(id);
    el.textContent = text || '—';
    if (noneClass) el.classList.add('none'); else el.classList.remove('none');
  };

  const entryText = data.entryICs && data.entryICs.length ? data.entryICs.join(' / ') : null;
  const exitText  = data.exitICs  && data.exitICs.length  ? data.exitICs.join(' / ')  : null;
  setVal('resEntryIC',   entryText || '検出できませんでした', !entryText);
  setVal('resExitIC',    exitText  || '検出できませんでした', !exitText);
  const distanceText = formatDistance(data.distanceMeters);
  const durationText = formatDuration(data.durationSeconds);
  setVal('resDistance',  distanceText);
  setVal('resDuration',  durationText);

  const tollText = formatToll(data.tollEstimate);
  setVal('resToll', tollText || '高速道路なし（無料）', !tollText);

  const tollRoadsRow = document.getElementById('tollRoadsRow');
  const tollRoadsWrap = document.getElementById('resTollRoads');
  if (data.tollRoads && data.tollRoads.length) {
    tollRoadsRow.style.display = '';
    tollRoadsWrap.innerHTML = data.tollRoads
      .map(name => `<span class="toll-chip">${name}</span>`)
      .join('');
  } else {
    tollRoadsRow.style.display = 'none';
    tollRoadsWrap.innerHTML = '';
  }

  document.getElementById('copyText').textContent = buildCopyLine(
    data, entryText, exitText, distanceText, durationText, tollText || '高速道路なし（無料）'
  );
}

// ── Geocoding ─────────────────────────────────────────────────────────────────

async function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address, region: 'jp' }, (results, status) => {
      if (status === 'OK' && results.length) {
        const loc = results[0].geometry.location;
        resolve({ lat: loc.lat(), lng: loc.lng(), formatted: results[0].formatted_address });
      } else {
        reject(new Error(`住所が見つかりません: ${address}`));
      }
    });
  });
}

// ── File upload & coordinate picker ──────────────────────────────────────────

function renderCoordPicker(coords, filename) {
  const wrap = document.getElementById('coordPickerWrap');
  const header = document.getElementById('coordPickerHeader');
  const list = document.getElementById('coordList');

  wrap.style.display = 'block';

  if (!coords || coords.length === 0) {
    header.textContent = `${filename} — 座標が見つかりませんでした`;
    list.innerHTML = `
      <div class="coord-none">
        このファイルから緯度・経度を自動検出できませんでした。
        <button class="btn-link" id="manualEntryHintBtn">目的地を直接入力する</button>
      </div>
    `;
    document.getElementById('manualEntryHintBtn').addEventListener('click', () => expandField('dest'));
    return;
  }

  header.textContent = `${filename} — ${coords.length}件の座標が見つかりました`;
  list.innerHTML = coords.map((c, i) => `
    <div class="coord-item" data-idx="${i}">
      <div class="coord-item-icon">📍</div>
      <div class="coord-item-body">
        <div class="coord-item-value">${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}</div>
        <div class="coord-item-context">元データ: ${escapeHtml(c.context || '')}</div>
      </div>
    </div>
  `).join('');

  // Auto-pick the first coordinate found and search immediately. The list is
  // read-only display from here on (not clickable) — users can select/copy
  // the lat/lng text without accidentally re-triggering a route search.
  selectCoordItem(coords, 0, list);
}

function renderExtractedText(text) {
  const wrap = document.getElementById('extractedTextWrap');
  const body = document.getElementById('extractedTextBody');
  const toggleBtn = document.getElementById('extractedTextToggleBtn');

  if (!text) { wrap.style.display = 'none'; return; }

  wrap.style.display = 'block';
  body.textContent = text; // textContent, not innerHTML — this is untrusted file content
  body.style.display = 'none';
  toggleBtn.textContent = '抽出テキストを表示';
}

function selectCoordItem(coords, idx, listEl) {
  const c = coords[idx];
  selectedDestCoord = { lat: c.lat, lng: c.lng };
  document.getElementById('destInput').value = `${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
  collapseField('dest');

  listEl.querySelectorAll('.coord-item').forEach(e => e.style.borderColor = '');
  const el = listEl.querySelector(`.coord-item[data-idx="${idx}"]`);
  if (el) { el.style.borderColor = 'var(--moss)'; el.style.background = '#e8f0ea'; }

  onSearch();
}

async function uploadFile(file) {
  const zone = document.getElementById('dropZone');
  zone.classList.add('processing');
  setStatus(`「${file.name}」を解析中…`);

  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/parse-document', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'ファイルの解析に失敗しました');
    renderCoordPicker(data.coordinates, data.filename);
    renderExtractedText(data.extractedText || '');
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    zone.classList.remove('processing');
  }
}

function initFileUpload() {
  const zone = document.getElementById('dropZone');
  const input = document.getElementById('fileInput');
  const pickBtn = document.getElementById('filePickBtn');

  pickBtn.addEventListener('click', e => { e.stopPropagation(); input.click(); });
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) uploadFile(input.files[0]); input.value = ''; });

  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag-over'); });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) uploadFile(file);
  });

  // Clear selected coord when destination is manually edited
  document.getElementById('destInput').addEventListener('input', () => { selectedDestCoord = null; });

  document.getElementById('extractedTextToggleBtn').addEventListener('click', () => {
    const body = document.getElementById('extractedTextBody');
    const btn = document.getElementById('extractedTextToggleBtn');
    const isHidden = body.style.display === 'none';
    body.style.display = isHidden ? 'block' : 'none';
    btn.textContent = isHidden ? '抽出テキストを隠す' : '抽出テキストを表示';
  });
}

// ── Search ────────────────────────────────────────────────────────────────────

async function onSearch() {
  const originVal = document.getElementById('originInput').value.trim();
  const destVal   = document.getElementById('destInput').value.trim();

  if (!originVal) { setStatus('出発地を入力してください。', true); return; }
  if (!destVal)   { setStatus('目的地を入力してください。', true); return; }

  const btn = document.getElementById('searchBtn');
  btn.disabled = true;
  setStatus('ルートを検索中…');
  document.getElementById('resultWrap').style.display = 'none';
  document.getElementById('mapWrap').style.display = 'none';

  try {
    setStatus('出発地を検索中…');
    const from = await geocodeAddress(originVal);

    let to;
    if (selectedDestCoord) {
      // Raw coord from document — skip geocoding
      setStatus('目的地の座標を使用中…');
      to = { lat: selectedDestCoord.lat, lng: selectedDestCoord.lng, formatted: destVal };
    } else {
      setStatus('目的地を検索中…');
      to = await geocodeAddress(destVal);
    }

    setStatus('ルートと料金を計算中…');
    const params = `fromLat=${from.lat}&fromLng=${from.lng}&toLat=${to.lat}&toLng=${to.lng}`;
    const res = await fetch(`/api/routes/leg?${params}`, { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'ルート計算に失敗しました');

    renderMap(data, { lat: from.lat, lng: from.lng }, { lat: to.lat, lng: to.lng }, from.formatted, to.formatted);
    renderResult(data);
    setFieldSummary('origin', from.formatted);
    setFieldSummary('dest', to.formatted);
    setStatus('');
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ── Geolocation buttons ───────────────────────────────────────────────────────

function attachGeoButton(btnId, inputId) {
  document.getElementById(btnId).addEventListener('click', () => {
    if (!navigator.geolocation) { setStatus('位置情報がご利用いただけません。', true); return; }
    setStatus('現在地を取得中…');
    navigator.geolocation.getCurrentPosition(pos => {
      const { latitude: lat, longitude: lng } = pos.coords;
      const geocoder = new google.maps.Geocoder();
      geocoder.geocode({ location: { lat, lng }, region: 'jp' }, (results, status) => {
        if (status === 'OK' && results.length) {
          document.getElementById(inputId).value = results[0].formatted_address;
        } else {
          document.getElementById(inputId).value = `${lat.toFixed(6)},${lng.toFixed(6)}`;
        }
        setStatus('');
      });
    }, () => setStatus('位置情報の取得に失敗しました。', true));
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function initApp() {
  const cfgRes = await fetch('/api/config');
  const cfg = await cfgRes.json();
  googleMapsKey = cfg.googleMapsKey;

  if (cfg.companyAddress) {
    document.getElementById('originInput').value = cfg.companyAddress;
  }
  collapseField('origin');

  document.getElementById('originToggleBtn').addEventListener('click', () => toggleField('origin'));
  document.getElementById('destToggleBtn').addEventListener('click', () => toggleField('dest'));

  document.getElementById('copyBtn').addEventListener('click', () => {
    const btn = document.getElementById('copyBtn');
    copyWithFeedback(btn, document.getElementById('copyText').textContent, '📋 コピー', '✓ コピーしました');
  });

  document.querySelectorAll('.btn-copy-mini').forEach(btn => {
    btn.addEventListener('click', () => {
      const text = document.getElementById(btn.dataset.copyTarget).textContent;
      copyWithFeedback(btn, text, '📋', '✓');
    });
  });

  initFileUpload();

  loadGoogleMapsScript(googleMapsKey, () => {
    // Places Autocomplete for both inputs
    const acOptions = { componentRestrictions: { country: 'jp' }, types: ['geocode', 'establishment'] };
    new google.maps.places.Autocomplete(document.getElementById('originInput'), acOptions);
    new google.maps.places.Autocomplete(document.getElementById('destInput'), acOptions);

    attachGeoButton('originGeoBtn', 'originInput');
    attachGeoButton('destGeoBtn', 'destInput');

    document.getElementById('searchBtn').addEventListener('click', onSearch);
    document.getElementById('destInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') onSearch();
    });
    document.getElementById('originInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') onSearch();
    });
  });
}

initApp().catch(err => setStatus('初期化エラー: ' + err.message, true));
