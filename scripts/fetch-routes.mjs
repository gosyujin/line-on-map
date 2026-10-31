// OpenStreetMap (Overpass API) から東京近郊の路線データを取得し、
// 路線単位にまとめた GeoJSON を public/data/ に出力する。
//
//   npm run fetch-data            # キャッシュがあれば再利用
//   npm run fetch-data -- --force # 再取得
//
// データ © OpenStreetMap contributors (ODbL)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(ROOT, '.cache');
const OUT_DIR = join(ROOT, 'public', 'data');
const FORCE = process.argv.includes('--force');

const UA = 'line-on-map/0.1 (https://github.com/gosyujin/line-on-map)';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// 取得対象範囲 (south, west, north, east)
const BBOX = [35.45, 139.35, 35.85, 139.95];
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
    // バスは数が膨大なので、まずは都営バスのみ。範囲を広げる場合は正規表現を変更する。
    query: `relation["route"="bus"]["operator"~"東京都交通局|都営|Toei"]`,
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

async function loadCategory(key, cat) {
  const cacheFile = join(CACHE_DIR, `${key}.json`);
  if (!FORCE && existsSync(cacheFile)) {
    console.log(`[${key}] using cache`);
    return JSON.parse(await readFile(cacheFile, 'utf8'));
  }
  console.log(`[${key}] fetching from Overpass...`);
  const data = await overpass(`${cat.query}(${BBOX.join(',')});out geom;`);
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cacheFile, JSON.stringify(data));
  return data;
}

// ---- 路線名の正規化 -------------------------------------------------------
// OSM の路線リレーションは「各駅停車/快速/特急/直通運転」など列車種別・方向ごとに
// 作られているため、名前から種別・方向を取り除いて路線単位にまとめる。

const SERVICE_WORDS = /^(各駅停車|各停|普通|快速|急行|準急|特急|快特|通勤快速|通勤急行|通勤特急|区間快速|空港快速|快速急行|快速特急)$/;
// 路線ではない(列車愛称・直通運転・テーマパーク等)ものは除外
const EXCLUDE =
  /直通|運転|地下鉄-|\s-\s|成田エクスプレス|スカイライナー|シテイライナー|TJライナー|拝島ライナー|アクセス|列車|S-Train|ウエスタンリバー|^(あさま|あずさ|かがやき|こだま|のぞみ|たにがわ|とき|ひたち|ちちぶ|小江戸|踊り子|はこね|スーパーはこね|さがみ|えのしま|ふじさん|しおさい|さざなみ|多摩快速急行|各駅停車|小田急通勤急行)/;
const LINE_SUFFIX = /(線|ライン|ゆりかもめ|モノレール|ライナー|電鉄|鉄道)$/;
// 事業者名プレフィックス(キー用。表示名には残す)
const COMPANY_PREFIX =
  /^(JR|東日本旅客鉄道|京王電鉄|京王|京成電鉄|京成|小田急電鉄|小田急|東武鉄道|東武|西武鉄道|西武|東急電鉄|東急|京浜急行電鉄|京急|相模鉄道|相鉄|東京メトロ|東京地下鉄|都営|横浜市営地下鉄|東京モノレール)/;
const KEY_ALIAS = { 常磐線快速: '常磐快速線', 'JR常磐線快速': '常磐快速線', 中央線JC: '中央線' };

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

function lineKey(name) {
  const k = name.replace(COMPANY_PREFIX, '');
  return KEY_ALIAS[name] ?? KEY_ALIAS[k] ?? k;
}

function isJR(operator) {
  return /JR|東日本旅客鉄道|東海旅客鉄道/.test(operator);
}

// ---- 幾何処理 -------------------------------------------------------------

function inClip(lon, lat) {
  const [s, w, n, e] = BBOX;
  return (
    lat >= s - CLIP_MARGIN && lat <= n + CLIP_MARGIN && lon >= w - CLIP_MARGIN && lon <= e + CLIP_MARGIN
  );
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

function groupLines(cat, data) {
  const groups = new Map();
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags ?? {};
    const raw = tags['name:ja'] || tags.name || tags.ref || '';
    const name = lineName(raw);
    if (!name) continue;
    const key = lineKey(name);
    let g = groups.get(key);
    if (!g) {
      g = { names: [], nameEn: '', operators: new Set(), colour: '', ways: new Map() };
      groups.set(key, g);
    }
    g.names.push(name);
    for (const o of (tags.operator || tags.network || '').split(';')) o && g.operators.add(o);
    if (!g.nameEn && tags['name:en']) g.nameEn = tags['name:en'].split(/\s*[(:]/)[0];
    if (!g.colour && tags.colour) g.colour = tags.colour;
    collectWays(rel, g);
  }
  return [...groups.values()]
    .filter((g) => g.ways.size > 0)
    .map((g) => {
      const operators = [...g.operators];
      let name = g.names.sort((a, b) => a.length - b.length)[0];
      if (operators.some(isJR) && !/^JR/.test(name) && !/メトロ|都営|地下鉄/.test(name)) name = `JR${name}`;
      return { ...g, name, operators };
    });
}

// バスは系統番号(ref)でまとめる。ref が無い場合は名称から系統番号を取り出す。
function groupBus(cat, data) {
  const groups = new Map();
  for (const rel of data.elements) {
    if (rel.type !== 'relation') continue;
    const tags = rel.tags ?? {};
    const raw = tags['name:ja'] || tags.name || '';
    const ref = (tags.ref || raw.match(/バス(\S+?)系統/)?.[1] || '').replace(/\(.*\)$/, '');
    if (!ref) continue;
    let g = groups.get(ref);
    if (!g) {
      g = {
        name: `都営バス ${ref}`,
        nameEn: '',
        operators: new Set(),
        colour: tags.colour || '',
        detail: new Set(),
        ways: new Map(),
      };
      groups.set(ref, g);
    }
    for (const o of (tags.operator || '').split(';')) o && g.operators.add(o);
    const stops = raw.replace(/^.*系統(（[^）]*）)?\s*/, '');
    if (stops && stops !== raw) g.detail.add(stops);
    collectWays(rel, g);
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

function build(key, cat, data) {
  const lines = cat.groupBy === 'ref' ? groupBus(cat, data) : dropCovered(groupLines(cat, data));
  const features = lines
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    .map((g, gid) => ({
      type: 'Feature',
      properties: {
        gid,
        cat: key,
        name: g.name,
        nameEn: g.nameEn,
        operator: g.operators.join(' / '),
        colour: /^#[0-9a-f]{6}$/i.test(g.colour)
          ? g.colour
          : cat.groupBy === 'ref'
            ? cat.defaultColour
            : fallbackColour(g.name),
        detail: g.detail ?? '',
      },
      geometry: { type: 'MultiLineString', coordinates: [...g.ways.values()].map((w) => simplify(w)) },
    }));
  return { type: 'FeatureCollection', features };
}

await mkdir(OUT_DIR, { recursive: true });
for (const [key, cat] of Object.entries(CATEGORIES)) {
  const raw = await loadCategory(key, cat);
  const fc = build(key, cat, raw);
  const json = JSON.stringify(fc);
  await writeFile(join(OUT_DIR, `${key}.geojson`), json);
  console.log(`[${key}] ${fc.features.length} lines, ${(json.length / 1024).toFixed(0)} KB`);
}
