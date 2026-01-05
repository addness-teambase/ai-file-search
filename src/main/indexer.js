const fs = require('fs');
const path = require('path');
const os = require('os');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

// Gemini API
const GEMINI_API_KEY = 'AIzaSyDxd3fAnVOmwXs4UmMpDhlWjRTNqVU3sbA';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-2.0-flash';

// リトライ用ヘルパー
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callGeminiWithRetry(body, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(
        `${GEMINI_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );

      const data = await res.json();

      if (data.error) {
        if (data.error.message.includes('Quota exceeded') || data.error.code === 429) {
          console.log(`[Gemini] Rate limited, waiting ${(i + 1) * 5}s...`);
          await sleep((i + 1) * 5000);
          continue;
        }
        return { error: data.error };
      }

      return data;
    } catch (e) {
      console.log(`[Gemini] Request error: ${e.message}`);
      if (i < maxRetries - 1) {
        await sleep((i + 1) * 2000);
      }
    }
  }
  return { error: { message: 'Max retries exceeded' } };
}

// スキャン対象
const SCAN_DIRS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads')
];

// Finderサイドバーに表示するすべてのフォルダ（よく使う項目 + 場所）
const SIDEBAR_DIRS = [
  { path: path.join(os.homedir(), 'Desktop'), category: 'favorites' },
  { path: path.join(os.homedir(), 'Documents'), category: 'favorites' },
  { path: path.join(os.homedir(), 'Downloads'), category: 'favorites' },
  { path: os.homedir(), category: 'locations', name: 'ホーム' }
];

// Finderスタイルの日本語フォルダ名マッピング
const FOLDER_NAME_MAP = {
  'Desktop': 'デスクトップ',
  'Documents': '書類',
  'Downloads': 'ダウンロード',
  'Applications': 'アプリケーション',
  'Movies': 'ムービー',
  'Music': 'ミュージック',
  'Pictures': 'ピクチャ',
  'Public': '公開',
  'Library': 'ライブラリ'
};

// フォルダ名を日本語に変換
function getLocalizedFolderName(name) {
  return FOLDER_NAME_MAP[name] || name;
}

// サポートする拡張子
const SUPPORTED_EXT = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.txt', '.md', '.csv'];

// 状態
let fileCache = null;
let watchers = [];
let onChangeCallback = null;

// 除外フォルダ
const SKIP_DIRS = ['node_modules', '__pycache__', '.git', 'Library', 'Applications', '.Trash'];

// ============================================
// フォルダ監視（リアルタイム同期）
// ============================================
function startWatching(callback) {
  onChangeCallback = callback;

  // 既存のwatcherを停止
  stopWatching();

  // 各スキャン対象フォルダを監視
  for (const dir of SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;

    try {
      const watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (filename.startsWith('.')) return;
        if (SKIP_DIRS.some(skip => filename.includes(skip))) return;

        console.log(`[Watch] ${eventType}: ${filename}`);

        // キャッシュをクリア
        fileCache = null;

        // コールバックで通知
        if (onChangeCallback) {
          onChangeCallback({ eventType, filename, dir });
        }
      });

      watchers.push(watcher);
      console.log(`[Watch] Watching: ${dir}`);
    } catch (e) {
      console.log(`[Watch] Error watching ${dir}: ${e.message}`);
    }
  }
}

function stopWatching() {
  for (const watcher of watchers) {
    try {
      watcher.close();
    } catch (e) {}
  }
  watchers = [];
}

// 特定のフォルダを監視
function watchFolder(folderPath, callback) {
  if (!fs.existsSync(folderPath)) return null;

  try {
    const watcher = fs.watch(folderPath, { recursive: false }, (eventType, filename) => {
      if (!filename) return;
      if (filename.startsWith('.')) return;

      console.log(`[WatchFolder] ${eventType}: ${filename} in ${folderPath}`);
      callback({ eventType, filename, folderPath });
    });

    return watcher;
  } catch (e) {
    console.log(`[WatchFolder] Error: ${e.message}`);
    return null;
  }
}

// ============================================
// テキスト抽出（全形式対応）
// ============================================
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath);
  
  console.log(`[Extract] ${ext}: ${fileName}`);
  
  try {
    // PDF
    if (ext === '.pdf') {
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      if (data.text && data.text.trim().length > 0) {
        console.log(`[Extract] PDF OK: ${data.text.length} chars`);
        return data.text;
      }
    }
    
    // Word (.docx)
    if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      if (result.value && result.value.trim().length > 0) {
        console.log(`[Extract] DOCX OK: ${result.value.length} chars`);
        return result.value;
      }
    }
    
    // Excel
    if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.readFile(filePath);
      let text = '';
      for (const name of workbook.SheetNames) {
        text += XLSX.utils.sheet_to_csv(workbook.Sheets[name]) + '\n';
      }
      if (text.trim().length > 0) {
        console.log(`[Extract] Excel OK: ${text.length} chars`);
        return text;
      }
    }
    
    // PowerPoint (.pptx) - ZIPとして解凍
    if (ext === '.pptx') {
      try {
        const zip = new AdmZip(filePath);
        const entries = zip.getEntries();
        let text = '';
        
        for (const entry of entries) {
          if (entry.entryName.startsWith('ppt/slides/slide') && entry.entryName.endsWith('.xml')) {
            const content = entry.getData().toString('utf8');
            // XMLからテキスト部分を抽出
            const matches = content.match(/<a:t>([^<]*)<\/a:t>/g);
            if (matches) {
              for (const match of matches) {
                const t = match.replace(/<\/?a:t>/g, '');
                if (t.trim()) text += t + ' ';
              }
              text += '\n';
            }
          }
        }
        
        if (text.trim().length > 0) {
          console.log(`[Extract] PPTX OK: ${text.length} chars`);
          return text;
        }
      } catch (e) {
        console.log(`[Extract] PPTX parse error: ${e.message}`);
      }
    }
    
    // テキスト系
    if (['.txt', '.md', '.csv'].includes(ext)) {
      const text = fs.readFileSync(filePath, 'utf-8');
      if (text.trim().length > 0) {
        console.log(`[Extract] Text OK: ${text.length} chars`);
        return text;
      }
    }
    
  } catch (e) {
    console.log(`[Extract] Error: ${e.message}`);
  }
  
  console.log(`[Extract] Failed or empty for ${fileName}`);
  return null;
}

// ============================================
// AI要約生成（必ず詳細な要約を出す）
// ============================================
async function generateSummary(content, query, fileName, fileExt) {
  try {
    let prompt;
    
    if (content && content.length >= 30) {
      // コンテンツがある場合：内容ベースで詳細に要約
      const truncated = content.substring(0, 8000);
      prompt = `あなたはファイル内容を要約するアシスタントです。

ユーザーの検索クエリ: 「${query}」

以下のドキュメントの内容を、検索クエリとの関連性を踏まえて要約してください。
- 必ず3〜5文で詳しく説明すること
- ドキュメントの主要なポイントを含めること
- 具体的な数字や固有名詞があれば含めること

ファイル名: ${fileName}

ドキュメント内容:
${truncated}

要約（3〜5文で詳しく）:`;
    } else {
      // コンテンツがない/少ない場合：ファイル名から詳細に推測
      prompt = `あなたはファイル内容を推測するアシスタントです。

ユーザーの検索クエリ: 「${query}」

以下のファイルについて、ファイル名から推測される内容を説明してください。
- 必ず2〜3文で説明すること
- ファイルの種類や用途を推測すること
- 検索クエリとどう関連しそうか説明すること

ファイル名: ${fileName}
ファイル形式: ${fileExt.toUpperCase()}

説明（2〜3文で詳しく）:`;
    }
    
    console.log(`[Summary] Generating for: ${fileName}`);

    const data = await callGeminiWithRetry({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2048
      }
    });
    
    if (data.error) {
      console.log(`[Summary] API Error: ${data.error.message}`);
      return `${fileName} - ${fileExt.toUpperCase()}形式のファイルです。内容の詳細は直接ファイルを開いてご確認ください。`;
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text && text.trim().length > 10) {
      const summary = text.trim();
      console.log(`[Summary] OK (${summary.length} chars)`);
      return summary;
    }
    
    // フォールバック：ファイル名ベースの説明
    return `${fileName} - ${fileExt.toUpperCase()}形式のファイルです。「${query}」に関連する可能性があります。`;
    
  } catch (e) {
    console.log(`[Summary] Error: ${e.message}`);
    return `${fileName} - ${fileExt.toUpperCase()}形式のファイルです。「${query}」に関連する可能性があります。`;
  }
}

// ============================================
// ファイル処理：抽出 + 要約（必ず詳細な説明を返す）
// ============================================
async function processFile(file, query) {
  console.log(`[Process] Starting: ${file.name}`);
  
  const content = await extractText(file.path);
  const summary = await generateSummary(content, query, file.name, file.ext);
  
  console.log(`[Process] Done: ${file.name} -> summary ${summary.length} chars`);
  
  return {
    ...file,
    summary: summary
  };
}

// ============================================
// 初期化
// ============================================
function init() {
  const folderTree = {};
  const favorites = [];
  const locations = [];

  // よく使う項目（Favorites）
  for (const item of SIDEBAR_DIRS) {
    if (!fs.existsSync(item.path)) continue;

    const dirName = path.basename(item.path);
    const displayName = item.name || getLocalizedFolderName(dirName);
    const folderInfo = {
      name: dirName,
      displayName: displayName,
      path: item.path,
      children: getSubfolders(item.path),
      category: item.category
    };

    if (item.category === 'favorites') {
      favorites.push(folderInfo);
    } else if (item.category === 'locations') {
      locations.push(folderInfo);
    }

    folderTree[dirName] = folderInfo;
  }

  return {
    folderTree,
    favorites,
    locations
  };
}

function getSubfolders(dir) {
  const folders = [];

  try {
    const items = fs.readdirSync(dir);

    for (const item of items) {
      if (item.startsWith('.')) continue;
      if (SKIP_DIRS.includes(item)) continue;

      const fullPath = path.join(dir, item);

      try {
        if (fs.statSync(fullPath).isDirectory()) {
          folders.push({
            name: item,
            displayName: getLocalizedFolderName(item),
            path: fullPath,
            children: null
          });
        }
      } catch (e) {}
    }

    folders.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  } catch (e) {}

  return folders;
}

function expandFolder(folderPath) {
  return getSubfolders(folderPath);
}

function getFolderContents(folderPath) {
  const contents = { folders: [], files: [] };

  try {
    if (!fs.existsSync(folderPath)) return contents;

    const items = fs.readdirSync(folderPath);

    for (const item of items) {
      if (item.startsWith('.')) continue;

      const fullPath = path.join(folderPath, item);

      try {
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          if (SKIP_DIRS.includes(item)) continue;
          contents.folders.push({
            name: item,
            displayName: getLocalizedFolderName(item),
            path: fullPath,
            type: 'folder'
          });
        } else if (stat.isFile()) {
          const ext = path.extname(item).toLowerCase();
          if (SUPPORTED_EXT.includes(ext)) {
            contents.files.push({
              name: item,
              path: fullPath,
              ext: ext.slice(1),
              size: stat.size,
              mtime: stat.mtime.toISOString(),
              type: 'file'
            });
          }
        }
      } catch (e) {}
    }

    contents.folders.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    contents.files.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));

  } catch (e) {}

  return contents;
}

// ============================================
// ファイルスキャン
// ============================================
function scanAll() {
  if (fileCache !== null) return fileCache;
  
  console.log('[Scan] Starting full scan...');
  const startTime = Date.now();
  
  fileCache = [];
  
  function scan(dir) {
    try {
      const items = fs.readdirSync(dir);
      
      for (const item of items) {
        if (item.startsWith('.')) continue;
        
        const fullPath = path.join(dir, item);
        
        try {
          const stat = fs.statSync(fullPath);
          
          if (stat.isDirectory()) {
            if (SKIP_DIRS.includes(item)) continue;
            scan(fullPath);
          } else if (stat.isFile()) {
            const ext = path.extname(item).toLowerCase();
            if (SUPPORTED_EXT.includes(ext)) {
              fileCache.push({
                name: item,
                path: fullPath,
                ext: ext.slice(1),
                size: stat.size,
                mtime: stat.mtime.toISOString()
              });
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }
  
  for (const dir of SCAN_DIRS) {
    if (fs.existsSync(dir)) scan(dir);
  }
  
  fileCache.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
  
  console.log(`[Scan] Complete: ${fileCache.length} files in ${Date.now() - startTime}ms`);
  
  return fileCache;
}

function getRecentFiles() {
  const files = scanAll();
  return files.slice(0, 50);
}

// ============================================
// 検索（ファイル + フォルダ対応・幅広検索）
// ============================================
async function searchFiles(query) {
  if (!query?.trim()) {
    return { results: [], error: 'クエリを入力してください' };
  }

  const files = scanAll();
  const folders = scanAllFolders();

  // ファイルとフォルダを統合
  const allItems = [
    ...folders.map(f => ({ ...f, isFolder: true, type: 'folder' })),
    ...files.map(f => ({ ...f, isFolder: false, type: 'file' }))
  ];

  if (allItems.length === 0) {
    return { results: [], error: 'ファイルがありません' };
  }

  console.log(`[Search] Query: "${query}" (${files.length} files, ${folders.length} folders)`);

  try {
    // AI検索でファイル・フォルダ選定（幅広く）
    const itemListText = allItems.slice(0, 800).map((f, i) =>
      `${i}: ${f.isFolder ? '[フォルダ]' : `[${f.ext?.toUpperCase() || 'FILE'}]`} ${f.name}`
    ).join('\n');

    const data = await callGeminiWithRetry({
      contents: [{
        parts: [{
          text: `ファイル・フォルダ検索。クエリに関連するものを幅広く選べ。

クエリ: "${query}"

アイテム一覧:
${itemListText}

ルール:
- 関連しそうなものは積極的に含める（厳しくしすぎない）
- 部分一致、類義語、関連キーワードも考慮
- フォルダ名が関連していればフォルダも含める
- 最大100個まで選択可能

関連アイテムの番号をJSON配列で返せ。例: [0, 3, 12, 45, 67]
関連なければ []
配列のみ返せ。`
        }]
      }],
      generationConfig: { temperature: 0.2 }
    });

    if (data.error) {
      console.log(`[Search] API Error, falling back to local`);
      return await localSearch(query, allItems);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return await localSearch(query, allItems);
    }

    console.log(`[Search] AI response: ${text}`);

    const match = text.match(/\[[\d,\s]*\]/);
    if (!match) {
      return await localSearch(query, allItems);
    }

    const indices = JSON.parse(match[0]);
    if (indices.length === 0) {
      // AIが見つからなくてもローカル検索を試す
      return await localSearch(query, allItems);
    }

    // 各アイテムを処理
    const results = [];
    const targetItems = indices
      .filter(i => i >= 0 && i < allItems.length)
      .slice(0, 100)
      .map(i => allItems[i]);

    for (const item of targetItems) {
      if (item.isFolder) {
        // フォルダはそのまま追加
        results.push({
          ...item,
          summary: `フォルダ: ${item.name}`
        });
      } else {
        // ファイルは要約付き
        const processed = await processFile(item, query);
        results.push(processed);
      }
    }

    return { results, mode: 'ai' };

  } catch (e) {
    console.log(`[Search] Error: ${e.message}`);
    return await localSearch(query, allItems);
  }
}

// フォルダをスキャン
function scanAllFolders() {
  const folders = [];

  function scan(dir, depth = 0) {
    if (depth > 3) return; // 深さ制限

    try {
      const items = fs.readdirSync(dir);

      for (const item of items) {
        if (item.startsWith('.')) continue;
        if (SKIP_DIRS.includes(item)) continue;

        const fullPath = path.join(dir, item);

        try {
          const stat = fs.statSync(fullPath);

          if (stat.isDirectory()) {
            folders.push({
              name: item,
              path: fullPath,
              mtime: stat.mtime.toISOString()
            });
            scan(fullPath, depth + 1);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  for (const dir of SCAN_DIRS) {
    if (fs.existsSync(dir)) scan(dir);
  }

  return folders;
}

// ローカル検索（フォールバック・ファイル+フォルダ対応）
async function localSearch(query, items) {
  console.log(`[LocalSearch] Query: "${query}"`);

  const keywords = query.toLowerCase().split(/\s+/);

  const matched = items
    .map(f => {
      const name = f.name.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (name.includes(kw)) score += 10;
        // 部分一致も少しスコア
        if (kw.length >= 2 && name.includes(kw.slice(0, 2))) score += 2;
      }
      return { ...f, score };
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 100);

  // 各アイテムを処理
  const results = [];
  for (const item of matched) {
    if (item.isFolder) {
      results.push({
        ...item,
        summary: `フォルダ: ${item.name}`
      });
    } else {
      const processed = await processFile(item, query);
      results.push(processed);
    }
  }

  return { results, mode: 'local' };
}

// ============================================
// AI整理提案
// ============================================
async function suggestOrganization(folderPath) {
  console.log(`[Organize] Analyzing folder: ${folderPath}`);

  try {
    // フォルダ内の全ファイルを取得（拡張子制限なし）
    const allFiles = [];

    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'フォルダが存在しません' };
    }

    const items = fs.readdirSync(folderPath);
    for (const item of items) {
      if (item.startsWith('.')) continue;

      const fullPath = path.join(folderPath, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (SKIP_DIRS.includes(item)) continue;
          allFiles.push({
            name: item,
            path: fullPath,
            isFolder: true,
            type: 'folder'
          });
        } else {
          allFiles.push({
            name: item,
            path: fullPath,
            ext: path.extname(item).slice(1).toLowerCase(),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            isFolder: false,
            type: 'file'
          });
        }
      } catch (e) {}
    }

    if (allFiles.length === 0) {
      return { success: false, error: 'フォルダが空です' };
    }

    // ファイルリストを作成
    const fileListText = allFiles.map((f, i) => {
      if (f.isFolder) {
        return `${i}: [フォルダ] ${f.name}`;
      }
      return `${i}: [${f.ext?.toUpperCase() || 'FILE'}] ${f.name}`;
    }).join('\n');

    const prompt = `あなたはファイル整理のエキスパートです。

以下のフォルダ内のファイルを分析し、整理の提案をしてください。

フォルダパス: ${folderPath}

ファイル一覧:
${fileListText}

以下のJSON形式で整理提案を返してください:
{
  "summary": "整理の概要説明（1-2文）",
  "suggestions": [
    {
      "action": "move" または "rename" または "delete" または "create_folder",
      "target": "対象のファイル名またはインデックス番号",
      "destination": "移動先フォルダ名（moveの場合）または新しい名前（renameの場合）",
      "reason": "この操作を提案する理由"
    }
  ]
}

ルール:
- 同じ種類のファイルはグループ化を提案
- 日付やプロジェクト名でフォルダ分けを提案
- 重複しそうなファイルは確認を促す
- 最大10件の提案に絞る
- 必ず有効なJSONのみを返す`;

    const data = await callGeminiWithRetry({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048
      }
    });

    if (data.error) {
      console.log(`[Organize] API Error: ${data.error.message}`);
      return { success: false, error: data.error.message };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { success: false, error: 'AIからの応答がありませんでした' };
    }

    console.log(`[Organize] AI response: ${text}`);

    // JSONを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'JSONの解析に失敗しました' };
    }

    const suggestions = JSON.parse(jsonMatch[0]);

    return {
      success: true,
      folderPath,
      files: allFiles,
      ...suggestions
    };

  } catch (e) {
    console.log(`[Organize] Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============================================
// 整理実行
// ============================================
async function executeOrganization(actions) {
  console.log(`[Execute] Running ${actions.length} actions`);

  const results = [];

  for (const action of actions) {
    try {
      if (action.action === 'create_folder') {
        const newPath = path.join(action.basePath, action.destination);
        if (!fs.existsSync(newPath)) {
          fs.mkdirSync(newPath, { recursive: true });
          results.push({ success: true, action: 'create_folder', path: newPath });
          console.log(`[Execute] Created folder: ${newPath}`);
        }
      }
      else if (action.action === 'move') {
        const sourcePath = action.sourcePath;
        const destFolder = path.join(action.basePath, action.destination);
        const destPath = path.join(destFolder, path.basename(sourcePath));

        // 移動先フォルダがなければ作成
        if (!fs.existsSync(destFolder)) {
          fs.mkdirSync(destFolder, { recursive: true });
        }

        // ファイル移動
        fs.renameSync(sourcePath, destPath);
        results.push({ success: true, action: 'move', from: sourcePath, to: destPath });
        console.log(`[Execute] Moved: ${sourcePath} -> ${destPath}`);
      }
      else if (action.action === 'rename') {
        const sourcePath = action.sourcePath;
        const destPath = path.join(path.dirname(sourcePath), action.destination);

        fs.renameSync(sourcePath, destPath);
        results.push({ success: true, action: 'rename', from: sourcePath, to: destPath });
        console.log(`[Execute] Renamed: ${sourcePath} -> ${destPath}`);
      }
    } catch (e) {
      results.push({ success: false, action: action.action, error: e.message });
      console.log(`[Execute] Error: ${e.message}`);
    }
  }

  // キャッシュをクリア
  fileCache = null;

  return { results };
}

// ============================================
// ファイル統計を取得
// ============================================
function getFileStats(targetFolder = null) {
  const files = scanAll();

  // 対象ファイルをフィルタ
  let targetFiles = files;
  if (targetFolder && fs.existsSync(targetFolder)) {
    targetFiles = files.filter(f => f.path.startsWith(targetFolder));
  }

  // 拡張子別にカウント
  const extCounts = {};
  for (const file of targetFiles) {
    const ext = file.ext.toLowerCase();
    extCounts[ext] = (extCounts[ext] || 0) + 1;
  }

  // フォルダ別にカウント
  const folderCounts = {
    Desktop: files.filter(f => f.path.includes('/Desktop/')).length,
    Documents: files.filter(f => f.path.includes('/Documents/')).length,
    Downloads: files.filter(f => f.path.includes('/Downloads/')).length
  };

  return {
    total: targetFiles.length,
    byExtension: extCounts,
    byFolder: folderCounts,
    files: targetFiles
  };
}

// 整理セッションの状態管理
let organizeSession = {
  active: false,
  step: null, // 'hearing', 'confirm'
  folderPath: null,
  preferences: null,
  suggestions: null,
  files: null
};

// 最後の検索結果を保持
let lastSearchResults = [];

// まとめセッションの状態管理
let collectSession = {
  active: false,
  step: null, // 'naming', 'location', 'confirm', 'existing_folder'
  files: [],
  folderName: null,
  targetPath: null,
  existingFolderPath: null, // 既存フォルダが見つかった場合のパス
  skipDuplicates: true
};

// 利用可能な保存先
const SAVE_LOCATIONS = {
  'デスクトップ': path.join(os.homedir(), 'Desktop'),
  'ダウンロード': path.join(os.homedir(), 'Downloads'),
  '書類': path.join(os.homedir(), 'Documents'),
  'Desktop': path.join(os.homedir(), 'Desktop'),
  'Downloads': path.join(os.homedir(), 'Downloads'),
  'Documents': path.join(os.homedir(), 'Documents')
};

// 既存フォルダを検索
function findExistingFolder(folderName) {
  const results = [];

  function search(dir, depth = 0) {
    if (depth > 2) return; // 深さ制限

    try {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        if (item.startsWith('.')) continue;
        if (SKIP_DIRS.includes(item)) continue;

        const fullPath = path.join(dir, item);
        try {
          if (fs.statSync(fullPath).isDirectory()) {
            // 名前が一致または含まれる場合
            if (item.toLowerCase().includes(folderName.toLowerCase()) ||
                folderName.toLowerCase().includes(item.toLowerCase())) {
              results.push({
                name: item,
                path: fullPath,
                exact: item.toLowerCase() === folderName.toLowerCase()
              });
            }
            search(fullPath, depth + 1);
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  for (const dir of SCAN_DIRS) {
    if (fs.existsSync(dir)) search(dir);
  }

  // 完全一致を優先
  results.sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0));
  return results;
}

// フォルダ内の既存ファイル名を取得
function getExistingFileNames(folderPath) {
  try {
    return fs.readdirSync(folderPath).filter(f => !f.startsWith('.'));
  } catch (e) {
    return [];
  }
}

// まとめセッションのハンドラー（AI判定版・チャットベース）
async function handleCollectSession(message, currentFolder) {
  console.log(`[Collect] Step: ${collectSession.step}, Message: "${message}"`);

  // AIで意図を判定
  const intent = await analyzeCollectIntent(message, collectSession.step, collectSession.folderName, collectSession.targetPath);
  console.log(`[Collect] Intent:`, intent);

  // キャンセル
  if (intent.action === 'cancel') {
    collectSession = { active: false, step: null, files: [], folderName: null, targetPath: null };
    return { action: 'chat', response: 'まとめをキャンセルしました。' };
  }

  // フォルダ名を決める段階
  if (collectSession.step === 'naming') {
    if (intent.action === 'set_name' && intent.folderName) {
      collectSession.folderName = intent.folderName;

      // 既存フォルダを検索
      const existingFolders = findExistingFolder(intent.folderName);
      if (existingFolders.length > 0) {
        const found = existingFolders[0];
        collectSession.existingFolderPath = found.path;
        collectSession.step = 'existing_folder';

        const existingFiles = getExistingFileNames(found.path);
        const msg = existingFiles.length > 0
          ? `「${found.name}」フォルダが既にあります（${existingFiles.length}件入ってます）。ここに追加しますか？`
          : `「${found.name}」フォルダが既にあります。ここに移動しますか？`;

        return { action: 'chat', response: msg };
      }

      collectSession.step = 'location';

      // 保存場所も同時に指定されていれば設定
      if (intent.location) {
        const locationPath = resolveLocation(intent.location, currentFolder);
        if (locationPath) {
          collectSession.targetPath = locationPath;
          collectSession.step = 'confirm';
          return buildConfirmResponse();
        }
      }

      return {
        action: 'chat',
        response: `どこに作成しますか？（デスクトップ / ダウンロード / 書類）`
      };
    }
    return { action: 'chat', response: 'フォルダ名を入力してください。' };
  }

  // 既存フォルダを使うか確認
  if (collectSession.step === 'existing_folder') {
    if (intent.action === 'confirm') {
      // 既存フォルダを使用
      collectSession.targetPath = path.dirname(collectSession.existingFolderPath);
      collectSession.folderName = path.basename(collectSession.existingFolderPath);
      collectSession.step = 'confirm';
      return buildConfirmResponse();
    }
    if (intent.action === 'cancel' || intent.action === 'change') {
      // 新規作成へ
      collectSession.existingFolderPath = null;
      collectSession.step = 'location';
      return {
        action: 'chat',
        response: '新規フォルダをどこに作成しますか？（デスクトップ / ダウンロード / 書類）'
      };
    }
  }

  // 保存場所を決める段階
  if (collectSession.step === 'location') {
    if (intent.action === 'set_location' && intent.location) {
      const locationPath = resolveLocation(intent.location, currentFolder);
      if (locationPath) {
        collectSession.targetPath = locationPath;
        collectSession.step = 'confirm';
        return buildConfirmResponse();
      }
    }
    return {
      action: 'chat',
      response: '保存場所を選んでください（デスクトップ / ダウンロード / 書類）'
    };
  }

  // 確認段階
  if (collectSession.step === 'confirm') {
    if (intent.action === 'confirm') {
      // 実行
      const result = await executeCollect(
        collectSession.targetPath,
        collectSession.folderName,
        collectSession.files
      );

      collectSession = { active: false, step: null, files: [], folderName: null, targetPath: null };

      if (result.success) {
        let msg = `「${result.folderPath}」に${result.movedCount}件のファイルを移動しました。`;
        if (result.skippedCount > 0) {
          msg += `（重複${result.skippedCount}件はスキップ）`;
        }
        return {
          action: 'chat',
          response: msg
        };
      } else {
        return { action: 'error', response: result.error };
      }
    }

    // 名前変更
    if (intent.action === 'change_name') {
      if (intent.folderName) {
        collectSession.folderName = intent.folderName;
        return buildConfirmResponse();
      } else {
        collectSession.step = 'naming';
        return { action: 'chat', response: '新しいフォルダ名は？' };
      }
    }

    // 場所変更
    if (intent.action === 'change_location') {
      if (intent.location) {
        const locationPath = resolveLocation(intent.location, currentFolder);
        if (locationPath) {
          collectSession.targetPath = locationPath;
          return buildConfirmResponse();
        }
      }
      collectSession.step = 'location';
      return {
        action: 'chat',
        response: '保存場所は？（デスクトップ / ダウンロード / 書類）'
      };
    }
  }

  return { action: 'chat', response: 'すみません、もう一度お願いします。' };
}

// 確認メッセージを生成
function buildConfirmResponse() {
  const locationName = path.basename(collectSession.targetPath);

  return {
    action: 'collect_confirm',
    response: `${locationName}に「${collectSession.folderName}」を作成して${collectSession.files.length}件を移動します。いいですか？`,
    folderName: collectSession.folderName,
    files: collectSession.files,
    targetPath: collectSession.targetPath
  };
}

// 場所を解決
function resolveLocation(location, currentFolder) {
  // 直接マッチ
  if (SAVE_LOCATIONS[location]) {
    return SAVE_LOCATIONS[location];
  }

  // 部分マッチ
  const lower = location.toLowerCase();
  if (lower.includes('デスクトップ') || lower.includes('desktop')) {
    return SAVE_LOCATIONS['デスクトップ'];
  }
  if (lower.includes('ダウンロード') || lower.includes('download')) {
    return SAVE_LOCATIONS['ダウンロード'];
  }
  if (lower.includes('書類') || lower.includes('document')) {
    return SAVE_LOCATIONS['書類'];
  }
  if (lower.includes('現在') || lower.includes('ここ') || lower.includes('今の')) {
    return currentFolder;
  }

  return null;
}

// まとめセッション用の意図分析（拡張版）
async function analyzeCollectIntent(message, currentStep, currentFolderName, currentTargetPath) {
  let stepContext = '';
  if (currentStep === 'naming') {
    stepContext = 'フォルダ名を聞いている';
  } else if (currentStep === 'existing_folder') {
    stepContext = `「${currentFolderName}」という既存フォルダを使うか確認中`;
  } else if (currentStep === 'location') {
    stepContext = `「${currentFolderName}」の保存場所を聞いている`;
  } else if (currentStep === 'confirm') {
    stepContext = `「${currentFolderName}」を「${path.basename(currentTargetPath || '')}」に作成する確認中`;
  }

  const prompt = `ユーザーのメッセージから意図を判定してください。

現在の状態: ${stepContext}

ユーザー: 「${message}」

以下のJSON形式で返してください:
{
  "action": "set_name" | "set_location" | "confirm" | "change_name" | "change_location" | "change" | "cancel",
  "folderName": "フォルダ名（あれば）",
  "location": "保存場所（あれば：デスクトップ、ダウンロード、書類、現在のフォルダ など）"
}

判断基準:
- 「〜って名前で」「〜にして」→ action: "set_name", folderNameに名前
- 「デスクトップに」「ダウンロードに入れて」「書類フォルダに」→ action: "set_location", locationに場所
- 「〜をデスクトップに」のように名前と場所両方 → action: "set_name", folderNameとlocation両方
- 承認・肯定の意図（「いいよ」「OK」「はい」「お願い」「実行」「それで」「大丈夫」「うん」「ええよ」「頼む」「やって」「進めて」「ゴー」等）→ action: "confirm"
- 「名前変えて」「別の名前」→ action: "change_name"
- 「場所変えて」「違う場所」「別のところ」→ action: "change_location"
- 「違う」「新しく作る」「別のフォルダ」「そこじゃない」→ action: "change"（既存フォルダを使わない）
- 「やめる」「キャンセル」「中止」「やっぱり」→ action: "cancel"
- フォルダ名っぽい単語だけ → action: "set_name", folderNameにその名前
- 場所っぽい単語だけ（namingステップ以外） → action: "set_location", locationにその場所

重要: 確認ステップでは、ユーザーが肯定・承認・同意の意図を示していれば action: "confirm" とする。厳密なキーワード一致ではなく、意図を汲み取ること。

JSONのみ返してください。`;

  try {
    const data = await callGeminiWithRetry({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 256 }
    });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      console.log(`[Collect] AI response: ${text}`);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    }
  } catch (e) {
    console.log(`[Collect] Intent analysis error: ${e.message}`);
  }

  // フォールバック
  const lower = message.toLowerCase();
  if (['キャンセル', 'やめる', '中止'].some(w => lower.includes(w))) {
    return { action: 'cancel' };
  }
  if (['いいよ', 'ok', 'はい', 'お願い', '大丈夫', 'それで'].some(w => lower.includes(w))) {
    return { action: 'confirm' };
  }
  if (['デスクトップ', 'ダウンロード', '書類', '現在', 'ここ'].some(w => lower.includes(w))) {
    return { action: 'set_location', location: message.trim() };
  }
  return { action: 'set_name', folderName: message.trim() };
}

// まとめを実行（重複スキップ対応）
async function executeCollect(basePath, folderName, files) {
  try {
    const newFolderPath = path.join(basePath, folderName);

    // フォルダ作成
    if (!fs.existsSync(newFolderPath)) {
      fs.mkdirSync(newFolderPath, { recursive: true });
    }

    // 既存ファイル名を取得
    const existingFiles = new Set(getExistingFileNames(newFolderPath).map(f => f.toLowerCase()));

    let movedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      try {
        const fileName = path.basename(file.path);
        const destPath = path.join(newFolderPath, fileName);

        // 重複チェック
        if (existingFiles.has(fileName.toLowerCase())) {
          console.log(`[Collect] Skipped (duplicate): ${fileName}`);
          skippedCount++;
          continue;
        }

        if (fs.existsSync(file.path)) {
          fs.renameSync(file.path, destPath);
          movedCount++;
        }
      } catch (e) {
        console.log(`[Collect] Failed to move ${file.name}: ${e.message}`);
      }
    }

    // キャッシュクリア
    fileCache = null;

    return {
      success: true,
      folderPath: newFolderPath,
      movedCount,
      skippedCount
    };
  } catch (e) {
    console.log(`[Collect] Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// 整理セッションのハンドラー（AI判定版）
async function handleOrganizeSession(message, currentFolder) {
  console.log(`[Organize] Step: ${organizeSession.step}, Message: "${message}"`);

  // AIで意図を判定
  const intent = await analyzeOrganizeIntent(message, organizeSession.step);
  console.log(`[Organize] Intent:`, intent);

  // キャンセル
  if (intent.action === 'cancel') {
    organizeSession = { active: false, step: null, folderPath: null, preferences: null, suggestions: null, files: null };
    return { action: 'chat', response: 'フォルダ整理をキャンセルしました。' };
  }

  // ステップ1: ヒアリング中 - ユーザーの希望を受け取る
  if (organizeSession.step === 'hearing') {
    console.log(`[Organize] Received preferences: ${message}`);
    organizeSession.preferences = message;
    organizeSession.step = 'suggesting';

    // ユーザーの希望を元に整理提案を生成
    const result = await suggestOrganizationWithPreferences(
      organizeSession.folderPath,
      organizeSession.preferences
    );

    if (!result.success) {
      organizeSession = { active: false, step: null, folderPath: null, preferences: null, suggestions: null, files: null };
      return { action: 'error', response: result.error };
    }

    organizeSession.suggestions = result.suggestions;
    organizeSession.files = result.files;
    organizeSession.step = 'confirm';

    return {
      action: 'organize_confirm',
      response: result.summary || '以下の整理を提案します。',
      suggestions: result.suggestions,
      files: result.files,
      folderPath: organizeSession.folderPath
    };
  }

  // ステップ2: 確認中 - ユーザーの承認を待つ
  if (organizeSession.step === 'confirm') {
    if (intent.action === 'confirm') {
      console.log(`[Organize] User confirmed, executing...`);
      organizeSession.step = 'executing';

      return {
        action: 'organize_execute',
        response: '了解しました！整理を実行します。',
        suggestions: organizeSession.suggestions,
        files: organizeSession.files,
        folderPath: organizeSession.folderPath
      };
    }

    if (intent.action === 'change') {
      organizeSession.step = 'hearing';
      return {
        action: 'organize_hearing',
        response: 'わかりました。どのように整理したいですか？\n\n例：\n• 種類ごとにフォルダ分け\n• 日付順に整理\n• プロジェクトごとにまとめる'
      };
    }

    // その他の応答は追加の要望として処理
    organizeSession.preferences = message;
    const result = await suggestOrganizationWithPreferences(
      organizeSession.folderPath,
      message
    );

    if (!result.success) {
      return { action: 'error', response: result.error };
    }

    organizeSession.suggestions = result.suggestions;
    organizeSession.files = result.files;

    return {
      action: 'organize_confirm',
      response: result.summary || '以下の整理を提案します。',
      suggestions: result.suggestions,
      files: result.files,
      folderPath: organizeSession.folderPath
    };
  }

  // 整理完了後
  if (organizeSession.step === 'executing') {
    organizeSession = { active: false, step: null, folderPath: null, preferences: null, suggestions: null, files: null };
    return { action: 'chat', response: message };
  }

  return { action: 'chat', response: 'すみません、もう一度お願いします。' };
}

// 整理セッション用の意図分析
async function analyzeOrganizeIntent(message, currentStep) {
  const prompt = `ユーザーのメッセージから意図を判定してください。

現在の状態: ${currentStep === 'hearing' ? '整理方法を聞いている' : '整理提案の確認中'}

ユーザー: 「${message}」

以下のJSON形式で返してください:
{
  "action": "confirm" | "change" | "cancel" | "preference"
}

判断基準:
- 「いいよ」「OK」「はい」「お願い」「実行して」「それで」「大丈夫」→ action: "confirm"
- 「違う」「変えて」「やり直し」「別の方法」→ action: "change"
- 「やめる」「キャンセル」「中止」→ action: "cancel"
- 整理方法の指定や追加の要望 → action: "preference"

JSONのみ返してください。`;

  try {
    const data = await callGeminiWithRetry({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 128 }
    });

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    }
  } catch (e) {
    console.log(`[Organize] Intent analysis error: ${e.message}`);
  }

  // フォールバック
  const lower = message.toLowerCase();
  if (['キャンセル', 'やめる', '中止'].some(w => lower.includes(w))) {
    return { action: 'cancel' };
  }
  if (['いいよ', 'ok', 'はい', 'お願い', '大丈夫'].some(w => lower.includes(w))) {
    return { action: 'confirm' };
  }
  if (['違う', '変えて', 'やり直'].some(w => lower.includes(w))) {
    return { action: 'change' };
  }
  return { action: 'preference' };
}

// ユーザーの希望を考慮した整理提案
async function suggestOrganizationWithPreferences(folderPath, preferences) {
  console.log(`[Organize] Analyzing folder: ${folderPath} with preferences: ${preferences}`);

  try {
    const allFiles = [];

    if (!fs.existsSync(folderPath)) {
      return { success: false, error: 'フォルダが存在しません' };
    }

    const items = fs.readdirSync(folderPath);
    for (const item of items) {
      if (item.startsWith('.')) continue;

      const fullPath = path.join(folderPath, item);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          if (SKIP_DIRS.includes(item)) continue;
          allFiles.push({
            name: item,
            path: fullPath,
            isFolder: true,
            type: 'folder'
          });
        } else {
          allFiles.push({
            name: item,
            path: fullPath,
            ext: path.extname(item).slice(1).toLowerCase(),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            isFolder: false,
            type: 'file'
          });
        }
      } catch (e) {}
    }

    if (allFiles.length === 0) {
      return { success: false, error: 'フォルダが空です' };
    }

    const fileListText = allFiles.map((f, i) => {
      if (f.isFolder) {
        return `${i}: [フォルダ] ${f.name}`;
      }
      return `${i}: [${f.ext?.toUpperCase() || 'FILE'}] ${f.name}`;
    }).join('\n');

    const prompt = `あなたはファイル整理のエキスパートです。

ユーザーの希望: 「${preferences}」

以下のフォルダ内のファイルを分析し、ユーザーの希望に沿った整理の提案をしてください。

フォルダパス: ${folderPath}

ファイル一覧:
${fileListText}

以下のJSON形式で整理提案を返してください:
{
  "summary": "ユーザーの希望を反映した整理の概要説明（1-2文）",
  "suggestions": [
    {
      "action": "move" または "rename" または "delete" または "create_folder",
      "target": "対象のファイル名またはインデックス番号",
      "destination": "移動先フォルダ名（moveの場合）または新しい名前（renameの場合）",
      "reason": "この操作を提案する理由"
    }
  ]
}

ルール:
- ユーザーの希望を最優先で反映する
- 具体的で実行可能な提案にする
- 最大10件の提案に絞る
- 必ず有効なJSONのみを返す`;

    const data = await callGeminiWithRetry({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 2048
      }
    });

    if (data.error) {
      console.log(`[Organize] API Error: ${data.error.message}`);
      return { success: false, error: data.error.message };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { success: false, error: 'AIからの応答がありませんでした' };
    }

    console.log(`[Organize] AI response: ${text}`);

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, error: 'JSONの解析に失敗しました' };
    }

    const suggestions = JSON.parse(jsonMatch[0]);

    return {
      success: true,
      folderPath,
      files: allFiles,
      ...suggestions
    };

  } catch (e) {
    console.log(`[Organize] Error: ${e.message}`);
    return { success: false, error: e.message };
  }
}

// ============================================
// AI チャット処理（自然言語で何でも対応 + 実際に検索実行）
// ============================================
async function processChat(message, currentFolder) {
  console.log(`[Chat] Processing: "${message}" in ${currentFolder || 'none'}`);

  try {
    // まとめセッション中の場合
    if (collectSession.active) {
      return await handleCollectSession(message, currentFolder);
    }

    // 整理セッション中の場合
    if (organizeSession.active) {
      return await handleOrganizeSession(message, currentFolder);
    }

    // 実際のファイル統計を取得
    const stats = getFileStats();

    // 現在のフォルダの情報を取得
    let folderContext = '';
    if (currentFolder && fs.existsSync(currentFolder)) {
      const items = fs.readdirSync(currentFolder).filter(f => !f.startsWith('.'));
      const folderName = path.basename(currentFolder);
      folderContext = `現在選択中のフォルダ: ${folderName} (${items.length}個のアイテム)`;
    }

    // 拡張子別の統計を見やすく整形
    const extList = Object.entries(stats.byExtension)
      .sort((a, b) => b[1] - a[1])
      .map(([ext, count]) => `${ext.toUpperCase()}=${count}件`)
      .join(', ');

    console.log(`[Chat] Stats: total=${stats.total}, extensions=${extList}`);

    // 直近の検索結果があるか
    const hasRecentSearch = lastSearchResults.length > 0;
    const recentSearchInfo = hasRecentSearch
      ? `\n直近の検索結果: ${lastSearchResults.length}件のファイル`
      : '';

    const prompt = `ファイル管理AI。ユーザーの意図を正確に判定せよ。

【状態】
- 総ファイル: ${stats.total}件
- ${folderContext || '選択フォルダなし'}
- ${hasRecentSearch ? `直近検索結果: ${lastSearchResults.length}件あり` : '直近検索結果: なし'}

【ユーザー入力】
「${message}」

【アクション判定ルール】※優先度順

1. search（検索）
   キーワード: 探して、見つけて、どこ、検索、〜関係、〜についてのファイル、〜の資料
   → ファイルやフォルダを名前・内容で探す
   例: 「請求書探して」「アドネス関係」「契約書どこ」

2. list_files（ファイル数確認）
   キーワード: 何件、いくつある、数えて、〜ファイル一覧
   → 特定の拡張子のファイル数を確認
   例: 「PDF何件？」「Excelある？」

3. organize（フォルダ整理）
   キーワード: 整理して、片付けて、並び替えて、フォルダ分けして
   → 現在選択中のフォルダ内を整理・再配置
   例: 「このフォルダ整理して」「片付けて」

4. collect（検索結果をまとめる）※直近検索結果がある場合のみ
   キーワード: まとめて、一箇所に、フォルダに入れて、集めて
   → 直前の検索結果を新フォルダにまとめる
   例: 「これまとめて」「一つのフォルダに」

5. chat（その他）
   上記に該当しない会話

【重要】
- 「〜探して」「〜どこ」は必ずsearch
- 「整理」「片付け」は必ずorganize
- 「まとめて」は検索結果がある場合のみcollect、なければchat

【出力形式】JSONのみ
{
  "action": "search" | "list_files" | "organize" | "collect" | "chat",
  "response": "ユーザーへの返答",
  "searchQuery": "検索キーワード（searchの場合）",
  "fileType": "拡張子（list_filesの場合）"
}`;

    const data = await callGeminiWithRetry({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512
      }
    });

    if (data.error) {
      console.log(`[Chat] API Error: ${data.error.message}`);
      return { action: 'error', response: data.error.message };
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return { action: 'error', response: 'AIからの応答がありませんでした' };
    }

    console.log(`[Chat] AI response: ${text}`);

    // JSONを抽出
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { action: 'chat', response: text };
    }

    const result = JSON.parse(jsonMatch[0]);
    result.stats = stats;

    // アクションに応じて実際のファイルを取得
    if (result.action === 'list_files' && result.fileType) {
      console.log(`[Chat] Listing files with type: ${result.fileType}`);
      const ext = result.fileType.toLowerCase().replace('.', '');
      const matchingFiles = stats.files.filter(f => f.ext.toLowerCase() === ext);

      // 最新50件を返す（メインエリア用）
      result.files = matchingFiles.slice(0, 50).map(f => ({
        name: f.name,
        path: f.path,
        ext: f.ext,
        size: f.size,
        mtime: f.mtime
      }));
      result.totalCount = matchingFiles.length;
      console.log(`[Chat] Found ${matchingFiles.length} ${ext} files`);
    }

    // 検索アクションの場合、実際に検索を実行
    if (result.action === 'search' && result.searchQuery) {
      console.log(`[Chat] Executing search: ${result.searchQuery}`);
      const searchResult = await searchFiles(result.searchQuery);
      result.searchResults = searchResult.results || [];
      // 検索結果を保存（まとめ機能用）
      lastSearchResults = result.searchResults;
      console.log(`[Chat] Search found ${result.searchResults.length} files`);
    }

    // 整理アクションの場合、ヒアリングを開始
    if (result.action === 'organize') {
      if (!currentFolder) {
        return {
          action: 'chat',
          response: '整理するフォルダを左のサイドバーから選択してください。'
        };
      }

      // ヒアリングセッションを開始
      organizeSession = {
        active: true,
        step: 'hearing',
        folderPath: currentFolder,
        preferences: null,
        suggestions: null,
        files: null
      };

      return {
        action: 'organize_hearing',
        response: 'フォルダを整理しますね！どのように整理したいですか？\n\n例：\n• 種類ごとにフォルダ分け\n• 日付順に整理\n• プロジェクトごとにまとめる\n• 古いファイルを別フォルダに移動'
      };
    }

    // まとめアクションの場合
    if (result.action === 'collect') {
      if (lastSearchResults.length === 0) {
        return {
          action: 'chat',
          response: 'まとめるファイルがありません。先に検索を実行してください。'
        };
      }

      // まとめセッションを開始
      const targetPath = currentFolder || path.join(os.homedir(), 'Desktop');
      collectSession = {
        active: true,
        step: 'naming',
        files: [...lastSearchResults],
        folderName: null,
        targetPath: targetPath
      };

      return {
        action: 'collect_naming',
        response: `${lastSearchResults.length}件のファイルをまとめます。フォルダ名を入力してください。`,
        files: lastSearchResults,
        targetPath: targetPath
      };
    }

    return result;

  } catch (e) {
    console.log(`[Chat] Error: ${e.message}`);
    return { action: 'error', response: e.message };
  }
}

module.exports = {
  init,
  expandFolder,
  getFolderContents,
  getRecentFiles,
  searchFiles,
  suggestOrganization,
  executeOrganization,
  startWatching,
  stopWatching,
  watchFolder,
  processChat
};
