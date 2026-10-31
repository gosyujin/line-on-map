// OpenStreetMap (Overpass API) から東京近郊の路線データを取得し、
// 路線単位にまとめた GeoJSON を public/data/ に出力する。
//
//   npm run fetch-data            # キャッシュがあれば再利用
//   npm run fetch-data -- --force # 再取得
//
// データ © OpenStreetMap contributors (ODbL)

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'public', 'data');
const FORCE = process.argv.includes('--force');

const UA = 'line-on-map/0.1 (https://github.com/gosyujin/line-on-map)';
const ENDPOINTS = (process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []).concat([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
]);

// 取得対象エリア。bbox は (south, west, north, east)。
// データはエリアごとのファイルに分けて出力し、画面では表示範囲に入ったエリアだけを読み込む。
// 路線・駅は、先に並んだ(bbox に含まれる)エリアへ割り当てる。どれにも含まれなければ中心が最も近いエリア。
// filter は種別ごとの追加条件。バスは数が多いので東京は都営バスのみに絞る。
const AREAS = [
  { id: 'tokyo', name: '東京', bbox: [35.45, 139.35, 35.85, 139.95], filter: { bus: '["operator"~"東京都交通局|都営|Toei"]' } },
  { id: 'chiba', name: '千葉', bbox: [35.5, 139.9, 35.95, 140.3], filter: {} },
];
// 範囲外へ長く伸びる路線(東海道線など)を切り落とすための余白付きクリップ範囲
const CLIP_MARGIN = 0.05;

const CATEGORIES = {
  subway: {
    label: '地下鉄',
    query: `relation["route"="subway"]`,
    defaultColour: '#0072bc',
    groupBy: 'line',
  },
  train: {
    label: '電車',
    query: `relation["route"~"^(train|light_rail|monorail|tram)$"]`,
    defaultColour: '#00a040',
    groupBy: 'line',
  },
  bus: {
    label: 'バス',
    query: `relation["route"="bus"]`,
    defaultColour: '#d9531e',
    groupBy: 'ref',
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  const body = new URLSearchParams({ data: `[out:json][timeout:240];${query}` });
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(150_000),
      });
      if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
      const text = await res.text();
      if (!text.startsWith('{')) throw new Error(`${url} -> non-JSON response: ${text.slice(0, 80)}`);
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      const wait = 10_000 * (attempt + 1);
      console.warn(`  retry ${attempt + 1}: ${e.message} (wait ${wait / 1000}s)`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const areaQuery = (key, cat, area) => `${cat.query}${area.filter[key] ?? ''}(${area.bbox.join(',')})`;

// エリアごとに取得してキャッシュし、重複する範囲のリレーションは id でまとめる
async function loadCategory(key, cat) {
  const elements = new Map();
  for (const area of AREAS) {
    const cacheFile = join(CACHE_DIR, `${key}-${area.id}.json`);
    let data;
    if (!FORCE && existsSync(cacheFile)) {
      console.log(`[${key}/${area.id}] using cache`);
      data = JSON.parse(await readFile(cacheFile, 'utf8'));
    } else {
      console.log(`[${key}/${area.id}] fetching from Overpass...`);
      data = await overpass(`${areaQuery(key, cat, area)};out geom;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(data));
    }
    for (const e of data.elements) elements.set(e.id, e);
  }
  return { elements: [...elements.values()] };
}

// 路線リレーションのメンバーノード(駅・停留所)の名前と座標を取得する
async function loadNodes(key, cat) {
  const nodes = {};
  for (const area of AREAS) {
    const cacheFile = join(CACHE_DIR, `${key}-nodes-${area.id}.json`);
    if (!FORCE && existsSync(cacheFile)) {
      console.log(`[${key}/${area.id}] using nodes cache`);
      Object.assign(nodes, JSON.parse(await readFile(cacheFile, 'utf8')));
      continue;
    }
    console.log(`[${key}/${area.id}] fetching stops from Overpass...`);
    const data = await overpass(`${areaQuery(key, cat, area)}->.r;node(r.r);out;`);
    const found = {};
    for (const e of data.elements) {
      const name = e.tags?.['name:ja'] || e.tags?.name;
      if (e.type === 'node' && name) found[e.id] = { name, lat: e.lat, lon: e.lon };
    }
    await writeFile(cacheFile, JSON.stringify(found));
    Object.assign(nodes, found);
  }
  return nodes;
}

// ---- 路線名の正規化 -------------------------------------------------------
// OSM の路線リレーションは「各駅停車/快速/特急/直通運転」など列車種別・方向ごとに
// 作られているため、名前から種別・方向を取り除いて路線単位にまとめる。

const SERVICE_WORDS = /^(各駅停車|各停|普通|快速|急行|準急|特急|快特|通勤快速|通勤急行|通勤特急|区間快速|空港快速|快速急行|快速特急)$/;
// 路線ではない(列車愛称・直通運転・テーマパーク等)ものは除外
const EXCLUDE =
  /直通|運転|地下鉄-|\s-\s|成田エクスプレス|スカイライナー|シテイライナー|TJライナー|拝島ライナー|アクセス|列車|S-Train|ウエスタンリバー|^(あさま|あずさ|かがやき|こだま|のぞみ|たにがわ|とき|ひたち|ちちぶ|小江戸|踊り子|はこね|スーパーはこね|さがみ|えのしま|ふじさん|しおさい|さざなみ|多摩快速急行|各駅停車|小田急通勤急行)/;
const LINE_SUFFIX = /(線|ライン|ゆりかもめ|モノレール|ライナー|電鉄|鉄道)$/;
// 事業者名の正式名 → 短縮形。「本線」のように事業者名を外すと衝突する名前があるため、
// 事業者名は外さず短縮形に揃えて同一路線をまとめる(例: 京王電鉄京王線 → 京王線)。
const COMPANY_SHORT = {
  京王電鉄: '京王',
  京成電鉄: '京成',
  小田急電鉄: '小田急',
  東武鉄道: '東武',
  西武鉄道: '西武',
  東急電鉄: '東急',
  京浜急行電鉄: '京急',
  相模鉄道: '相鉄',
  東京地下鉄: '東京メトロ',
};
const KEY_ALIAS = { JR常磐線快速: 'JR常磐快速線', JR中央線JC: 'JR中央線', 総武本線: 'JR総武本線' };

// "JR京浜東北線・根岸線 各駅停車 (南浦和 → 大船)" → "JR京浜東北線・根岸線"
// "東京メトロ有楽町線 : 和光市→新木場"            → "東京メトロ有楽町線"
function lineName(raw) {
  if (EXCLUDE.test(raw)) return null;
  const tokens = raw.normalize('NFKC').trim().split(/\s+/);
  const out = [];
  for (const t of tokens) {
    const m = t.search(/[(:]|=?[=-]>|→|⇒/);
    if (m >= 0) {
      if (m > 0) out.push(t.slice(0, m));
      break;
    }
    if (SERVICE_WORDS.test(t)) continue;
    out.push(t);
  }
  const name = out
    .join('')
    .replace(/(上り|下り|内回り|外回り)$/, '')
    .replace(/(各駅停車|各駅|通勤急行|急行|準急|特急)$/, '')
    .replace(/[A-Z]{1,3}$/, '')
    .trim();
  if (!LINE_SUFFIX.test(name) || EXCLUDE.test(name)) return null;
  return name;
}

// 事業者名の表記ゆれをそろえる。JR は事業者タグから「JR」を補う。
function canonicalName(name, tags) {
  const m = name.match(new RegExp(`^(${Object.keys(COMPANY_SHORT).join('|')})(.*)$`));
  if (m) {
    const short = COMPANY_SHORT[m[1]];
    name = m[2].startsWith(short) ? m[2] : short + m[2];
  }
  if (isJR(tags.operator || '') && !/^JR/.test(name)) name = `JR${name}`;
  return KEY_ALIAS[name] ?? name;
}

function isJR(operator) {
  return /JR|東日本旅客鉄道|東海旅客鉄道/.test(operator);
}

// ---- 幾何処理 -------------------------------------------------------------

function inClip(lon, lat) {
  return AREAS.some(({ bbox: [s, w, n, e] }) => {
    return lat >= s - CLIP_MARGIN && lat <= n + CLIP_MARGIN && lon >= w - CLIP_MARGIN && lon <= e + CLIP_MARGIN;
  });
}

// 路線・駅を割り当てるエリア
function areaOf(lon, lat) {
  const inside = AREAS.find(({ bbox: [s, w, n, e] }) => lat >= s && lat <= n && lon >= w && lon <= e);
  if (inside) return inside.id;
  const dist = ({ bbox: [s, w, n, e] }) => Math.hypot(lon - (w + e) / 2, lat - (s + n) / 2);
  return AREAS.reduce((a, b) => (dist(b) < dist(a) ? b : a)).id;
}

const round = (v) => Math.round(v * 1e5) / 1e5;

// Douglas-Peucker (許容誤差は度単位。2e-5 ≒ 2m)
function simplify(pts, tol = 2e-5) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let max = 0;
    let idx = -1;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > max) {
        max = d;
        idx = i;
      }
    }
    if (max > tol) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

function collectWays(rel, g) {
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    if (!['', 'forward', 'backward'].includes(m.role)) continue; // 駅・ホーム等は除外
    if (g.ways.has(m.ref)) continue;
    if (!m.geometry.some((p) => inClip(p.lon, p.lat))) continue;
    g.ways.set(m.ref, m.geometry.map((p) => [round(p.lon), round(p.lat)]));
  }
}

function collectStops(rel, g, nodes) {
  for (const m of rel.members ?? []) {
    if (m.type !== 'node' || !/^(stop|platform|station)/.test(m.role)) continue;
    const n = nodes[m.ref];
    if (n && inClip(n.lon, n.lat)) g.stops.push(n);
  }
}

// 上り/下りやホームごとに別ノードになっているので、同名で近いものを1つの駅にまとめる
function mergeStops(stops) {
  const out = [];
  for (const s of stops) {
    const name = s.name.normalize('NFKC').replace(/\s*[(（].*$/, '').trim();
    const hit = out.find((o) => o.name === name && Math.hypot(o.lon - s.lon, o.lat - s.lat) < 0.004);
    if (hit) {
      hit.lon = (hit.lon * hit.n + s.lon) / (hit.n + 1);
      hit.lat = (hit.lat * hit.n + s.lat) / (hit.n + 1);
      hit.n++;
    } else out.push({ name, lon: s.lon, lat: s.lat, n: 1 });
  }
  return out;
}

// 他の路線の way で(ほぼ)完全に覆われている路線(例: 「A線・B線」と A線, B線)は冗長なので、
// way 数の多い順に見て、残りの路線の和集合に含まれるものを落とす。
function dropCovered(groups) {
  const alive = [...groups].sort((a, b) => b.ways.size - a.ways.size);
  for (const g of [...alive]) {
    const others = alive.filter((o) => o !== g);
    const union = new Set(others.flatMap((o) => [...o.ways.keys()]));
    const covered = [...g.ways.keys()].filter((id) => union.has(id)).length;
    if (covered / g.ways.size >= 0.98) alive.splice(alive.indexOf(g), 1);
  }
  return alive;
}

function groupLines(cat, data, nodes) {
  const groups = new Map();
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags ?? {};
    const raw = tags['name:ja'] || tags.name || tags.ref || '';
    const base = lineName(raw);
    if (!base) continue;
    const name = canonicalName(base, tags);
    const key = name;
    let g = groups.get(key);
    if (!g) {
      g = { names: [], nameEn: '', operators: new Set(), colour: '', ways: new Map(), stops: [] };
      groups.set(key, g);
    }
    g.names.push(name);
    for (const o of (tags.operator || tags.network || '').split(';')) o && g.operators.add(o);
    if (!g.nameEn && tags['name:en']) g.nameEn = tags['name:en'].split(/\s*[(:]/)[0];
    if (!g.colour && tags.colour) g.colour = tags.colour;
    collectWays(rel, g);
    collectStops(rel, g, nodes);
  }
  return [...groups.values()]
    .filter((g) => g.ways.size > 0)
    .map((g) => {
      const operators = [...g.operators];
      const name = g.names[0];
      return { ...g, name, operators };
    });
}

const TOEI = /東京都交通局|都営|Toei/;

// バスの事業者名: 「京成バス株式会社」→「京成バス」。都営バスは「都営バス」にそろえる。
function busOperator(tags) {
  const op = (tags.operator || tags.network || '').split(';')[0];
  if (TOEI.test(op)) return '都営バス';
  return op.normalize('NFKC').replace(/株式会社|有限会社|\s/g, '') || 'バス';
}

// バスは事業者+系統番号(ref)でまとめる。ref が無い場合は名称から系統番号を取り出す。
function groupBus(cat, data, nodes) {
  const groups = new Map();
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags ?? {};
    const raw = tags['name:ja'] || tags.name || '';
    const ref = (tags.ref || raw.match(/バス(\S+?)系統/)?.[1] || '').replace(/\(.*\)$/, '');
    if (!ref) continue;
    const op = busOperator(tags);
    const key = `${op}|${ref}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        name: op === 'バス' ? ref : `${op} ${ref}`, // 事業者が不明なものは系統名だけ
        nameEn: '',
        operators: new Set(),
        colour: tags.colour || '',
        detail: new Set(),
        ways: new Map(),
        stops: [],
      };
      groups.set(key, g);
    }
    for (const o of (tags.operator || '').split(';')) o && g.operators.add(o);
    // 都営バスは名称の「…系統 渋谷駅～新橋駅」から経路を取り出す。他は起点→終点があればそれを使う
    const stops = raw.replace(/^.*系統(（[^）]*）)?\s*/, '');
    if (stops && stops !== raw) g.detail.add(stops);
    else if (tags.from && tags.to) g.detail.add(`${tags.from} → ${tags.to}`);
    collectWays(rel, g);
    collectStops(rel, g, nodes);
  }
  return [...groups.values()]
    .filter((g) => g.ways.size > 0)
    .map((g) => ({ ...g, operators: [...g.operators], detail: [...g.detail].slice(0, 4).join(' / ') }));
}

// 色指定のない路線は、路線名から決まる色(再生成しても変わらない)を割り当てる
function fallbackColour(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  const hue = h % 360;
  const l = 0.4;
  const a = 0.65 * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function build(key, cat, data, nodes) {
  const lines = (cat.groupBy === 'ref' ? groupBus(cat, data, nodes) : dropCovered(groupLines(cat, data, nodes))).sort(
    (a, b) => a.name.localeCompare(b.name, 'ja'),
  );
  // 路線の識別(gid・名前・色)は全エリアを通して決め、ジオメトリだけをエリア別に分ける。
  // way は中間の頂点が属するエリアへ、駅はその座標が属するエリアへ割り当てる(重複して描かない)。
  const byArea = Object.fromEntries(
    AREAS.map((a) => [a.id, { lines: [], stops: [] }]),
  );
  const index = [];
  lines.forEach((g, gid) => {
    const colour = /^#[0-9a-f]{6}$/i.test(g.colour)
      ? g.colour
      : cat.groupBy === 'ref'
        ? cat.defaultColour
        : fallbackColour(g.name);
    const waysByArea = {};
    const box = [Infinity, Infinity, -Infinity, -Infinity]; // w, s, e, n
    const extend = ([lon, lat]) => {
      box[0] = Math.min(box[0], lon);
      box[1] = Math.min(box[1], lat);
      box[2] = Math.max(box[2], lon);
      box[3] = Math.max(box[3], lat);
    };
    for (const way of g.ways.values()) {
      const pts = simplify(way);
      pts.forEach(extend);
      const [lon, lat] = pts[Math.floor(pts.length / 2)];
      (waysByArea[areaOf(lon, lat)] ??= []).push(pts);
    }
    const stops = mergeStops(g.stops);
    for (const st of stops) {
      const area = areaOf(st.lon, st.lat);
      byArea[area].stops.push({
        type: 'Feature',
        properties: { gid, cat: key, name: st.name, colour },
        geometry: { type: 'Point', coordinates: [round(st.lon), round(st.lat)] },
      });
    }
    for (const [area, ways] of Object.entries(waysByArea)) {
      byArea[area].lines.push({
        type: 'Feature',
        properties: { gid, cat: key, colour },
        geometry: { type: 'MultiLineString', coordinates: ways },
      });
    }
    index.push({
      cat: key,
      gid,
      name: g.name,
      nameEn: g.nameEn,
      operator: g.operators.join(' / '),
      colour,
      detail: g.detail ?? '',
      bbox: box,
      areas: Object.keys(waysByArea),
    });
  });
  return { index, byArea };
}

await rm(OUT_DIR, { recursive: true, force: true });
const index = [];
const extents = Object.fromEntries(AREAS.map((a) => [a.id, [Infinity, Infinity, -Infinity, -Infinity]]));
for (const [key, cat] of Object.entries(CATEGORIES)) {
  const raw = await loadCategory(key, cat);
  const nodes = await loadNodes(key, cat);
  const built = build(key, cat, raw, nodes);
  index.push(...built.index);
  let summary = '';
  for (const area of AREAS) {
    const { lines, stops } = built.byArea[area.id];
    await mkdir(join(OUT_DIR, area.id), { recursive: true });
    const json = JSON.stringify({ type: 'FeatureCollection', features: lines });
    await writeFile(join(OUT_DIR, area.id, `${key}.geojson`), json);
    await writeFile(
      join(OUT_DIR, area.id, `${key}-stops.geojson`),
      JSON.stringify({ type: 'FeatureCollection', features: stops }),
    );
    // エリアの実データの範囲(画面でどのエリアを読み込むかの判定に使う)
    const box = extents[area.id];
    const grow = ([lon, lat]) => {
      box[0] = Math.min(box[0], lon);
      box[1] = Math.min(box[1], lat);
      box[2] = Math.max(box[2], lon);
      box[3] = Math.max(box[3], lat);
    };
    for (const f of lines) for (const way of f.geometry.coordinates) way.forEach(grow);
    for (const f of stops) grow(f.geometry.coordinates);
    summary += ` ${area.id}: ${lines.length} lines (${(json.length / 1024).toFixed(0)} KB), ${stops.length} stops;`;
  }
  console.log(`[${key}] ${built.index.length} lines total |${summary}`);
}
const areas = AREAS.map(({ id, name }) => ({ id, name, bbox: extents[id] }));
await writeFile(join(OUT_DIR, 'index.json'), JSON.stringify({ areas, lines: index }));
console.log(`index.json: ${index.length} lines`);
