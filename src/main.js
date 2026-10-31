import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';

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
map.addControl(
  new maplibregl.GeolocateControl({
    positionOptions: { enableHighAccuracy: true },
    trackUserLocation: true,
    showUserLocation: true,
    showAccuracyCircle: true,
    fitBoundsOptions: { maxZoom: 15 },
  }),
  'top-right',
);
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
};

// ---- 状態 ------------------------------------------------------------------

const featuresByCat = {}; // 路線データ
let allStops = []; // 全カテゴリの駅・停留所(接続路線の検索用)
let selected = null; // 強調表示中の路線 { cat, gid }
// 表示モード: 全路線 / 1路線だけ / 駅に接続する路線だけ
let view = { mode: 'all' };
const catVisible = Object.fromEntries(CATEGORIES.map((c) => [c.key, true]));
let panelState = null; // { type: 'line', sel } | { type: 'station' }

const lineLayerIds = CATEGORIES.map((c) => `${c.key}-line`);
const hitLayerIds = CATEGORIES.map((c) => `${c.key}-hit`);
const FILTERED = ['casing', 'line', 'hit', 'stop'];
const ALL_SUFFIXES = [...FILTERED, 'glow', 'sel-casing', 'sel-line', 'stop-sel'];

const lineOf = (cat, gid) => featuresByCat[cat]?.find((f) => f.properties.gid === gid);
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
  if (view.mode === 'station') return view.lines.filter((l) => l.cat === cat).map((l) => l.gid);
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
}

function showOnly(sel, { fit = true } = {}) {
  ensureVisible([sel.cat]);
  view = { mode: 'solo', ...sel };
  popup?.remove();
  applyView();
  select(sel);
  const f = lineOf(sel.cat, sel.gid);
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

// ---- 駅名の吹き出し(1路線だけ表示中) ------------------------------------------
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
  const key = view.mode === 'solo' ? `${view.cat}:${view.gid}` : '';
  if (key === labelKey) return;
  labelKey = key;
  labelLayer.replaceChildren();
  labels = [];
  if (!key) return;
  const colour = lineOf(view.cat, view.gid)?.properties.colour;
  const stops = allStops.filter((s) => s.cat === view.cat && s.gid === view.gid);
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

function fitTo(feature) {
  const b = new maplibregl.LngLatBounds();
  for (const line of feature.geometry.coordinates) for (const c of line) b.extend(c);
  map.fitBounds(b, { padding: { top: 60, left: 60, right: 60, bottom: 220 }, maxZoom: 14, duration: 700 });
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
  searchItems = CATEGORIES.flatMap(({ key }) => featuresByCat[key].map((f) => ({ cat: key, ...f.properties })))
    .map((p) => ({
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
  el.filterRow.hidden = !(searchOpen || view.mode !== 'all');
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

// ---- その他の UI ------------------------------------------------------------

$('panel-close').addEventListener('click', clearSelection);
el.btnSolo.addEventListener('click', () => panelState?.sel && showOnly(panelState.sel, { fit: false }));
el.resetView.addEventListener('click', resetView);
window.addEventListener('keydown', (e) => e.key === 'Escape' && clearSelection());

document.querySelectorAll('#controls input[data-cat]').forEach((input) => {
  input.addEventListener('change', () => {
    const key = input.dataset.cat;
    catVisible[key] = input.checked;
    if (!input.checked && selected?.cat === key) clearSelection();
    // 絞り込み中にカテゴリを切り替えたら、絞り込みを解除して通常表示に戻す
    view = { mode: 'all' };
    setSearchLabel('');
    if (panelState?.type === 'station') closePanel();
    applyView();
  });
});

// ---- データ読み込み ---------------------------------------------------------

map.on('load', async () => {
  const base = import.meta.env.BASE_URL;
  const results = await Promise.all(
    CATEGORIES.map(async ({ key }) => {
      const [lines, stops] = await Promise.all(
        [key, `${key}-stops`].map(async (name) => {
          const res = await fetch(`${base}data/${name}.geojson`);
          if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
          return res.json();
        }),
      );
      return [key, lines, stops];
    }),
  ).catch((err) => {
    el.status.textContent = `路線データの読み込みに失敗しました (${err.message})`;
    throw err;
  });

  for (const [key, data, stops] of results) {
    featuresByCat[key] = data.features;
    // 駅の丸印は路線の色で縁取る
    const colours = new Map(data.features.map((f) => [f.properties.gid, f.properties.colour]));
    for (const f of stops.features) f.properties.colour = colours.get(f.properties.gid) ?? '#666';
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
    map.addSource(key, { type: 'geojson', data });
    map.addSource(`${key}-stops`, { type: 'geojson', data: stops });
  }
  for (const cat of CATEGORIES) addCategoryLayers(cat);
  addHighlightLayers();
  addStopLayers();
  buildSearchItems();
  el.search.disabled = false;

  const total = Object.values(featuresByCat).reduce((n, fs) => n + fs.length, 0);
  el.status.textContent = `${total} 路線を表示中`;
  setTimeout(() => (el.status.hidden = true), 2500);

  // 日本全体 → 東京近郊へズームイン
  map.flyTo({ ...TOKYO, duration: 2500 });
});

// 動作確認・デバッグ用
window.__map = map;
