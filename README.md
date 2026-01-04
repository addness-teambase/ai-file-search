# AIファイル検索

AIでファイルを自然言語検索できるデスクトップアプリ。

## 機能

- 「見積書どこ？」「先月のレポート」など自然な言葉で検索
- PDF、Word、Excel、PowerPointの中身まで解析
- AIがファイル内容を要約
- デスクトップ、書類、ダウンロードフォルダを自動スキャン

## ダウンロード

[ダウンロードページ](https://addness-teambase.github.io/ai-file-search/)

## 対応形式

- PDF (.pdf)
- Word (.docx)
- Excel (.xlsx)
- PowerPoint (.pptx)
- テキスト (.txt)
- Markdown (.md)
- CSV (.csv)

## 技術スタック

- Electron 28
- Gemini API (gemini-2.5-flash)
- pdf-parse, mammoth, xlsx, adm-zip

## 開発

### 必要環境

- Node.js 18以上
- npm

### セットアップ

```bash
git clone https://github.com/addness-teambase/ai-file-search.git
cd ai-file-search
npm install
```

### 開発サーバー起動

```bash
npm start
```

### ビルド

```bash
# Mac版
npm run build:mac

# Windows版
npm run build:win
```

## ライセンス

MIT
