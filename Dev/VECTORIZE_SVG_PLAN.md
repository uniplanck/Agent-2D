# Vectorize to SVG — scoped design note

## Purpose

Agent-2D の将来機能として、イラスト・ロゴ・アイコン・線画・フラット素材を raster 画像から SVG へベクター化するモードを追加する。

これは Real-ESRGAN 系の「超解像」とは別種の処理で、写真を高精細化する機能ではない。写真をそのまま SVG 化しても、写真としてのディテールを無限解像度にできるわけではないため、写真主体の入力には原則として推奨しない。

## Proposed mode

UI 名の第一候補は `Vectorize to SVG`。日本語補助表記は `SVG化 · イラスト/線画向け` とする。

対象:
- ロゴ
- アイコン
- 線画
- フラットイラスト
- 単純な図形・少色素材

非推奨:
- 写真
- 複雑な自然画像
- 微細なノイズや質感が主役の画像

## Minimal pipeline direction

1. 入力を適切に前処理する。
2. 色数・エッジ・透明度を解析する。
3. potrace / vtracer 系の local-first vectorization backend を比較する。
4. SVG path 数、色数、ファイルサイズ、視覚差分を検証する。
5. original raster preview と SVG rasterized preview を Before / After で比較する。

既存の Enhance / Compress / Optimize / 超カスタムとは別 operation とし、通常の image codec output format 選択へ混ぜない。

## Acceptance before implementation

- 線画/ロゴの輪郭崩れが許容範囲であること
- SVG が実際に vector path を持ち、埋め込み raster の単なるラッパーではないこと
- 大きく拡大してもエッジが劣化しないこと
- path 数が暴走しないこと
- 写真入力には非推奨表示を出せること

今回は設計記録のみ。full implementation は別Sprintで行う。
