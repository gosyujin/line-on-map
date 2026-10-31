# Line on Map

東京近郊の電車・地下鉄・バスを、実際に通っているルートで地図上に表示するWebアプリです。
路線をクリック/タップすると、その路線がオレンジのグローで強調されます。

公開URL: https://note.gosyujin.com/line-on-map/

## 構成

- 地図: [MapLibre GL JS](https://maplibre.org/) + [OpenStreetMap](https://www.openstreetmap.org/) 標準タイル(彩度を少し落として表示)
- 路線データ: [OpenStreetMap](https://www.openstreetmap.org/) の路線リレーション(Overpass API で取得)
- ビルド: Vite / デプロイ: GitHub Actions → GitHub Pages

## 開発

```bash
npm install
npm run dev      # http://localhost:5173/line-on-map/
npm run build
```

## 路線データの更新

`public/data/` は `scripts/fetch-routes.mjs` で生成し、リポジトリにコミットしています
(CI から Overpass API は呼びません)。

- `public/data/index.json`: 全路線の一覧(名前・色・範囲・属するエリア)とエリアの範囲。起動時に1回読み込み、路線検索に使います。
- `public/data/<エリア>/<種別>.geojson`, `<種別>-stops.geojson`: 路線・駅のジオメトリ。エリア(東京・千葉)ごとに分けてあり、
  地図の表示範囲に入ったエリアだけを読み込みます(縮尺が小さいときは読み込みません)。

```bash
npm run fetch-data              # .cache/ があればそれを使って整形のみ
npm run fetch-data -- --force   # Overpass API から再取得
```

- OSM の路線リレーションは列車種別・方向ごとに分かれているため、スクリプトで路線単位にまとめています
  (種別・方向・直通運転の除去、他路線に完全に含まれる重複路線の除去、座標の間引き)。
- 駅・停留所は路線リレーションの stop/platform メンバーから取得し、`<種別>-stops.geojson` に出力します。
- 対象エリアは `scripts/fetch-routes.mjs` の `AREAS` で指定します(現在は東京と千葉: 千葉市・船橋・柏周辺から成田空港まで)。
  エリアを足すと、同じ仕組みで出力・読み込みされます。
- バスは数が膨大なため、東京は都営バスのみ、千葉は全事業者です。絞り込みは `AREAS[].filter` で指定します。
- 路線の識別(番号・名前・色)は全エリアを通して決め、ジオメトリだけをエリアごとのファイルに分けています。
  エリアをまたぐ路線(総武線・京葉線など)は、通る場所に応じて両方のエリアに分かれて入ります。

## データの出典

- 路線データ © OpenStreetMap contributors (ODbL)
- 背景地図: © OpenStreetMap contributors。標準タイルサーバー(tile.openstreetmap.org)を利用しているため、アクセスが増える場合は[タイル利用ポリシー](https://operations.osmfoundation.org/policies/tiles/)に従い、別のタイル提供元への切り替えを検討してください。
