# AI File Search ビルド手順

## Mac版 (.dmg) を作る

```bash
# 1. フォルダに移動
cd local-ai-search

# 2. パッケージインストール
npm install

# 3. ビルド
npm run build:mac
```

完了したら `dist` フォルダに：
- `AI File Search-1.0.0.dmg`

---

## Windows版 (.exe) を作る

```bash
# 1. フォルダに移動
cd local-ai-search

# 2. パッケージインストール
npm install

# 3. ビルド
npm run build:win
```

完了したら `dist` フォルダに：
- `AI File Search Setup 1.0.0.exe`

---

## GitHub Releasesにアップロード

1. https://github.com/addness-teambase/ai-file-search/releases/edit/v1.0.0
2. `dist` フォルダ内のファイルをドラッグ＆ドロップ
3. 「Update release」をクリック

---

## ユーザーの使い方

### Mac
1. .dmg をダウンロード
2. ダブルクリックで開く
3. アプリをApplicationsにドラッグ
4. アプリを開く

### Windows
1. .exe をダウンロード
2. ダブルクリックでインストール
3. アプリを起動

**Node.js不要、コマンド不要！**
