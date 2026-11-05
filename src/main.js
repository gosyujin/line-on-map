import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { buildGraph, findRoutes, routeSteps, stationIds, suggestStations } from './route.js';

const CATEGORIES = [
  // 描画順(下 → 上)
  { key: 'bus', label: 'バス', width: [10, 1.2, 15, 3.5] },
  { key: 'train', label: '電車', width: [10, 2, 15, 6] },
  { key: 'subway', label: '地下鉄', width: [10, 2, 15, 6] },
];
const LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const CAT_ORDER = { subway: 0, train: 1, bus: 2 };

const TOKYO = { center: [139.76, 35.68], zoom: 10.6 };
const JAPAN = { center: [137.5, 37.5], zoom: 4.6 };
const HIGHLIGHT = '#ff8a00';

const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN.center,
  zoom: JAPAN.zoom,
  minZoom: 3,
  maxZoom: 19,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution:
          '地図・路線データ © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      },
    },
    layers: [
      {
        id: 'osm',
        type: 'raster',
        source: 'osm',
        // 路線の色が目立つように、背景地図の彩度を少し落とす
        paint: { 'raster-saturation': -0.55, 'raster-brightness-min': 0.12 },
      },
    ],
  },
});
// タッチ端末はピンチで拡大縮小できるので、ズームボタンは出さず地図の領域を空ける
const isTouch = window.matchMedia('(pointer: coarse)').matches;
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showZoom: !isTouch }), 'top-right');
const geolocate = new maplibregl.GeolocateControl({
  // PC には GPS がなく、高精度指定だと取得に失敗・遅延しやすいのでタッチ端末だけにする
  positionOptions: { enableHighAccuracy: isTouch, timeout: 15_000, maximumAge: 60_000 },
  trackUserLocation: true,
  showUserLocation: true,
  showAccuracyCircle: true,
  // スケールバーが 1km 表示になるズーム (東京付近で約 12.5)。精度円が小さくてもこれ以上は寄らない
  fitBoundsOptions: { maxZoom: 12.5 },
});
map.addControl(geolocate, 'top-right');
geolocate.on('error', (e) => {
  const reasons = { 1: '位置情報の利用が許可されていません', 2: '現在地を特定できませんでした', 3: '現在地の取得がタイムアウトしました' };
  console.warn('geolocation error', e.code, e.message);
  setStatus(reasons[e.code] ?? `現在地を取得できませんでした (${e.message})`, 6000);
});
// 「東京」「日本全体」へ移動するアイコンボタン
class JumpControl {
  onAdd(m) {
    const icons = {
      tokyo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.800 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
      japan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.800 0 18M12 3c-3 3.200-3 14.800 0 18"/></svg>',
    };
    const targets = [
      ['tokyo', '東京へ移動', TOKYO],
      ['japan', '日本全体を表示', JAPAN],
    ];
    this.el = document.createElement('div');
    this.el.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    for (const [key, label, target] of targets) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'jump-btn';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.innerHTML = icons[key];
      b.addEventListener('click', () => m.flyTo({ ...target, duration: 1500 }));
      this.el.append(b);
    }
    return this.el;
  }

  onRemove() {
    this.el.remove();
  }
}
map.addControl(new JumpControl(), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'),
  panel: $('panel'),
  badge: $('panel-badge'),
  title: $('panel-title'),
  sub: $('panel-sub'),
  detail: $('panel-detail'),
  btnSolo: $('btn-solo'),
  others: $('panel-others'),
  othersLabel: $('panel-others-label'),
  othersList: $('panel-others-list'),
  search: $('line-search'),
  list: $('line-list'),
  resetView: $('btn-reset-view'),
  filterRow: $('filter-row'),
  btnSearch: $('btn-search'),
  btnRoute: $('btn-route'),
  routePanel: $('route-panel'),
  routeFrom: $('route-from'),
  routeTo: $('route-to'),
  routeFromList: $('route-from-list'),
  routeToList: $('route-to-list'),
  routeBus: $('route-bus'),
  routeWalk: $('route-walk'),
  routeMsg: $('route-msg'),
  routeResults: $('route-results'),
};

// ---- 状態 ------------------------------------------------------------------

// 路線の一覧(名前・色・範囲・属するエリア)は index.json から全件を最初に読み込む。
// 路線・駅のジオメトリはエリア別のファイルで、表示範囲に入ったエリアだけを読み込む。
const lineIndex = new Map(); // `${cat}:${gid}` → { properties, bbox, areas }
let areas = []; // { id, name, bbox }
const loadedAreas = new Map(); // エリア id → 読み込みの Promise
const dataByCat = Object.fromEntries(
  CATEGORIES.map(({ key }) => [
    key,
    { lines: { type: 'FeatureCollection', features: [] }, stops: { type: 'FeatureCollection', features: [] } },
  ]),
);
let allStops = []; // 読み込み済みエリアの駅・停留所(接続路線の検索用)
let selected = null; // 強調表示中の路線 { cat, gid }
// 表示モード: 全路線 / 1路線だけ / 駅に接続する路線だけ / ルート検索の結果の路線だけ
let view = { mode: 'all' };
const catVisible = Object.fromEntries(CATEGORIES.map((c) => [c.key, true]));

// 電車・地下鉄・バスの表示/非表示は localStorage に保存し、次回起動時に復元する
const CAT_STORAGE_KEY = 'line-on-map:cat-visible';

function loadCatVisible() {
  try {
    const saved = JSON.parse(localStorage.getItem(CAT_STORAGE_KEY));
    if (!saved || typeof saved !== 'object') return;
    for (const { key } of CATEGORIES) {
      if (typeof saved[key] === 'boolean') catVisible[key] = saved[key];
    }
  } catch {
    // 保存データが壊れている・localStorage が使えない場合は初期値(すべて表示)のまま
  }
}

function saveCatVisible() {
  try {
    localStorage.setItem(CAT_STORAGE_KEY, JSON.stringify(catVisible));
  } catch {
    // 容量超過やプライベートモードでは保存できないが、動作には影響しない
  }
}

loadCatVisible();
for (const { key } of CATEGORIES) {
  document.querySelector(`#controls input[data-cat="${key}"]`).checked = catVisible[key];
}
let panelState = null; // { type: 'line', sel } | { type: 'station' }

const lineLayerIds = CATEGORIES.map((c) => `${c.key}-line`);
const hitLayerIds = CATEGORIES.map((c) => `${c.key}-hit`);
const FILTERED = ['casing', 'line', 'hit', 'stop'];
const ALL_SUFFIXES = [...FILTERED, 'glow', 'sel-casing', 'sel-line', 'stop-sel'];

const lineOf = (cat, gid) => lineIndex.get(`${cat}:${gid}`);
const sameLine = (a, b) => a && b && a.cat === b.cat && a.gid === b.gid;

// ---- レイヤー --------------------------------------------------------------

function addCategoryLayers({ key, width }) {
  const base = { type: 'line', source: key, layout: { 'line-cap': 'round', 'line-join': 'round' } };
  map.addLayer({
    ...base,
    id: `${key}-casing`,
    paint: {
      'line-color': '#fff',
      'line-width': ['interpolate', ['linear'], ['zoom'], ...width.map((v, i) => (i % 2 ? v + 1.5 : v))],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    ...base,
    id: `${key}-line`,
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': ['interpolate', ['linear'], ['zoom'], ...width],
      'line-opacity': 1,
    },
  });
  // タップしやすいように、見た目より太い透明レイヤーでヒット判定する
  map.addLayer({
    ...base,
    id: `${key}-hit`,
    paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 },
  });
}

function addHighlightLayers() {
  const none = ['==', ['get', 'gid'], -1];
  for (const { key, width } of CATEGORIES) {
    const common = { type: 'line', source: key, filter: none, layout: { 'line-cap': 'round', 'line-join': 'round' } };
    // オレンジのグロー
    map.addLayer({
      ...common,
      id: `${key}-glow`,
      paint: {
        'line-color': HIGHLIGHT,
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 12, 15, 30],
        'line-blur': ['interpolate', ['linear'], ['zoom'], 10, 8, 15, 18],
        'line-opacity': 0.85,
      },
    });
    map.addLayer({
      ...common,
      id: `${key}-sel-casing`,
      paint: {
        'line-color': '#fff',
        'line-width': ['interpolate', ['linear'], ['zoom'], ...width.map((v, i) => (i % 2 ? v + 3 : v + 1))],
      },
    });
    map.addLayer({
      ...common,
      id: `${key}-sel-line`,
      paint: {
        'line-color': ['get', 'colour'],
        'line-width': ['interpolate', ['linear'], ['zoom'], ...width.map((v, i) => (i % 2 ? v + 1 : v))],
      },
    });
  }
}

// 駅・停留所の丸印。バスは数が多いのでズームしたときだけ表示する。
function addStopLayers() {
  for (const { key } of CATEGORIES) {
    const minzoom = key === 'bus' ? 14 : 11.5;
    const r = key === 'bus' ? [14, 2.5, 17, 5] : [11.5, 2.5, 16, 6.5];
    map.addLayer({
      id: `${key}-stop`,
      type: 'circle',
      source: `${key}-stops`,
      minzoom,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], ...r],
        'circle-color': '#fff',
        'circle-stroke-color': ['get', 'colour'],
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], minzoom, 1.2, 16, 2.5],
      },
    });
  }
  // 選択中の路線の駅は、引いた縮尺でも見えるように大きめに出す
  for (const { key } of CATEGORIES) {
    map.addLayer({
      id: `${key}-stop-sel`,
      type: 'circle',
      source: `${key}-stops`,
      filter: ['==', ['get', 'gid'], -1],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 12, 5, 16, 8],
        'circle-color': '#fff',
        'circle-stroke-color': '#222',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 9, 1.5, 16, 3],
      },
    });
  }
}

// ---- 表示モード(全路線 / 1路線だけ / 駅の接続路線だけ) -----------------------

function allowedGids(cat) {
  if (view.mode === 'solo') return view.cat === cat ? [view.gid] : [];
  if (view.mode === 'station' || view.mode === 'route') return view.lines.filter((l) => l.cat === cat).map((l) => l.gid);
  return null; // 制限なし
}

function applyView() {
  for (const { key } of CATEGORIES) {
    const gids = allowedGids(key);
    const visible = catVisible[key] && (gids === null || gids.length > 0);
    const filter = gids === null ? null : ['in', ['get', 'gid'], ['literal', gids]];
    for (const suffix of ALL_SUFFIXES) {
      map.setLayoutProperty(`${key}-${suffix}`, 'visibility', visible ? 'visible' : 'none');
    }
    for (const suffix of FILTERED) map.setFilter(`${key}-${suffix}`, filter);
  }
  if (view.mode !== 'route') clearRouteMarks();
  updateFilterRow();
  renderActions();
  syncLabels();
}

// 表示対象のカテゴリが非表示にされていたら表示に戻す
function ensureVisible(cats) {
  for (const cat of cats) {
    catVisible[cat] = true;
    document.querySelector(`#controls input[data-cat="${cat}"]`).checked = true;
  }
  saveCatVisible();
}

async function showOnly(sel, { fit = true } = {}) {
  const f = lineOf(sel.cat, sel.gid);
  // 検索などで、まだ読み込んでいないエリアの路線が選ばれたときは、先にそのエリアを読み込む
  if (f && !f.areas.every((id) => loadedAreas.has(id))) {
    await Promise.all(f.areas.map(loadArea)).catch(showLoadError);
  }
  ensureVisible([sel.cat]);
  view = { mode: 'solo', ...sel };
  popup?.remove();
  applyView();
  select(sel);
  setSearchLabel(f?.properties.name ?? '');
  if (fit && f) fitTo(f);
}

function showStation(name, lngLat, lines) {
  ensureVisible(lines.map((l) => l.cat));
  view = { mode: 'station', name, lines };
  setSearchLabel(`${name}の接続路線`);
  setSelection(null);
  applyView();
  showStationPanel(name, lines);
  map.easeTo({ center: lngLat, zoom: Math.max(map.getZoom(), 12), duration: 600 });
}

function resetView() {
  view = { mode: 'all' };
  setSearchLabel('');
  applyView();
  if (panelState?.type === 'station') closePanel();
}

// ---- 駅名の吹き出し(路線の選択中・1路線だけ表示中) ------------------------------------------
// 日本語のフォントデータを持たないため、MapLibre のシンボルレイヤーではなく
// 地図の上に重ねた HTML で描画する。重なる吹き出しは、上→下の順に置き直し、置けなければ隠す。

const labelLayer = document.createElement('div');
labelLayer.id = 'labels';
map.getContainer().append(labelLayer);

let labels = []; // { el, lon, lat, w, h }
let labelKey = '';
let labelRaf = 0;

const MAX_LABEL_CHARS = 6;
const shortName = (name) => (name.length > MAX_LABEL_CHARS ? `${name.slice(0, MAX_LABEL_CHARS - 1)}…` : name);

function syncLabels() {
  // 選択中の路線の駅に吹き出しを出す。1路線だけ表示中は、選択を外しても出し続ける
  const target = selected ?? (view.mode === 'solo' ? view : null);
  const key = target ? `${target.cat}:${target.gid}` : '';
  if (key === labelKey) return;
  labelKey = key;
  labelLayer.replaceChildren();
  labels = [];
  if (!key) return;
  const colour = lineOf(target.cat, target.gid)?.properties.colour;
  const stops = allStops.filter((s) => s.cat === target.cat && s.gid === target.gid);
  labels = stops.map((s) => {
    const div = document.createElement('div');
    div.className = 'stop-label';
    div.textContent = shortName(s.name);
    div.style.setProperty('--c', colour);
    labelLayer.append(div);
    return { el: div, lon: s.lon, lat: s.lat, w: 0, h: 0 };
  });
  // 寸法は描画後でないと測れない
  for (const l of labels) {
    l.w = l.el.offsetWidth;
    l.h = l.el.offsetHeight;
  }
  scheduleLabels();
}

function scheduleLabels() {
  if (!labels.length || labelRaf) return;
  labelRaf = requestAnimationFrame(() => {
    labelRaf = 0;
    placeLabels();
  });
}

function placeLabels() {
  const { clientWidth: W, clientHeight: H } = labelLayer;
  const GAP = 11; // 丸印との間隔(しっぽの分)
  const placed = [];
  const hit = (r) =>
    placed.some((p) => r.x < p.x + p.w + 2 && r.x + r.w + 2 > p.x && r.y < p.y + p.h + 2 && r.y + r.h + 2 > p.y);
  for (const l of labels) {
    const p = map.project([l.lon, l.lat]);
    const x = Math.round(p.x - l.w / 2);
    const above = { x, y: Math.round(p.y - l.h - GAP), w: l.w, h: l.h };
    const below = { x, y: Math.round(p.y + GAP), w: l.w, h: l.h };
    const onScreen = (r) => r.x + r.w > 0 && r.x < W && r.y + r.h > 0 && r.y < H;
    const pick = [
      [above, false],
      [below, true],
    ].find(([r]) => onScreen(r) && !hit(r));
    if (!pick) {
      l.el.style.visibility = 'hidden';
      continue;
    }
    const [r, isBelow] = pick;
    placed.push(r);
    l.el.classList.toggle('below', isBelow);
    l.el.style.transform = `translate(${r.x}px, ${r.y}px)`;
    l.el.style.visibility = 'visible';
  }
}

map.on('move', scheduleLabels);
map.on('resize', scheduleLabels);

// ---- 選択(強調表示)とパネル ------------------------------------------------

function setSelection(sel) {
  selected = sel;
  for (const { key } of CATEGORIES) {
    const filter = sel && sel.cat === key ? ['==', ['get', 'gid'], sel.gid] : ['==', ['get', 'gid'], -1];
    for (const suffix of ['glow', 'sel-casing', 'sel-line', 'stop-sel']) map.setFilter(`${key}-${suffix}`, filter);
  }
  // 選択中は他の路線を薄くして、強調を目立たせる
  for (const id of lineLayerIds) map.setPaintProperty(id, 'line-opacity', sel ? 0.35 : 1);
  for (const { key } of CATEGORIES) {
    map.setPaintProperty(`${key}-stop`, 'circle-opacity', sel ? 0.4 : 1);
    map.setPaintProperty(`${key}-stop`, 'circle-stroke-opacity', sel ? 0.4 : 1);
  }
  syncLabels();
}

function chip(sel, onClick) {
  const f = lineOf(sel.cat, sel.gid);
  if (!f) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = f.properties.name;
  b.style.setProperty('--c', f.properties.colour);
  b.addEventListener('click', onClick);
  return b;
}

function fillChips(label, sels, onClick) {
  el.othersList.replaceChildren(...sels.map((s) => chip(s, () => onClick(s))).filter(Boolean));
  el.othersLabel.textContent = label;
  el.others.hidden = el.othersList.childElementCount === 0;
}

function showLinePanel(sel, others = []) {
  const f = lineOf(sel.cat, sel.gid);
  if (!f) return;
  const p = f.properties;
  panelState = { type: 'line', sel };
  el.panel.hidden = false;
  el.badge.textContent = LABELS[p.cat];
  el.badge.style.setProperty('--c', p.colour);
  el.title.textContent = p.name;
  el.sub.textContent = [p.operator, p.nameEn].filter(Boolean).join(' / ');
  el.detail.textContent = p.detail || '';
  el.detail.hidden = !p.detail;
  fillChips('この地点を通る他の路線', others, (o) => {
    select(o, [sel, ...others.filter((x) => !sameLine(x, o))]);
    fitTo(lineOf(o.cat, o.gid));
  });
  renderActions();
}

function showStationPanel(name, lines) {
  panelState = { type: 'station' };
  el.panel.hidden = false;
  el.badge.textContent = '駅・停留所';
  el.badge.style.setProperty('--c', '#555');
  el.title.textContent = name;
  el.sub.textContent = `${lines.length} 路線が接続`;
  el.detail.hidden = true;
  fillChips('路線を選ぶとその路線だけ表示します', lines, (o) => showOnly(o));
  renderActions();
}

function renderActions() {
  const lineSel = panelState?.type === 'line' ? panelState.sel : null;
  el.btnSolo.hidden = !lineSel || (view.mode === 'solo' && sameLine(view, lineSel));
}

function select(sel, others = []) {
  setSelection(sel);
  showLinePanel(sel, others);
}

function closePanel() {
  el.panel.hidden = true;
  panelState = null;
}

function clearSelection() {
  setSelection(null);
  closePanel();
}

function fitTo(line) {
  const [w, s, e, n] = line.bbox;
  map.fitBounds(
    [
      [w, s],
      [e, n],
    ],
    { padding: { top: 60, left: 60, right: 60, bottom: 220 }, maxZoom: 14, duration: 700 },
  );
}

// ---- 駅 ------------------------------------------------------------------

let popup = null;

// 「新宿駅西口」→「新宿」のように、駅名の部分だけで同じ駅かを判定する
const stationKey = (name) => name.replace(/\s/g, '').replace(/駅.*$/, '') || name;

// クリックした駅・停留所に接続している路線(同名で近くにある駅を持つ路線)
function connectedLines(name, [lon, lat], cat) {
  const key = stationKey(name);
  const r = cat === 'bus' ? 0.003 : 0.006; // 度。バス停同士は近いものだけ同一視する
  const found = new Map();
  for (const s of allStops) {
    if (s.key !== key || Math.abs(s.lon - lon) > r || Math.abs(s.lat - lat) > r) continue;
    found.set(`${s.cat}:${s.gid}`, { cat: s.cat, gid: s.gid });
  }
  return [...found.values()].sort(
    (a, b) =>
      CAT_ORDER[a.cat] - CAT_ORDER[b.cat] ||
      lineOf(a.cat, a.gid).properties.name.localeCompare(lineOf(b.cat, b.gid).properties.name, 'ja'),
  );
}

function showStopPopup(lngLat, name) {
  popup?.remove();
  popup = new maplibregl.Popup({ offset: 12, closeButton: false, maxWidth: '220px' })
    .setLngLat(lngLat)
    .setText(name)
    .addTo(map);
}

function visibleLayers(suffixes) {
  return CATEGORIES.flatMap(({ key }) => suffixes.map((s) => `${key}-${s}`)).filter(
    (id) => map.getLayoutProperty(id, 'visibility') !== 'none',
  );
}

function around(point, r) {
  return [
    [point.x - r, point.y - r],
    [point.x + r, point.y + r],
  ];
}

map.on('click', (e) => {
  popup?.remove();

  // 駅の丸印を優先して判定する
  const stopHits = map.queryRenderedFeatures(around(e.point, 10), { layers: visibleLayers(['stop-sel', 'stop']) });
  if (stopHits.length) {
    const stop = stopHits[0];
    const { name, cat } = stop.properties;
    const coords = stop.geometry.coordinates;
    const lines = connectedLines(name, coords, cat);
    showStopPopup(coords, name);
    if (lines.length >= 2) {
      // ターミナル駅: 接続している路線だけを表示する
      showStation(name, coords, lines);
    } else {
      select({ cat, gid: stop.properties.gid });
    }
    return;
  }

  const hits = map.queryRenderedFeatures(around(e.point, 8), { layers: visibleLayers(['hit']) });
  const uniq = [];
  for (const h of hits) {
    const s = { cat: h.properties.cat, gid: h.properties.gid };
    if (!uniq.some((u) => sameLine(u, s))) uniq.push(s);
  }
  if (uniq.length === 0) return clearSelection();
  // 現在選択中の路線が重なっていたら、次の候補へ切り替えて重なり路線も選べるようにする
  let idx = 0;
  if (selected && uniq.length > 1) {
    const cur = uniq.findIndex((u) => sameLine(u, selected));
    if (cur >= 0) idx = (cur + 1) % uniq.length;
  }
  const [first] = uniq.splice(idx, 1);
  select(first, uniq);
});

map.on('mousemove', (e) => {
  const over = map.queryRenderedFeatures(around(e.point, 4), { layers: visibleLayers(['hit', 'stop']) }).length > 0;
  map.getCanvas().style.cursor = over ? 'pointer' : '';
});

// ---- 路線の検索プルダウン ---------------------------------------------------

let searchItems = [];

function buildSearchItems() {
  searchItems = [...lineIndex.values()]
    .map(({ properties: p }) => ({
      cat: p.cat,
      gid: p.gid,
      name: p.name,
      colour: p.colour,
      text: `${p.name} ${p.operator} ${p.nameEn} ${LABELS[p.cat]}`.toLowerCase(),
    }))
    .sort((a, b) => CAT_ORDER[a.cat] - CAT_ORDER[b.cat] || a.name.localeCompare(b.name, 'ja'));
}

const MAX_ITEMS = 80;

// 検索欄は、絞り込み中はその内容(路線名・駅名)を表示するラベルを兼ねる
let searchLabel = '';
let searchOpen = false;

function setSearchLabel(text) {
  searchLabel = text;
  el.search.value = text;
}

// 検索欄は、検索アイコンで開いているか、絞り込み中のときだけ表示する
function updateFilterRow() {
  // ルート検索中は、ルート検索のパネルが絞り込み中の表示を兼ねる
  el.filterRow.hidden = !(searchOpen || (view.mode !== 'all' && view.mode !== 'route'));
  el.resetView.hidden = view.mode === 'all';
  el.btnSearch.setAttribute('aria-pressed', String(!el.filterRow.hidden));
}

function renderList() {
  const q = el.search.value.trim().toLowerCase();
  // ラベルのまま開いたときは全件を出す
  const filterText = searchLabel && el.search.value === searchLabel ? '' : q;
  const matches = searchItems.filter((it) => !filterText || it.text.includes(filterText));
  const nodes = matches.slice(0, MAX_ITEMS).map((it) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.dataset.cat = it.cat;
    li.dataset.gid = it.gid;
    li.style.setProperty('--c', it.colour);
    const name = document.createElement('span');
    name.textContent = it.name;
    const kind = document.createElement('small');
    kind.textContent = LABELS[it.cat];
    li.append(name, kind);
    return li;
  });
  if (matches.length > MAX_ITEMS) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = `他 ${matches.length - MAX_ITEMS} 件(文字を入力して絞り込み)`;
    nodes.push(more);
  } else if (matches.length === 0) {
    const none = document.createElement('li');
    none.className = 'more';
    none.textContent = '該当する路線がありません';
    nodes.push(none);
  }
  el.list.replaceChildren(...nodes);
}

function openList() {
  renderList();
  el.list.hidden = false;
  el.search.setAttribute('aria-expanded', 'true');
}

function closeList() {
  el.list.hidden = true;
  el.search.setAttribute('aria-expanded', 'false');
}

function chooseItem(li) {
  if (!li?.dataset.gid) return;
  closeList();
  el.search.blur();
  searchOpen = false;
  showOnly({ cat: li.dataset.cat, gid: Number(li.dataset.gid) });
}

el.search.addEventListener('focus', () => {
  el.search.select();
  openList();
});
el.btnSearch.addEventListener('click', () => {
  if (view.mode !== 'all') {
    // 絞り込み中は検索欄を開いて別の路線を選べるようにする
    el.search.focus();
    return;
  }
  searchOpen = !searchOpen;
  updateFilterRow();
  if (searchOpen) el.search.focus();
  else closeList();
});
el.search.addEventListener('input', openList);
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') chooseItem(el.list.querySelector('li[data-gid]'));
  if (e.key === 'Escape') {
    closeList();
    el.search.blur();
    e.stopPropagation();
  }
});
el.list.addEventListener('click', (e) => chooseItem(e.target.closest('li')));
document.addEventListener('click', (e) => {
  if (!e.target.closest('.search') && !e.target.closest('#btn-search')) closeList();
});

// ---- ルート検索(出発駅 → 到着駅) ------------------------------------------------
// 路線の駅データから、乗り換えの少ない経路を探す(src/route.js)。経路を選ぶと、使う路線だけを表示し、
// 出発・到着・乗り換えの駅に名前を出す。

const route = { graph: null, graphStops: -1, results: [], from: '', to: '' };
const routeFields = {
  from: { input: el.routeFrom, list: el.routeFromList },
  to: { input: el.routeTo, list: el.routeToList },
};
let routeMarkers = [];
const EMPTY_FC = { type: 'FeatureCollection', features: [] };

// 歩く区間(駅の外の乗り換え)を破線で描く
function addRouteLayers() {
  map.addSource('route-walk', { type: 'geojson', data: EMPTY_FC });
  map.addLayer({
    id: 'route-walk',
    type: 'line',
    source: 'route-walk',
    layout: { 'line-cap': 'butt' },
    paint: { 'line-color': '#222', 'line-width': 3, 'line-dasharray': [1.5, 1.5] },
  });
}

function clearRouteMarks() {
  for (const m of routeMarkers) m.remove();
  routeMarkers = [];
  map.getSource('route-walk')?.setData(EMPTY_FC);
  for (const li of el.routeResults.children) li.removeAttribute('aria-current');
}

const routeCats = () => new Set(['train', 'subway', ...(el.routeBus.checked ? ['bus'] : [])]);

// 経路探索には全エリアの駅が要るので、開いたときにまとめて読み込む
async function ensureRouteGraph() {
  try {
    await Promise.all(areas.map((a) => loadArea(a.id)));
  } catch (err) {
    showLoadError(err);
    return null;
  }
  if (route.graphStops !== allStops.length) {
    route.graph = buildGraph(allStops);
    route.graphStops = allStops.length;
  }
  return route.graph;
}

async function openRoutePanel() {
  el.routePanel.hidden = false;
  el.btnRoute.setAttribute('aria-pressed', 'true');
  searchOpen = false;
  closeList();
  updateFilterRow();
  el.routeMsg.textContent = '路線データを読み込み中…';
  const graph = await ensureRouteGraph();
  if (el.routePanel.hidden) return;
  if (!graph) {
    el.routeMsg.textContent = '路線データを読み込めませんでした';
    return;
  }
  el.routeMsg.textContent = '';
  el.routeFrom.disabled = false;
  el.routeTo.disabled = false;
  (el.routeFrom.value ? el.routeTo : el.routeFrom).focus();
  runRouteSearch();
}

function closeRoutePanel() {
  el.routePanel.hidden = true;
  el.btnRoute.setAttribute('aria-pressed', 'false');
  hideSuggest();
  if (view.mode === 'route') resetView();
}

function hideSuggest() {
  for (const { list } of Object.values(routeFields)) list.hidden = true;
}

// 入力途中の文字列から駅名の候補を出す
function showSuggest(which) {
  if (!route.graph) return;
  const { input, list } = routeFields[which];
  const { names, total } = suggestStations(route.graph, input.value, routeCats());
  const nodes = names.map((name) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.dataset.name = name;
    li.textContent = name;
    return li;
  });
  if (total > names.length || !names.length) {
    const note = document.createElement('li');
    note.className = 'more';
    note.textContent = names.length ? `他 ${total - names.length} 件(文字を入力して絞り込み)` : '該当する駅がありません';
    nodes.push(note);
  }
  list.replaceChildren(...nodes);
  list.hidden = false;
}

function chooseStation(which, name) {
  if (!name) return;
  const { input, list } = routeFields[which];
  input.value = name;
  list.hidden = true;
  if (which === 'from' && !el.routeTo.value) el.routeTo.focus();
  else input.blur();
  runRouteSearch();
}

// 入力欄の文字(「新宿駅」など)を、駅データにある駅名に直す。なければ空
function resolveStation(value) {
  const key = stationKey(value.trim());
  return key && route.graph && stationIds(route.graph, key).length ? key : '';
}

function runRouteSearch() {
  route.results = [];
  el.routeResults.replaceChildren();
  if (view.mode === 'route') resetView();
  if (!route.graph) return;
  if (!el.routeFrom.value.trim() || !el.routeTo.value.trim()) {
    el.routeMsg.textContent = '';
    return;
  }
  const from = resolveStation(el.routeFrom.value);
  const to = resolveStation(el.routeTo.value);
  if (!from || !to) {
    el.routeMsg.textContent = '候補から駅を選んでください';
    return;
  }
  if (from === to) {
    el.routeMsg.textContent = '出発駅と到着駅が同じです';
    return;
  }
  Object.assign(route, { from, to });
  route.results = findRoutes(route.graph, { from, to, cats: routeCats(), walk: el.routeWalk.checked });
  if (!route.results.length) {
    el.routeMsg.textContent = `${from} から ${to} へ行ける経路が見つかりませんでした`;
    return;
  }
  el.routeMsg.textContent = `${route.results.length} 件の経路(乗り換えの少ない順)`;
  renderRouteResults();
  showRoute(0);
}

function renderRouteResults() {
  const g = route.graph;
  el.routeResults.replaceChildren(
    ...route.results.map((r, i) => {
      const steps = routeSteps(g, r, route.from, route.to);
      const rides = steps.filter((s) => s.type === 'ride').length;
      const walked = steps.some((s) => s.type === 'walk');
      const li = document.createElement('li');
      li.dataset.idx = i;

      const head = document.createElement('div');
      head.className = 'r-head';
      const title = document.createElement('span');
      title.textContent = !rides ? '徒歩のみ' : rides === 1 ? '乗り換えなし' : `乗り換え ${rides - 1} 回`;
      head.append(title);
      if (walked && rides) {
        const note = document.createElement('small');
        note.textContent = '徒歩あり';
        head.append(note);
      }
      li.append(head);

      for (const step of steps) {
        const row = document.createElement('div');
        row.className = `r-step ${step.type}`;
        const name = document.createElement('span');
        name.className = 'r-line';
        if (step.type === 'ride') {
          const sel = lineSel(step.line);
          name.textContent = lineOf(sel.cat, sel.gid)?.properties.name ?? '';
          row.style.setProperty('--c', lineOf(sel.cat, sel.gid)?.properties.colour);
        } else {
          name.textContent = '徒歩';
        }
        const span = document.createElement('span');
        span.textContent = `${g.clusters[step.from].key} → ${g.clusters[step.to].key}`;
        row.append(name, span);
        li.append(row);
      }
      return li;
    }),
  );
}

const lineSel = (lineKey) => {
  const [cat, gid] = lineKey.split(':');
  return { cat, gid: Number(gid) };
};

// 選んだ経路の路線だけを表示し、出発・到着・乗り換えの駅に名前を出す
function showRoute(i) {
  const r = route.results[i];
  if (!r) return;
  const g = route.graph;
  const steps = routeSteps(g, r, route.from, route.to);
  const lines = [];
  for (const s of steps) {
    if (s.type !== 'ride') continue;
    const sel = lineSel(s.line);
    if (!lines.some((l) => sameLine(l, sel))) lines.push(sel);
  }
  ensureVisible(lines.map((l) => l.cat));
  popup?.remove();
  setSelection(null);
  closePanel();
  view = { mode: 'route', lines };
  applyView();
  [...el.routeResults.children].forEach((li, j) => li.setAttribute('aria-current', String(j === i)));

  const roles = new Map(); // 駅 → start / end / via
  const put = (id, role) => {
    if (!roles.has(id) || role !== 'via') roles.set(id, role);
  };
  steps.forEach((s, j) => {
    put(s.from, j === 0 ? 'start' : 'via');
    put(s.to, j === steps.length - 1 ? 'end' : 'via');
  });
  const prefix = { start: '出発 ', end: '到着 ', via: '' };
  const bounds = new maplibregl.LngLatBounds();
  // 出発・到着の吹き出しが、近くの乗り換え駅の吹き出しに隠れないよう、後から重ねる
  const ordered = [...roles].sort(([, a], [, b]) => Number(a !== 'via') - Number(b !== 'via'));
  for (const [id, role] of ordered) {
    const c = g.clusters[id];
    const div = document.createElement('div');
    div.className = `route-pin ${role}`;
    div.textContent = prefix[role] + c.key;
    routeMarkers.push(new maplibregl.Marker({ element: div, anchor: 'bottom', offset: [0, -6] }).setLngLat([c.lon, c.lat]).addTo(map));
    bounds.extend([c.lon, c.lat]);
  }
  map.getSource('route-walk').setData({
    type: 'FeatureCollection',
    features: steps
      .filter((s) => s.type === 'walk')
      .map((s) => ({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [g.clusters[s.from].lon, g.clusters[s.from].lat],
            [g.clusters[s.to].lon, g.clusters[s.to].lat],
          ],
        },
      })),
  });
  // 駅名の吹き出しが画面の端で切れないよう、左右に余白を取る
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const side = Math.min(90, w * 0.2);
  const bottom = Math.min($('bottom').offsetHeight + 30, h * 0.6);
  map.fitBounds(bounds, { padding: { top: 70, left: side, right: side, bottom }, maxZoom: 15, duration: 700 });
}

el.btnRoute.addEventListener('click', () => (el.routePanel.hidden ? openRoutePanel() : closeRoutePanel()));
$('route-close').addEventListener('click', closeRoutePanel);
$('route-swap').addEventListener('click', () => {
  [el.routeFrom.value, el.routeTo.value] = [el.routeTo.value, el.routeFrom.value];
  runRouteSearch();
});
el.routeBus.addEventListener('change', runRouteSearch);
el.routeWalk.addEventListener('change', runRouteSearch);
el.routeResults.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (li) showRoute(Number(li.dataset.idx));
});
for (const [which, { input, list }] of Object.entries(routeFields)) {
  input.addEventListener('focus', () => {
    input.select();
    showSuggest(which);
  });
  input.addEventListener('input', () => showSuggest(which));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') chooseStation(which, list.querySelector('li[data-name]')?.dataset.name);
    if (e.key === 'Escape') {
      list.hidden = true;
      input.blur();
      e.stopPropagation();
    }
  });
  // 候補をタップしても入力欄のフォーカスが外れないようにする
  list.addEventListener('pointerdown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => chooseStation(which, e.target.closest('li')?.dataset.name));
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('.route-field')) hideSuggest();
});

// ---- その他の UI ------------------------------------------------------------

// マウスホイールの縦回転で、他の路線の一覧(横スクロール)を動かせるようにする
el.othersList.addEventListener(
  'wheel',
  (e) => {
    const list = el.othersList;
    if (list.scrollWidth <= list.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    list.scrollLeft += e.deltaY;
    e.preventDefault();
  },
  { passive: false },
);

$('panel-close').addEventListener('click', clearSelection);
el.btnSolo.addEventListener('click', () => panelState?.sel && showOnly(panelState.sel, { fit: false }));
el.resetView.addEventListener('click', resetView);
window.addEventListener('keydown', (e) => e.key === 'Escape' && clearSelection());

document.querySelectorAll('#controls input[data-cat]').forEach((input) => {
  input.addEventListener('change', () => {
    const key = input.dataset.cat;
    catVisible[key] = input.checked;
    saveCatVisible();
    if (!input.checked && selected?.cat === key) clearSelection();
    // 絞り込み中にカテゴリを切り替えたら、絞り込みを解除して通常表示に戻す
    view = { mode: 'all' };
    setSearchLabel('');
    if (panelState?.type === 'station') closePanel();
    applyView();
  });
});

// ---- データ読み込み ---------------------------------------------------------

const BASE = import.meta.env.BASE_URL;
const MIN_LOAD_ZOOM = 8; // これより引いているときは路線を読み込まない
const LOAD_MARGIN = 0.02; // 度。エリアの端に近づいたら先読みする(エリアの範囲は路線の全頂点を含む)

async function getJSON(path) {
  const res = await fetch(`${BASE}data/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// 画面中央上部のステータス表示。読み込み中の件数が 0 になったら消す。
let pendingLoads = 0;
let hint = '';
let statusTimer = 0;

function setStatus(text, autoHideMs = 0) {
  clearTimeout(statusTimer);
  el.status.textContent = text;
  el.status.hidden = false;
  if (autoHideMs) statusTimer = setTimeout(() => (el.status.hidden = true), autoHideMs);
}

function setHint(text) {
  if (text === hint) return;
  hint = text;
  if (pendingLoads > 0) return;
  if (text) setStatus(text);
  else el.status.hidden = true;
}

function showLoadError(err) {
  console.error(err);
  setStatus(`路線データの読み込みに失敗しました (${err.message})`, 6000);
}

// エリア内の路線・駅を読み込み、地図のソースに追加する(読み込み済みなら何もしない)
function loadArea(id) {
  let p = loadedAreas.get(id);
  if (!p) {
    p = fetchArea(id).catch((err) => {
      loadedAreas.delete(id); // 次の移動で再試行できるようにする
      throw err;
    });
    loadedAreas.set(id, p);
  }
  return p;
}

async function fetchArea(id) {
  const name = areas.find((a) => a.id === id)?.name ?? id;
  pendingLoads++;
  setStatus(`${name}エリアの路線を読み込み中…`);
  try {
    const results = await Promise.all(
      CATEGORIES.map(async ({ key }) => {
        const [lines, stops] = await Promise.all([getJSON(`${id}/${key}.geojson`), getJSON(`${id}/${key}-stops.geojson`)]);
        return [key, lines, stops];
      }),
    );
    for (const [key, lines, stops] of results) {
      dataByCat[key].lines.features.push(...lines.features);
      dataByCat[key].stops.features.push(...stops.features);
      allStops.push(
        ...stops.features.map((f) => ({
          cat: key,
          gid: f.properties.gid,
          name: f.properties.name,
          key: stationKey(f.properties.name),
          lon: f.geometry.coordinates[0],
          lat: f.geometry.coordinates[1],
        })),
      );
      map.getSource(key).setData(dataByCat[key].lines);
      map.getSource(`${key}-stops`).setData(dataByCat[key].stops);
    }
    // 路線の選択中・1路線だけ表示中なら、増えた駅の吹き出しを作り直す
    labelKey = '';
    syncLabels();
  } finally {
    pendingLoads--;
    if (pendingLoads === 0) {
      if (hint) setStatus(hint);
      else setStatus(`${name}エリアを読み込みました`, 1200);
    }
  }
}

// 表示範囲に入った(または近い)エリアを読み込む
function updateAreas() {
  if (!areas.length) return;
  if (map.getZoom() < MIN_LOAD_ZOOM) {
    setHint(loadedAreas.size ? '' : '拡大すると路線が表示されます');
    return;
  }
  const b = map.getBounds();
  const near = areas.filter(({ bbox: [w, s, e, n] }) => {
    const m = LOAD_MARGIN;
    return !(b.getEast() < w - m || b.getWest() > e + m || b.getNorth() < s - m || b.getSouth() > n + m);
  });
  for (const a of near) loadArea(a.id).catch(showLoadError);
  const names = areas.map((a) => a.name).join('・');
  setHint(near.length ? '' : `この付近の路線データはありません(対応エリア: ${names})`);
}

map.on('moveend', updateAreas);

map.on('load', async () => {
  let data;
  try {
    data = await getJSON('index.json');
  } catch (err) {
    showLoadError(err);
    return;
  }
  areas = data.areas;
  for (const l of data.lines) {
    const { bbox, areas: lineAreas, ...properties } = l;
    lineIndex.set(`${l.cat}:${l.gid}`, { properties, bbox, areas: lineAreas });
  }

  // ソースとレイヤーは空のまま先に作り、エリアを読み込むたびにデータを足す
  for (const { key } of CATEGORIES) {
    map.addSource(key, { type: 'geojson', data: dataByCat[key].lines });
    map.addSource(`${key}-stops`, { type: 'geojson', data: dataByCat[key].stops });
  }
  for (const cat of CATEGORIES) addCategoryLayers(cat);
  addHighlightLayers();
  addStopLayers();
  addRouteLayers();
  applyView(); // 前回非表示にしたカテゴリを反映する
  buildSearchItems();
  el.search.disabled = false;
  el.btnRoute.disabled = false;

  // 日本全体 → 東京近郊へズームイン。東京は先に読み込んでおく
  loadArea(areas[0].id).catch(showLoadError);
  map.flyTo({ ...TOKYO, duration: 2500 });
  autoLocate();
});

// ---- 現在地の自動表示 --------------------------------------------------------

const inCoverage = (lon, lat) =>
  areas.some(({ bbox: [w, s, e, n] }) => lon >= w - 0.05 && lon <= e + 0.05 && lat >= s - 0.05 && lat <= n + 0.05);

// 起動時に現在地を表示する。
// - 拒否済みの端末では何もしない(許可ダイアログを繰り返し出さない)
// - 対応エリアの外にいるときは地図を動かさない(現在地ボタンでいつでも出せる)
async function autoLocate() {
  if (!('geolocation' in navigator)) return;
  try {
    const perm = await navigator.permissions?.query({ name: 'geolocation' });
    if (perm?.state === 'denied') return;
  } catch {
    // Permissions API に対応していないブラウザは、そのままブラウザ側の確認に任せる
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      if (inCoverage(coords.longitude, coords.latitude)) geolocate.trigger();
    },
    () => {}, // 拒否・取得失敗は黙って無視する
    { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
  );
}

// 動作確認・デバッグ用
window.__map = map;
window.__autoLocate = autoLocate;
