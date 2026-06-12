# 🏫 教室予約管理システム

教室の利用予約を全利用者でリアルタイム共有できる Web アプリです。

## 機能

- **教室の追加** — 教室名・予約日・開始時刻・利用時間を入力して予約を登録
- **利用時間の選択** — 30分・1時間・1時間30分・2時間から選択
- **重複チェック** — 同じ教室名・同じ日付での二重予約を防止
- **🔥 リアルタイム共有** — Firebase で全利用者が即時に同期（SSE ストリーミング）
- **予約一覧** — 日付・時刻順に並び替えて表示
- **絞り込み検索** — 教室名でリアルタイム絞り込み
- **削除確認** — 誤削除を防ぐ確認モーダル、アニメーションで滑らかに消える
- **接続ステータス** — 🟢 リアルタイム同期中 / 🔴 接続エラー を常時表示

## 技術スタック

| 分類 | 使用技術 |
|------|----------|
| 構造 | HTML5 (Semantic) |
| スタイル | Vanilla CSS (Glassmorphism, CSS Custom Properties) |
| ロジック | Vanilla JavaScript (ES2020+, async/await) |
| データ同期 | Firebase Realtime Database (REST API + SSE) |
| フォント | Google Fonts / Noto Sans JP |
| 設定保存 | localStorage（Firebase URL のみ） |

## セットアップ方法

### 1. Firebase プロジェクトを作成

1. [Firebase コンソール](https://console.firebase.google.com/) でプロジェクトを作成
2. 「Realtime Database」を作成 → **テストモードで開始**
3. データベース URL をコピー（例: `https://your-project-default-rtdb.firebaseio.com`）

### 2. アプリを開く

`index.html` をブラウザで開くと初回設定画面が表示されます。
Database URL を貼り付けて「保存して接続」を押すだけです。

### 3. 全員で共有

同じ Firebase URL を設定すれば、誰でもリアルタイムで予約を共有できます。

## ディレクトリ構成

```
classroom-booking/
├── index.html   # メインHTML（セットアップ画面・予約フォーム・一覧）
├── style.css    # スタイルシート（Glassmorphism・ダークUI）
├── app.js       # アプリロジック（Firebase SSE・リアルタイム同期）
├── .gitignore
└── README.md
```

## 修正・改善履歴

### v2.0
- **Firebase Realtime Database 連携** によるリアルタイム全ユーザー共有
- **削除バグ修正** — `pendingDeleteId` が `null` になる問題を解消
- 削除アニメーションを CSS トランジションに変更し確実に動作するよう改善
- 接続ステータスバッジをヘッダーに追加
- Firebase 初期設定ウィザード（接続テスト機能付き）を追加

---

MIT License
