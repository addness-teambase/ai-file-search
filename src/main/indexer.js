const fs = require('fs');
const path = require('path');
const os = require('os');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const AdmZip = require('adm-zip');

// Gemini API
const GEMINI_API_KEY = 'AIzaSyBacKMXDLnqmB4qbgv5unfltsJioT-T2dg';
const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = 'gemini-2.5-flash';

// スキャン対象
const SCAN_DIRS = [
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads')
];

// サポートする拡張子
const SUPPORTED_EXT = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.txt', '.md', '.csv'];

// 状態
let fileCache = null;

// 除外フォルダ
const SKIP_DIRS = ['node_modules', '__pycache__', '.git', 'Library', 'Applications', '.Trash'];

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
    
    const res = await fetch(
      `${GEMINI_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { 
            temperature: 0.4, 
            maxOutputTokens: 1000
          }
        })
      }
    );
    
    const data = await res.json();
    
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
  
  for (const dir of SCAN_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const dirName = path.basename(dir);
    folderTree[dirName] = {
      name: dirName,
      path: dir,
      children: getSubfolders(dir)
    };
  }
  
  return { folderTree };
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
// 検索
// ============================================
async function searchFiles(query) {
  if (!query?.trim()) {
    return { results: [], error: 'クエリを入力してください' };
  }
  
  const files = scanAll();
  
  if (files.length === 0) {
    return { results: [], error: 'ファイルがありません' };
  }
  
  console.log(`[Search] Query: "${query}"`);
  
  try {
    // AI検索でファイル選定
    const fileListText = files.slice(0, 500).map((f, i) => `${i}: ${f.name}`).join('\n');
    
    const res = await fetch(
      `${GEMINI_URL}/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `ファイル検索。クエリに関連するファイルを選べ。

クエリ: "${query}"

ファイル:
${fileListText}

関連ファイルの番号を最大5個、JSON配列で返せ。例: [0, 3, 12]
関連なければ []
配列のみ返せ。`
            }]
          }],
          generationConfig: { temperature: 0.1 }
        })
      }
    );
    
    const data = await res.json();
    
    if (data.error) {
      console.log(`[Search] API Error, falling back to local`);
      return await localSearch(query, files);
    }
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return await localSearch(query, files);
    }
    
    console.log(`[Search] AI response: ${text}`);
    
    const match = text.match(/\[[\d,\s]*\]/);
    if (!match) {
      return await localSearch(query, files);
    }
    
    const indices = JSON.parse(match[0]);
    if (indices.length === 0) {
      return { results: [] };
    }
    
    // 各ファイルを処理（必ず要約付き）
    const results = [];
    const targetFiles = indices
      .filter(i => i >= 0 && i < files.length)
      .slice(0, 5)
      .map(i => files[i]);
    
    for (const file of targetFiles) {
      const processed = await processFile(file, query);
      results.push(processed);
    }
    
    return { results, mode: 'ai' };
    
  } catch (e) {
    console.log(`[Search] Error: ${e.message}`);
    return await localSearch(query, files);
  }
}

// ローカル検索（フォールバック）
async function localSearch(query, files) {
  console.log(`[LocalSearch] Query: "${query}"`);
  
  const keywords = query.toLowerCase().split(/\s+/);
  
  const matched = files
    .map(f => {
      const name = f.name.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (name.includes(kw)) score += 10;
      }
      return { ...f, score };
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  
  // 各ファイルを処理（必ず要約付き）
  const results = [];
  for (const file of matched) {
    const processed = await processFile(file, query);
    results.push(processed);
  }
  
  return { results, mode: 'local' };
}

module.exports = {
  init,
  expandFolder,
  getFolderContents,
  getRecentFiles,
  searchFiles
};
