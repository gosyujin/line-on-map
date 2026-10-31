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

const TOKYO = { center: [139.76, 35.68], zoom: 10.6 };
const JAPAN = { center: [137.5, 37.5], zoom: 4.6 };
const HIGHLIGHT = '#ff8a00';

const map = new maplibregl.Map({
  container: 'map',
  center: JAPAN.center,
  zoom: JAPAN.zoom,
  minZoom: 3,
  maxZoom: 18,
  attributionControl: { compact: true },
  style: {
    version: 8,
    sources: {
      gsi: {
        type: 'raster',
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 18,
        attribution:
          '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル</a> | 路線データ © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      },
    },
    layers: [{ id: 'gsi', type: 'raster', source: 'gsi' }],
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

const el = {
  status: document.getElementById('status'),
  panel: document.getElementById('panel'),
  badge: document.getElementById('panel-badge'),
  title: document.getElementById('panel-title'),
  sub: document.getElementById('panel-sub'),
  detail: document.getElementById('panel-detail'),
  others: document.getElementById('panel-others'),
  othersList: document.getElementById('panel-others-list'),
};

// カテゴリごとの路線データ(検索・fitBounds 用に保持)
const featuresByCat = {};
let selected = null; // { cat, gid }

const baseLayerIds = CATEGORIES.map((c) => `${c.key}-line`);
const hitLayerIds = CATEGORIES.map((c) => `${c.key}-hit`);

function addCategoryLayers({ key, width }) {
  const src = key;
  map.addLayer({
    id: `${key}-casing`,
    type: 'line',
    source: src,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#fff',
      'line-width': ['interpolate', ['linear'], ['zoom'], ...width.map((v, i) => (i % 2 ? v + 1.5 : v))],
      'line-opacity': 0.85,
    },
  });
  map.addLayer({
    id: `${key}-line`,
    type: 'line',
    source: src,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'colour'],
      'line-width': ['interpolate', ['linear'], ['zoom'], ...width],
      'line-opacity': 1,
    },
  });
  // タップしやすいように、見た目より太い透明レイヤーでヒット判定する
  map.addLayer({
    id: `${key}-hit`,
    type: 'line',
    source: src,
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 14 },
  });
}

function addHighlightLayers() {
  const none = ['==', ['get', 'gid'], -1];
  for (const { key, width } of CATEGORIES) {
    const common = { type: 'line', source: key, filter: none, layout: { 'line-cap': 'round', 'line-join': 'round' } };
    // 添付画像のようなオレンジのグロー
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
      paint: { 'line-color': ['get', 'colour'], 'line-width': ['interpolate', ['linear'], ['zoom'], ...width.map((v, i) => (i % 2 ? v + 1 : v))] },
    });
  }
}

function setSelection(sel) {
  selected = sel;
  for (const { key } of CATEGORIES) {
    const filter = sel && sel.cat === key ? ['==', ['get', 'gid'], sel.gid] : ['==', ['get', 'gid'], -1];
    for (const suffix of ['glow', 'sel-casing', 'sel-line']) map.setFilter(`${key}-${suffix}`, filter);
  }
  // 選択中は他の路線を薄くして、強調を目立たせる
  for (const id of baseLayerIds) map.setPaintProperty(id, 'line-opacity', sel ? 0.35 : 1);
}

function findFeature(cat, gid) {
  return featuresByCat[cat]?.find((f) => f.properties.gid === gid);
}

function showPanel(sel, others = []) {
  const f = findFeature(sel.cat, sel.gid);
  if (!f) return;
  const p = f.properties;
  el.panel.hidden = false;
  el.panel.style.borderLeftColor = HIGHLIGHT;
  el.badge.textContent = LABELS[p.cat];
  el.badge.style.setProperty('--c', p.colour);
  el.title.textContent = p.cat === 'bus' && p.ref ? `${p.ref}` : p.name;
  el.sub.textContent = [p.operator, p.nameEn].filter(Boolean).join(' / ');
  el.detail.textContent = p.detail || '';
  el.detail.hidden = !p.detail;

  el.othersList.replaceChildren();
  for (const o of others) {
    const of = findFeature(o.cat, o.gid);
    if (!of) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = of.properties.cat === 'bus' ? `${of.properties.ref} (バス)` : of.properties.name;
    b.style.setProperty('--c', of.properties.colour);
    b.addEventListener('click', () => {
      select(o, [sel, ...others.filter((x) => x !== o)]);
      fitTo(of);
    });
    el.othersList.append(b);
  }
  el.others.hidden = el.othersList.childElementCount === 0;
}

function select(sel, others = []) {
  setSelection(sel);
  showPanel(sel, others);
}

function clearSelection() {
  setSelection(null);
  el.panel.hidden = true;
}

function fitTo(feature) {
  const b = new maplibregl.LngLatBounds();
  for (const line of feature.geometry.coordinates) for (const c of line) b.extend(c);
  map.fitBounds(b, { padding: { top: 60, left: 60, right: 60, bottom: 200 }, maxZoom: 14, duration: 700 });
}

function visibleHitLayers() {
  return hitLayerIds.filter((id) => map.getLayoutProperty(id, 'visibility') !== 'none');
}

map.on('click', (e) => {
  const r = 8; // タッチでも当てやすいように余裕を持たせる
  const box = [
    [e.point.x - r, e.point.y - r],
    [e.point.x + r, e.point.y + r],
  ];
  const hits = map.queryRenderedFeatures(box, { layers: visibleHitLayers() });
  const uniq = [];
  const seen = new Set();
  for (const h of hits) {
    const id = `${h.properties.cat}:${h.properties.gid}`;
    if (seen.has(id)) continue;
    seen.add(id);
    uniq.push({ cat: h.properties.cat, gid: h.properties.gid });
  }
  if (uniq.length === 0) return clearSelection();
  // 現在選択中の路線が重なっていたら、次の候補へ切り替えて重なり路線も選べるようにする
  let idx = 0;
  if (selected && uniq.length > 1) {
    const cur = uniq.findIndex((u) => u.cat === selected.cat && u.gid === selected.gid);
    if (cur >= 0) idx = (cur + 1) % uniq.length;
  }
  const [first] = uniq.splice(idx, 1);
  select(first, uniq);
});

map.on('mousemove', (e) => {
  const box = [
    [e.point.x - 4, e.point.y - 4],
    [e.point.x + 4, e.point.y + 4],
  ];
  const over = map.queryRenderedFeatures(box, { layers: visibleHitLayers() }).length > 0;
  map.getCanvas().style.cursor = over ? 'pointer' : '';
});

document.getElementById('panel-close').addEventListener('click', clearSelection);
window.addEventListener('keydown', (e) => e.key === 'Escape' && clearSelection());

document.getElementById('btn-tokyo').addEventListener('click', () => map.flyTo({ ...TOKYO, duration: 1500 }));
document.getElementById('btn-japan').addEventListener('click', () => map.flyTo({ ...JAPAN, duration: 1500 }));

document.querySelectorAll('#controls input[data-cat]').forEach((input) => {
  input.addEventListener('change', () => {
    const key = input.dataset.cat;
    const vis = input.checked ? 'visible' : 'none';
    for (const suffix of ['casing', 'line', 'hit', 'glow', 'sel-casing', 'sel-line']) {
      map.setLayoutProperty(`${key}-${suffix}`, 'visibility', vis);
    }
    if (!input.checked && selected?.cat === key) clearSelection();
  });
});

map.on('load', async () => {
  const base = import.meta.env.BASE_URL;
  const results = await Promise.all(
    CATEGORIES.map(async ({ key }) => {
      const res = await fetch(`${base}data/${key}.geojson`);
      if (!res.ok) throw new Error(`${key}: HTTP ${res.status}`);
      return [key, await res.json()];
    }),
  ).catch((err) => {
    el.status.textContent = `路線データの読み込みに失敗しました (${err.message})`;
    throw err;
  });

  for (const [key, data] of results) {
    featuresByCat[key] = data.features;
    map.addSource(key, { type: 'geojson', data });
  }
  for (const cat of CATEGORIES) addCategoryLayers(cat);
  addHighlightLayers();

  const total = Object.values(featuresByCat).reduce((n, fs) => n + fs.length, 0);
  el.status.textContent = `${total} 路線を表示中`;
  setTimeout(() => (el.status.hidden = true), 2500);

  // 日本全体 → 東京近郊へズームイン
  map.flyTo({ ...TOKYO, duration: 2500 });
});

// 動作確認・デバッグ用
window.__map = map;
