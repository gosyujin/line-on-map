// OpenStreetMap (Overpass API) から東京近郊・北海道の路線データを取得し、
// 路線単位にまとめた GeoJSON を public/data/ に出力する。
//
//   npm run fetch-data            # キャッシュがあれば再利用
//   npm run fetch-data -- --force # 再取得
//   npm run fetch-data -- --areas=hokkaido  # 指定エリアだけ作り、今ある public/data に足す(ほかのエリアのファイルは触らない。公開中のデータを作り直さずに、エリアを足すとき)
//
// データ © OpenStreetMap contributors (ODbL)

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'public', 'data');
const FORCE = process.argv.includes('--force');
// --areas=a,b: そのエリアだけ取得・出力し、今ある public/data/index.json に足す。ほかのエリアは作り直さない
const ONLY = (process.argv.find((a) => a.startsWith('--areas='))?.slice('--areas='.length) ?? '').split(',').filter(Boolean);

const UA = 'line-on-map/0.1 (https://github.com/gosyujin/line-on-map)';
const ENDPOINTS = (process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : []).concat([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
]);

// 取得対象エリア。bbox は (south, west, north, east)。
// データはエリアごとのファイルに分けて出力し、画面では表示範囲に入ったエリアだけを読み込む。
// 路線・駅は、先に並んだ(bbox に含まれる)エリアへ割り当てる。どれにも含まれなければ中心が最も近いエリア。
// filter は種別ごとの追加条件(種別ごとに Overpass のクエリへ足す)。現在はどのエリアも絞り込まない。
// ways はそのエリアで、路線リレーションではなく線路(way)の名前から路線を作る種別。北海道は路線リレーションが
// 特急・快速の運行系統ばかりで、函館本線・千歳線などの「路線」が OSM に無いため。
// skip はそのエリアで取得しない種別。データが大きすぎるバスは、北海道では取得しない
// (画面側がエリア×全種別のファイルを読むので、取得しない種別も空のファイルは出力する)。
const AREAS = [
  { id: 'tokyo', name: '東京', bbox: [35.45, 139.35, 35.85, 139.95], filter: {} },
  // 東端は成田空港(東経140.39°)まで含める
  { id: 'chiba', name: '千葉', bbox: [35.5, 139.9, 35.95, 140.5], filter: {} },
  // 北海道全域(渡島半島の南端から、根室・知床まで)
  { id: 'hokkaido', name: '北海道', bbox: [41.3, 139.3, 45.6, 145.9], filter: {}, ways: ['train'], skip: ['bus'] },
];
const areasOf = (key) => AREAS.filter((a) => !a.skip?.includes(key) && (!ONLY.length || ONLY.includes(a.id)));
const byWays = (key, area) => area.ways?.includes(key);
if (ONLY.some((id) => !AREAS.some((a) => a.id === id))) throw new Error(`--areas: unknown area in ${ONLY}`);
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
  for (const area of areasOf(key)) {
    const ways = byWays(key, area);
    const cacheFile = join(CACHE_DIR, ways ? `${key}-ways-${area.id}.json` : `${key}-${area.id}.json`);
    let data;
    if (!FORCE && existsSync(cacheFile)) {
      console.log(`[${key}/${area.id}] using cache`);
      data = JSON.parse(await readFile(cacheFile, 'utf8'));
    } else {
      console.log(`[${key}/${area.id}] fetching ${ways ? 'ways' : 'relations'} from Overpass...`);
      // service (側線・留置線など) の付いた線路は除く
      const q = ways ? `way["railway"~"^(rail|light_rail|monorail)$"][!"service"]${area.filter[key] ?? ''}(${area.bbox.join(',')})` : areaQuery(key, cat, area);
      data = await overpass(`${q};out geom;`);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(cacheFile, JSON.stringify(data));
    }
    for (const e of data.elements) elements.set(`${e.type}${e.id}`, e);   // id は種類ごとに別なので、種類も付けてまとめる
  }
  return { elements: [...elements.values()] };
}

// 路線リレーションのメンバーノード(駅・停留所)の名前と座標を取得する
async function loadNodes(key, cat) {
  const nodes = {};
  for (const area of areasOf(key)) {
    const ways = byWays(key, area);
    const cacheFile = join(CACHE_DIR, ways ? `${key}-stations-${area.id}.json` : `${key}-nodes-${area.id}.json`);
    if (!FORCE && existsSync(cacheFile)) {
      console.log(`[${key}/${area.id}] using nodes cache`);
      Object.assign(nodes, JSON.parse(await readFile(cacheFile, 'utf8')));
      continue;
    }
    console.log(`[${key}/${area.id}] fetching stops from Overpass...`);
    // 線路から作る種別は、路線のメンバーが無いので、エリア内の駅・停留所 (operator つき) を全部取る
    const data = await overpass(ways ? `node["railway"~"^(station|halt)$"](${area.bbox.join(',')});out;` : `${areaQuery(key, cat, area)}->.r;node(r.r);out;`);
    const found = {};
    for (const e of data.elements) {
      const name = e.tags?.['name:ja'] || e.tags?.name;
      if (e.type === 'node' && name) found[e.id] = { name, lat: e.lat, lon: e.lon, ...(e.tags.operator ? { operator: e.tags.operator } : {}) };
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
// 成田スカイアクセス線は OSM に「京成成田空港アクセス (京成上野 → 成田空港)」という列車サービスの
// リレーションしかないため、サービス名の除外対象にせず、他の路線と共有しない区間だけを1路線にする。
const SKY_ACCESS = /成田空港アクセス/;
const SKY_ACCESS_NAME = '京成成田スカイアクセス線';
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
  // 札幌市営地下鉄は OSM の名前が「南北線」だけで、他の市の路線と区別できない
  if (/札幌市/.test(tags.operator || '') && !/^札幌/.test(name)) name = `札幌市営地下鉄${name}`;
  return KEY_ALIAS[name] ?? name;
}

function isJR(operator) {
  return /JR|東日本旅客鉄道|東海旅客鉄道|北海道旅客鉄道/.test(operator);
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

// 他の路線と共有している way と、印旛日本医大より西の区間(北総線・京成本線側)を落とす
const SKY_ACCESS_MIN_LON = 140.19;

function trimSkyAccess(groups) {
  const sky = groups.get(SKY_ACCESS_NAME);
  if (!sky) return;
  const others = new Set([...groups.entries()].filter(([k]) => k !== SKY_ACCESS_NAME).flatMap(([, g]) => [...g.ways.keys()]));
  for (const [id, way] of [...sky.ways]) {
    if (others.has(id) || way.every(([lon]) => lon < SKY_ACCESS_MIN_LON)) sky.ways.delete(id);
  }
  const pts = [...sky.ways.values()].flat();
  if (!pts.length) return;
  const m = 0.01;
  const [w, e] = [Math.min(...pts.map((p) => p[0])) - m, Math.max(...pts.map((p) => p[0])) + m];
  const [so, n] = [Math.min(...pts.map((p) => p[1])) - m, Math.max(...pts.map((p) => p[1])) + m];
  sky.stops = sky.stops.filter((st) => st.lon >= w && st.lon <= e && st.lat >= so && st.lat <= n);
}

function groupLines(cat, data, nodes) {
  const groups = new Map();
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags ?? {};
    const raw = tags['name:ja'] || tags.name || tags.ref || '';
    const base = SKY_ACCESS.test(raw) && /train/.test(cat.query) ? SKY_ACCESS_NAME : lineName(raw);
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
  trimSkyAccess(groups);
  return [...groups.values()]
    .filter((g) => g.ways.size > 0)
    .map((g) => {
      const operators = [...g.operators];
      const name = g.names[0];
      return { ...g, name, operators };
    });
}

// ---- 線路 (way) の名前から路線を作る (北海道) -----------------------------------
// 名前が揺れている (JR函館線 / JR函館本線 / 函館本線) ので、正式な路線名にそろえる。
const WAY_ALIAS = {
  JR函館線: 'JR函館本線', 函館線: 'JR函館本線', 函館本線: 'JR函館本線',
  JR室蘭線: 'JR室蘭本線', 室蘭線: 'JR室蘭本線', 室蘭本線: 'JR室蘭本線',
  JR根室線: 'JR根室本線', 根室線: 'JR根室本線', 根室本線: 'JR根室本線',
  JR宗谷線: 'JR宗谷本線', 宗谷線: 'JR宗谷本線', 宗谷本線: 'JR宗谷本線',
  JR石北線: 'JR石北本線', 石北線: 'JR石北本線', 石北本線: 'JR石北本線',
  JR釧網線: 'JR釧網本線', 釧網本線: 'JR釧網本線', 釧網線: 'JR釧網本線',
  JR日高線: 'JR日高本線', 日高本線: 'JR日高本線', 日高線: 'JR日高本線',
  札沼線: 'JR札沼線', 石勝線: 'JR石勝線', 富良野線: 'JR富良野線', 千歳線: 'JR千歳線',   // 事業者タグの無い線路にも JR を付ける
  // 青函トンネルの区間 (海峡線) は北海道新幹線と線路を共用している
  北海道新幹線: 'JR北海道新幹線', 海峡線: 'JR北海道新幹線', JR海峡線: 'JR北海道新幹線',
};
// 路線ではないもの (保存鉄道・観光用・廃線)
const WAY_EXCLUDE = /馬車|トロッコ|廃線|豆汽車|リリー|空知鉄道|標津線/;   // 標津線は廃線 (OSM に線路だけ残っている)
// "JR函館線;桂川トンネル" "JR函館本線嵐山トンネル" "海峡線・北海道新幹線" → 路線名の部分 (最初の「…線」「…鉄道」まで)
function wayLineName(tags) {
  const raw = (tags['name:ja'] || tags.name || '').normalize('NFKC');
  if (!raw || WAY_EXCLUDE.test(raw)) return null;
  const part = raw.split(/[;；]/).map((t) => t.match(/^.*?(?:鉄道線|本線|新幹線|線|鉄道)/)?.[0]).find(Boolean);
  return part ? (WAY_ALIAS[part] ?? part) : null;
}

// 駅は、事業者が合い(両方に事業者があれば)、路線の線路から STATION_R 度 (約 160m) 以内にあるものをその路線の駅にする
const STATION_R = 0.0015;
const COS_LAT = 0.73; // 北緯43° 付近。経度の差を縮めて距離の目安にする
function assignStations(groups, nodes) {
  const CELL = 0.01;
  const grid = new Map();
  for (const g of groups) {
    for (const way of g.ways.values()) {
      for (let i = 1; i < way.length; i++) {
        const [ax, ay] = way[i - 1];
        const [bx, by] = way[i];
        const x0 = Math.floor((Math.min(ax, bx) - STATION_R) / CELL);
        const x1 = Math.floor((Math.max(ax, bx) + STATION_R) / CELL);
        const y0 = Math.floor((Math.min(ay, by) - STATION_R) / CELL);
        const y1 = Math.floor((Math.max(ay, by) + STATION_R) / CELL);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            const k = `${x},${y}`;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push({ g, ax, ay, bx, by });
          }
        }
      }
    }
  }
  const near = (n, { ax, ay, bx, by }) => {
    const dx = (bx - ax) * COS_LAT;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const px = (n.lon - ax) * COS_LAT;
    const py = n.lat - ay;
    const t = len2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
    return Math.hypot(px - t * dx, py - t * dy) <= STATION_R;
  };
  // 事業者名の表記ゆれ (JR北海道 / ＪＲ北海道 / 北海道旅客鉄道) をそろえて比べる
  const op = (o) => o.normalize('NFKC').replace(/JR北海道.*/, '北海道旅客鉄道').trim();
  const sameOperator = (g, n) => !n.operator || !g.operators.size || [...g.operators].some((o) => n.operator.split(';').some((t) => op(o).includes(op(t)) || op(t).includes(op(o))));
  for (const n of Object.values(nodes)) {
    const hit = new Set();
    for (const seg of grid.get(`${Math.floor(n.lon / CELL)},${Math.floor(n.lat / CELL)}`) ?? []) {
      if (!hit.has(seg.g) && sameOperator(seg.g, n) && near(n, seg)) hit.add(seg.g);
    }
    for (const g of hit) g.stops.push(n);
  }
}

function groupWays(data, nodes) {
  const groups = new Map();
  for (const e of data.elements) {
    if (e.type !== 'way' || !e.geometry) continue;
    const tags = e.tags ?? {};
    const base = wayLineName(tags);
    if (!base) continue;
    const name = canonicalName(base, tags);
    let g = groups.get(name);
    if (!g) {
      g = { name, nameEn: '', operators: new Set(), colour: '', ways: new Map(), stops: [] };
      groups.set(name, g);
    }
    for (const o of (tags.operator || tags.network || '').split(';')) o && g.operators.add(o);
    if (!g.nameEn && tags['name:en']) g.nameEn = tags['name:en'].split(/\s*[(:]/)[0];
    if (!g.colour && tags.colour) g.colour = tags.colour;
    if (!e.geometry.some((p) => inClip(p.lon, p.lat))) continue;
    g.ways.set(e.id, e.geometry.map((p) => [round(p.lon), round(p.lat)]));
  }
  const out = [...groups.values()].filter((g) => g.ways.size > 0);
  assignStations(out, nodes);
  return out.map((g) => ({ ...g, operators: [...g.operators] }));
}

const TOEI = /東京都交通局|都営|Toei/;

// バスの事業者名: 「京成バス株式会社」→「京成バス」。都営バスは「都営バス」にそろえる。
function busOperator(tags) {
  const op = (tags.operator || tags.network || '').split(';')[0];
  if (TOEI.test(op)) return '都営バス';
  return op.normalize('NFKC').replace(/株式会社|有限会社|\s/g, '') || 'バス';
}

const ARROW = /\s*(?:⇒|→|⇔|⇄|=>|->)\s*/;

// 系統番号が無いバス(空港リムジンなど)は、「リムジンバス 新百合ヶ丘駅⇒羽田空港」のような名称から
// 行き先の組を取り出し、上り・下りを1つの系統にまとめる。取り出せなければ名称をそのまま系統名にする。
function namedRoute(raw) {
  const [from, to, ...rest] = raw.split(ARROW);
  if (!to || rest.length) return { id: raw, label: raw };
  const m = from.match(/^(.*\S)\s+(\S+)$/);
  const [prefix, start] = m ? [m[1], m[2]] : ['', from];
  return { id: `${prefix} ${[start, to].sort()}`, label: `${prefix} ${start}～${to}`.trim() };
}

// バスは事業者+系統番号(ref)でまとめる。ref が無い場合は名称から系統番号を取り出し、それも無ければ名称でまとめる。
function groupBus(cat, data, nodes) {
  const groups = new Map();
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags ?? {};
    const raw = tags['name:ja'] || tags.name || '';
    const number = (tags.ref || raw.match(/バス(\S+?)系統/)?.[1] || '').replace(/\(.*\)$/, '');
    const ref = number ? { id: number, label: number } : raw ? namedRoute(raw) : null;
    if (!ref) continue;
    const op = busOperator(tags);
    const key = `${op}|${ref.id}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        // 事業者が不明なもの、名称に事業者名が入っているものは系統名だけ
        name: op === 'バス' || ref.label.startsWith(op) ? ref.label : `${op} ${ref.label}`,
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

// OSM に路線が無いバスは、scripts/extra-routes.json に手書きで補足する。
// 停留所を順に結んだ簡易的な線として出力する(道路には沿わない)。OSM 側に追加されたら、ここから消す。
function extraRoutes(key) {
  const file = join(ROOT, 'scripts', 'extra-routes.json');
  const extras = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8'))[key] ?? [] : [];
  return extras.map((r, i) => {
    // paths は停留所名を通る順に並べたもの(枝分かれする路線は複数)。省略すると stops の並び順で1本につなぐ
    const at = new Map(r.stops.map((s) => [s.name, [round(s.lon), round(s.lat)]]));
    const paths = r.paths ?? [r.stops.map((s) => s.name)];
    return {
      name: r.name,
      nameEn: '',
      operators: r.operators ?? [],
      colour: r.colour ?? '',
      detail: r.detail ?? '',
      ways: new Map(paths.map((path, j) => [`extra-${key}-${i}-${j}`, path.map((n) => at.get(n))])),
      stops: r.stops.map(({ name, lon, lat }) => ({ name, lon, lat })),
    };
  });
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

function build(key, cat, data, nodes, gidStart = 0) {
  const found =
    cat.groupBy === 'ref'
      ? [...groupBus(cat, data, nodes), ...extraRoutes(key)]
      : [...dropCovered(groupLines(cat, data, nodes)), ...groupWays(data, nodes)];
  const lines = found.sort(
    (a, b) => a.name.localeCompare(b.name, 'ja'),
  );
  // 路線の識別(gid・名前・色)は全エリアを通して決め、ジオメトリだけをエリア別に分ける。
  // way は中間の頂点が属するエリアへ、駅はその座標が属するエリアへ割り当てる(重複して描かない)。
  const byArea = Object.fromEntries(
    AREAS.map((a) => [a.id, { lines: [], stops: [] }]),
  );
  // gid は種別ごとの通し番号。--areas で足すときは、今ある路線の gid を変えないよう、その後ろから振る
  const index = [];
  lines.forEach((g, i) => {
    const gid = gidStart + i;
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

// --areas: 今ある index.json から、そのエリアだけの路線を除いて残す (ほかのエリアのファイルは触らない)
const prev = ONLY.length ? JSON.parse(readFileSync(join(OUT_DIR, 'index.json'), 'utf8')) : { areas: [], lines: [] };
const kept = prev.lines.filter((l) => !l.areas.every((a) => ONLY.includes(a)));
if (!ONLY.length) await rm(OUT_DIR, { recursive: true, force: true });
const index = [...kept];
const extents = Object.fromEntries(AREAS.map((a) => [a.id, [Infinity, Infinity, -Infinity, -Infinity]]));
for (const [key, cat] of Object.entries(CATEGORIES)) {
  if (ONLY.length && !areasOf(key).length) {
    // 指定エリアでは取得しない種別 (北海道のバス)。画面はエリア×全種別のファイルを読むので、空のファイルだけ出す
    for (const id of ONLY) {
      await mkdir(join(OUT_DIR, id), { recursive: true });
      for (const f of [key, `${key}-stops`]) await writeFile(join(OUT_DIR, id, `${f}.geojson`), JSON.stringify({ type: 'FeatureCollection', features: [] }));
    }
    continue;
  }
  const raw = await loadCategory(key, cat);
  const nodes = await loadNodes(key, cat);
  const gidStart = kept.filter((l) => l.cat === key).reduce((m, l) => Math.max(m, l.gid + 1), 0);
  const built = build(key, cat, raw, nodes, gidStart);
  index.push(...built.index);
  let summary = '';
  for (const area of AREAS.filter((a) => !ONLY.length || ONLY.includes(a.id))) {
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
// 今回作ったエリアは実データの範囲を入れ直し、作っていないエリアは今ある index.json の値のまま
const areas = AREAS.filter((a) => !ONLY.length || ONLY.includes(a.id) || prev.areas.some((p) => p.id === a.id)).map(({ id, name }) => {
  const old = prev.areas.find((p) => p.id === id);
  return { id, name, bbox: ONLY.length && !ONLY.includes(id) ? old.bbox : extents[id] };
});
await writeFile(join(OUT_DIR, 'index.json'), JSON.stringify({ areas, lines: index }));
console.log(`index.json: ${index.length} lines`);
