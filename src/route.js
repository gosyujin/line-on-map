// 経路探索(出発駅 → 到着駅で、辿り着ける路線の組み合わせを探す)。
// 駅・停留所のデータには路線上の並び順がないため、「同じ路線に両方の駅があれば、その路線で行ける」
// とみなし、路線の乗り換え回数だけで経路を求める。所要時間や運行本数は考えない。

const WALK_PENALTY_M = 400; // 駅の外を歩く乗り換えは、この距離だけ余分にかかるとみなす
const SAME_STATION_M = 700; // 同じ名前の駅・停留所を「同じ駅」とみなす距離(電車・地下鉄)
const SAME_BUS_STOP_M = 250; // バス停が関わるときの距離
const WALK_NAME_M = 500; // 名前が部分一致する別の駅(川崎 ↔ 京急川崎)へ歩ける距離
const WALK_NEAR_M = 150; // 名前が違っても、これだけ近ければ歩ける駅とみなす距離
const MAX_SEQUENCES = 300; // 経路の候補として詳しく調べる路線の組み合わせの上限
const MAX_VISITS = 300_000; // 探索の暴走を防ぐ上限
const MAX_RESULTS = 10;

const catOf = (lineKey) => lineKey.slice(0, lineKey.indexOf(':'));

function dist(a, b) {
  const dx = (a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)) * 111_320;
  const dy = (a.lat - b.lat) * 110_540;
  return Math.hypot(dx, dy);
}

// 停留所(stops: { cat, gid, name, key, lon, lat })を、同じ駅ごとにまとめる。
// 同じ駅 = 駅名(key)が同じで、近くにある停留所。路線ごとに少しずれた座標をひとまとめにする。
export function buildGraph(stops) {
  const parent = stops.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };

  const byKey = new Map();
  stops.forEach((s, i) => {
    if (!byKey.has(s.key)) byKey.set(s.key, []);
    byKey.get(s.key).push(i);
  });
  for (const idxs of byKey.values()) {
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        const a = stops[idxs[x]];
        const b = stops[idxs[y]];
        const limit = a.cat === 'bus' || b.cat === 'bus' ? SAME_BUS_STOP_M : SAME_STATION_M;
        if (dist(a, b) <= limit) parent[find(idxs[x])] = find(idxs[y]);
      }
    }
  }

  const clusters = [];
  const clusterOf = new Map(); // 根の停留所 index → cluster id
  const sums = [];
  stops.forEach((s, i) => {
    const root = find(i);
    let id = clusterOf.get(root);
    if (id === undefined) {
      id = clusters.length;
      clusterOf.set(root, id);
      clusters.push({ id, key: s.key, lon: 0, lat: 0, lines: new Set(), rail: false });
      sums.push(0);
    }
    const c = clusters[id];
    c.lon += s.lon;
    c.lat += s.lat;
    sums[id]++;
    c.lines.add(`${s.cat}:${s.gid}`);
    if (s.cat !== 'bus') c.rail = true;
  });
  clusters.forEach((c, i) => {
    c.lon /= sums[i];
    c.lat /= sums[i];
  });

  const lineStops = new Map(); // 路線 → その路線が停まる駅(cluster id)
  for (const c of clusters) {
    for (const l of c.lines) {
      if (!lineStops.has(l)) lineStops.set(l, new Set());
      lineStops.get(l).add(c.id);
    }
  }

  const clustersByKey = new Map();
  for (const c of clusters) {
    if (!clustersByKey.has(c.key)) clustersByKey.set(c.key, []);
    clustersByKey.get(c.key).push(c.id);
  }

  return { clusters, lineStops, clustersByKey, walk: buildWalkLinks(clusters), adjacencyCache: new Map() };
}

// 駅の外を歩いて乗り換えられる駅の組(別名の駅)。電車・地下鉄の駅だけを対象にする。
// - 名前が一方を含む(川崎 ↔ 京急川崎)ものは WALK_NAME_M 以内
// - 名前が違っても WALK_NEAR_M 以内なら歩ける
function buildWalkLinks(clusters) {
  const walk = new Map();
  const CELL = 0.01; // 度
  const grid = new Map();
  const cellOf = (c) => [Math.floor(c.lon / CELL), Math.floor(c.lat / CELL)];
  for (const c of clusters) {
    if (!c.rail) continue;
    const [cx, cy] = cellOf(c);
    const k = `${cx},${cy}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(c);
  }
  for (const c of clusters) {
    if (!c.rail) continue;
    const [cx, cy] = cellOf(c);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const o of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (o.id <= c.id || o.key === c.key) continue;
          const d = dist(c, o);
          const [short, long] = c.key.length <= o.key.length ? [c.key, o.key] : [o.key, c.key];
          const nameMatch = short.length >= 2 && long.includes(short);
          if (d > WALK_NAME_M || (!nameMatch && d > WALK_NEAR_M)) continue;
          if (!walk.has(c.id)) walk.set(c.id, []);
          if (!walk.has(o.id)) walk.set(o.id, []);
          walk.get(c.id).push(o.id);
          walk.get(o.id).push(c.id);
        }
      }
    }
  }
  return walk;
}

// 乗り換えられる路線どうしの隣接表。使う種別と、歩く乗り換えの有無で変わる。
function adjacency(graph, { cats, walk }) {
  const cacheKey = `${[...cats].sort()}|${walk}`;
  const cached = graph.adjacencyCache.get(cacheKey);
  if (cached) return cached;

  const adj = new Map();
  const link = (a, b) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };
  const usable = (c) => [...c.lines].filter((l) => cats.has(catOf(l)));
  for (const c of graph.clusters) {
    const ls = usable(c);
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) link(ls[i], ls[j]);
    if (!walk) continue;
    for (const n of graph.walk.get(c.id) ?? []) {
      for (const a of ls) for (const b of usable(graph.clusters[n])) link(a, b);
    }
  }
  graph.adjacencyCache.set(cacheKey, adj);
  return adj;
}

// 路線の並び(seq)を実際にたどる乗り降りの駅を決める。
// 区間ごとに、乗る駅 → 降りる駅の直線距離の合計が短くなる乗り換え駅を選ぶ。
function plan(graph, seq, fromCost, toCost, walk) {
  const { clusters, lineStops } = graph;
  const perLeg = [];
  let prev = null; // 前の区間の「降りる駅 → 状態」
  for (let i = 0; i < seq.length; i++) {
    const stopsOfLine = lineStops.get(seq[i]);
    const boards = new Map(); // 乗る駅 → { cost, prevAlight }
    const board = (b, cost, prevAlight) => {
      const cur = boards.get(b);
      if (!cur || cost < cur.cost) boards.set(b, { cost, prevAlight });
    };
    if (!prev) {
      for (const [b, c] of fromCost) if (stopsOfLine.has(b)) board(b, c, null);
    } else {
      for (const [x, st] of prev) {
        if (stopsOfLine.has(x)) board(x, st.cost, x);
        if (!walk) continue;
        for (const y of graph.walk.get(x) ?? []) {
          if (stopsOfLine.has(y)) board(y, st.cost + WALK_PENALTY_M + dist(clusters[x], clusters[y]), x);
        }
      }
    }
    const alights = new Map(); // 降りる駅 → { cost, board, prevAlight }
    const last = i === seq.length - 1;
    for (const a of last ? [...stopsOfLine].filter((s) => toCost.has(s)) : stopsOfLine) {
      for (const [b, bs] of boards) {
        if (a === b) continue;
        const cost = bs.cost + dist(clusters[b], clusters[a]) + (last ? toCost.get(a) : 0);
        const cur = alights.get(a);
        if (!cur || cost < cur.cost) alights.set(a, { cost, board: b, prevAlight: bs.prevAlight });
      }
    }
    if (!alights.size) return null;
    perLeg.push(alights);
    prev = alights;
  }

  let [a, st] = [...prev].reduce((m, e) => (e[1].cost < m[1].cost ? e : m));
  const a0 = a;
  const cost = st.cost;
  const legs = [];
  for (let i = seq.length - 1; i >= 0; i--) {
    const s = perLeg[i].get(a);
    legs.unshift({ line: seq[i], from: s.board, to: a });
    a = s.prevAlight;
  }
  const walked = (i) => i > 0 && legs[i - 1].to !== legs[i].from;
  const walks =
    legs.filter((_, i) => walked(i)).length + (fromCost.get(legs[0].from) > 0 ? 1 : 0) + (toCost.get(a0) > 0 ? 1 : 0);
  return { legs, walks, cost };
}

/**
 * 出発駅(fromKey)から到着駅(toKey)へ行ける経路を探す。
 * @param graph buildGraph の結果
 * @param opts { from, to: 駅名(key), cats: 使う路線の種別 Set, walk: 駅の外を歩く乗り換えを許すか }
 * @returns 乗り換え回数の少ない順の経路 [{ legs: [{ line, from, to }], walks, cost }]。
 *          from / to は graph.clusters の id。
 */
export function findRoutes(graph, { from, to, cats, walk }) {
  const fromIds = graph.clustersByKey.get(from) ?? [];
  const toIds = graph.clustersByKey.get(to) ?? [];
  if (!fromIds.length || !toIds.length || from === to) return [];

  // 歩ける乗り換えを許すときは、出発・到着の駅の外(川崎 → 京急川崎)から乗り降りしてもよい
  const reachable = (ids) => {
    const cost = new Map(ids.map((id) => [id, 0]));
    if (!walk) return cost;
    for (const id of ids) {
      for (const n of graph.walk.get(id) ?? []) {
        if (!cost.has(n)) cost.set(n, WALK_PENALTY_M + dist(graph.clusters[id], graph.clusters[n]));
      }
    }
    return cost;
  };
  const fromCost = reachable(fromIds);
  const toCost = reachable(toIds);

  const usable = (l) => cats.has(catOf(l));
  const adj = adjacency(graph, { cats, walk });
  const linesAt = (ids) => {
    const set = new Set();
    for (const id of ids) for (const l of graph.clusters[id].lines) if (usable(l)) set.add(l);
    return set;
  };
  const fromLines = linesAt(fromCost.keys());
  const toLines = linesAt(toCost.keys());

  // 到着駅に着く路線から逆向きに、各路線が何区間で着けるかを数える
  const legsLeft = new Map([...toLines].map((l) => [l, 1]));
  const queue = [...toLines];
  for (let h = 0; h < queue.length; h++) {
    const l = queue[h];
    for (const n of adj.get(l) ?? []) {
      if (legsLeft.has(n)) continue;
      legsLeft.set(n, legsLeft.get(l) + 1);
      queue.push(n);
    }
  }
  const minLegs = Math.min(...[...fromLines].map((l) => legsLeft.get(l) ?? Infinity));

  // 出発駅から到着駅へ歩くだけで着く(川崎 → 京急川崎)ときは、電車に乗らない経路にする
  const walkOnly = [];
  if (walk) {
    for (const f of fromIds) {
      for (const t of graph.walk.get(f) ?? []) {
        if (toIds.includes(t)) walkOnly.push({ legs: [], walks: 1, cost: dist(graph.clusters[f], graph.clusters[t]), walkOnly: { from: f, to: t } });
      }
    }
  }
  if (!Number.isFinite(minLegs)) return walkOnly.slice(0, 1);
  // 最短の区間数と、それより1区間多い経路まで調べる
  const maxLegs = minLegs + 1;

  const sequences = [];
  let visits = 0;
  const walkFrom = (seq) => {
    if (++visits > MAX_VISITS) return;
    const line = seq[seq.length - 1];
    if (toLines.has(line)) {
      sequences.push([...seq]);
      // 到着駅の外まで歩く場合は、その路線では降りる駅が足りないことがあるので、先も調べる
      if (!walk) return;
    }
    const left = maxLegs - seq.length;
    for (const n of adj.get(line) ?? []) {
      if (seq.includes(n) || (legsLeft.get(n) ?? Infinity) > left) continue;
      seq.push(n);
      walkFrom(seq);
      seq.pop();
    }
  };
  for (const l of fromLines) if ((legsLeft.get(l) ?? Infinity) <= maxLegs) walkFrom([l]);
  sequences.sort((a, b) => a.length - b.length);

  // 同じ駅(歩ける駅も含む)を2回通る経路は、行って戻る無駄な経路なので省く。乗り換えの乗降の組は除く
  const near = (a, b) => a === b || (walk && (graph.walk.get(a)?.includes(b) ?? false));
  const doubleBack = ({ legs }) => {
    const path = legs.flatMap((l) => [l.from, l.to]);
    return path.some((a, i) => path.some((b, j) => j > i && !(i % 2 === 1 && j === i + 1) && near(a, b)));
  };

  const routes = [...walkOnly.slice(0, 1)];
  for (const seq of sequences.slice(0, MAX_SEQUENCES)) {
    const r = plan(graph, seq, fromCost, toCost, walk);
    if (r && !doubleBack(r)) routes.push(r);
  }

  // 別の経路で使う路線をすべて含む(=遠回りな)経路は省く。徒歩だけの経路は路線を使わないので比べない
  const lineSets = routes.map((r) => new Set(r.legs.map((l) => l.line)));
  const kept = routes.filter(
    (_, i) =>
      !lineSets.some(
        (o, j) => j !== i && o.size > 0 && o.size < lineSets[i].size && [...o].every((l) => lineSets[i].has(l)),
      ),
  );
  kept.sort((a, b) => a.legs.length - b.legs.length || a.walks - b.walks || a.cost - b.cost);
  return kept.slice(0, MAX_RESULTS);
}

// 駅名の候補(入力途中の文字列で絞り込む)。使う種別の路線が通る駅だけを返す。
export function suggestStations(graph, query, cats, limit = 40) {
  const q = query.trim().replace(/\s/g, '').toLowerCase();
  const found = new Map(); // 駅名 → 通る路線の数
  for (const c of graph.clusters) {
    if (q && !c.key.toLowerCase().includes(q)) continue;
    let n = 0;
    for (const l of c.lines) if (cats.has(catOf(l))) n++;
    if (n) found.set(c.key, (found.get(c.key) ?? 0) + n);
  }
  const names = [...found.keys()].sort((a, b) => {
    const rank = (name) => (name.toLowerCase() === q ? -1 : q && name.toLowerCase().startsWith(q) ? 0 : 1);
    const pa = rank(a);
    const pb = rank(b);
    return pa - pb || found.get(b) - found.get(a) || a.localeCompare(b, 'ja');
  });
  return { names: names.slice(0, limit), total: names.length };
}

/**
 * 経路を「乗る / 歩く」の順の手順に直す。
 * 出発・到着の駅名(fromKey / toKey)と乗降する駅が違う場合は、その間を歩く手順を足す。
 * @returns [{ type: 'ride', line, from, to } | { type: 'walk', from, to }](from / to は cluster id)
 */
export function routeSteps(graph, route, fromKey, toKey) {
  if (route.walkOnly) return [{ type: 'walk', ...route.walkOnly }];
  const nearTo = (id, keyIds) =>
    keyIds.includes(id) ? id : keyIds.find((k) => graph.walk.get(k)?.includes(id)) ?? id;
  const { legs } = route;
  const steps = [];
  const start = nearTo(legs[0].from, graph.clustersByKey.get(fromKey));
  if (start !== legs[0].from) steps.push({ type: 'walk', from: start, to: legs[0].from });
  legs.forEach((leg, i) => {
    if (i > 0 && legs[i - 1].to !== leg.from) steps.push({ type: 'walk', from: legs[i - 1].to, to: leg.from });
    steps.push({ type: 'ride', ...leg });
  });
  const last = legs[legs.length - 1].to;
  const end = nearTo(last, graph.clustersByKey.get(toKey));
  if (end !== last) steps.push({ type: 'walk', from: last, to: end });
  return steps;
}
