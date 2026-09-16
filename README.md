# 新豐廠半成品儀表板

## 日常更新方式

1. 先在 GitHub Desktop 按 **Fetch origin / Pull origin**，取得最新自動轉檔結果，避免 `manifest.json` 衝突。
2. 將新的 `.xlsx` 檔放到 `data/年份/月分/`（例如 `data/2026/09/`）。
3. Commit 並 Push 到 `main` 或 `master`。
4. GitHub Actions 會自動掃描整個 `data` 資料夾，更新 `data/manifest.json`、`data/json-manifest.json` 與 `data-json/`。
5. Actions 完成後，再按一次 **Pull origin**，把機器人產生的 JSON 拉回電腦。

不需要手動修改任何 manifest。Excel 檔名須符合網站既有規則：

- 半成品資料：檔名含「半成品報廢管理表」或「半成品生產管理日報」
- JFM 資料：檔名含「生產管理報表」

## 本機手動轉檔

需要 Node.js 20 以上版本：

```bash
npm ci
npm run convert:data
npm run check:data
```

網站會優先讀取精簡 JSON；若某份 JSON 尚未生成或讀取失敗，才會自動退回讀取原始 Excel。
