# Line on Map

東京近郊の電車・地下鉄・バスを、実際に通っているルートで地図上に表示するWebアプリです。
路線をクリック/タップすると、その路線がオレンジのグローで強調されます。

公開URL: https://note.gosyujin.com/line-on-map/

## 構成

- 地図: [MapLibre GL JS](https://maplibre.org/) + [地理院タイル(淡色地図)](https://maps.gsi.go.jp/development/ichiran.html)
- 路線データ: [OpenStreetMap](https://www.openstreetmap.org/) の路線リレーション(Overpass API で取得)
- ビルド: Vite / デプロイ: GitHub Actions → GitHub Pages

## 開発

```bash
npm install
npm run dev      # http://localhost:5173/line-on-map/
npm run build
```

## 路線データの更新

`public/data/*.geojson` は `scripts/fetch-routes.mjs` で生成し、リポジトリにコミットしています
(CI から Overpass API は呼びません)。

```bash
npm run fetch-data              # .cache/ があればそれを使って整形のみ
npm run fetch-data -- --force   # Overpass API から再取得
```

- OSM の路線リレーションは列車種別・方向ごとに分かれているため、スクリプトで路線単位にまとめています
  (種別・方向・直通運転の除去、他路線に完全に含まれる重複路線の除去、座標の間引き)。
- バスは数が膨大なため、現在は都営バスのみです。対象を広げる場合は `CATEGORIES.bus.query` を変更してください。
- 対象範囲は `BBOX` で指定しています。

## データの出典

- 路線データ © OpenStreetMap contributors (ODbL)
- 背景地図: 地理院タイル
