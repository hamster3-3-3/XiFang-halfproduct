const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const JSON_ROOT = path.join(ROOT, 'data-json');
const CHECK = process.argv.includes('--check');
const SCHEMA_VERSION = 1;

const slash = p => p.split(path.sep).join('/');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(value));
};

function loadWebsiteParsers() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const blocks = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  if (!blocks.some(s => s.includes('function parseSummaryFromWB'))) throw new Error('index.html 找不到網站解析函式');
  const source = blocks.join('\n');

  const cleaned = source.replace(/^\s*init\(\);?\s*$/gm, '');
  const stub = new Proxy(function(){}, {
    get: (_t, key) => key === 'style' ? {} : stub,
    apply: () => stub
  });
  const document = {
    addEventListener() {},
    getElementById() { return stub; },
    querySelector() { return stub; },
    querySelectorAll() { return []; },
    createElement() { return stub; },
    head: stub,
    body: stub
  };
  const sandbox = {
    XLSX, console, document, window: {}, navigator: {}, location: {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, DOMException, URL, Blob, Map, Set, Date, Math,
    fetch: async () => { throw new Error('converter 不執行網路請求'); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(cleaned, sandbox, {filename: 'index.html', timeout: 15000});
  vm.runInContext(`globalThis.__parsers = {
    parseSummaryFromWB, parseDetailsFromWB, parseHalfDetailsFromWB,
    parseReasonFromWB, parseTop20FromWB, isWasteFile, isJfmFile
  }`, sandbox);
  return {parsers: sandbox.__parsers, parserHash: hash(`${SCHEMA_VERSION}\n${cleaned}`)};
}

function scanExcel(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.name.startsWith('~$')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scanExcel(full, base);
    return /\.xlsx$/i.test(entry.name) ? [slash(path.relative(base, full))] : [];
  }).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

function scanGeneratedJson(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return scanGeneratedJson(full, base);
    return /\.json$/i.test(entry.name) ? [slash(path.relative(base, full))] : [];
  });
}

function validatePayload(payload, rel, parsers) {
  const expected = parsers.isWasteFile(rel)
    ? ['summary', 'details', 'halfDetails']
    : ['reasonWeeks', 'top20Entries'];
  for (const key of expected) {
    if (!Array.isArray(payload[key])) throw new Error(`${rel}: JSON 缺少 ${key}`);
  }
}

function main() {
  const {parsers, parserHash} = loadWebsiteParsers();
  const allExcel = scanExcel(DATA);
  const files = allExcel.filter(f => parsers.isWasteFile(f) || parsers.isJfmFile(f));
  const ignored = allExcel.filter(f => !files.includes(f));
  if (ignored.length) console.warn(`忽略 ${ignored.length} 份不屬於儀表板的 Excel`);

  const oldManifest = readJson(path.join(DATA, 'json-manifest.json')) || {};
  const entries = {};
  let converted = 0;
  let reused = 0;

  for (const rel of files) {
    const sourceFile = path.join(DATA, ...rel.split('/'));
    const sourceSha256 = hash(fs.readFileSync(sourceFile));
    const jsonRel = slash(path.join('data-json', rel.replace(/\.xlsx$/i, '.json')));
    const jsonFile = path.join(ROOT, ...jsonRel.split('/'));
    const old = oldManifest.files && oldManifest.files[rel];

    if (old && old.sourceSha256 === sourceSha256 && old.parserHash === parserHash && old.json === jsonRel && fs.existsSync(jsonFile)) {
      const payload = readJson(jsonFile);
      validatePayload(payload, rel, parsers);
      entries[rel] = {...old, jsonBytes: fs.statSync(jsonFile).size};
      reused++;
      continue;
    }
    if (CHECK) throw new Error(`${rel}: JSON 尚未更新，請執行 npm run convert:data`);

    const workbook = XLSX.read(fs.readFileSync(sourceFile), {type: 'buffer', cellDates: true});
    let payload;
    if (parsers.isWasteFile(rel)) {
      payload = {
        summary: parsers.parseSummaryFromWB(workbook, rel),
        details: parsers.parseDetailsFromWB(workbook, rel),
        halfDetails: parsers.parseHalfDetailsFromWB(workbook, rel)
      };
    } else {
      payload = {
        reasonWeeks: parsers.parseReasonFromWB(workbook, rel),
        top20Entries: parsers.parseTop20FromWB(workbook, rel)
      };
    }
    payload.schemaVersion = SCHEMA_VERSION;
    payload.source = rel;
    payload.sourceSha256 = sourceSha256;
    payload.parserHash = parserHash;
    validatePayload(payload, rel, parsers);
    writeJson(jsonFile, payload);
    entries[rel] = {json: jsonRel, sourceSha256, parserHash, jsonBytes: fs.statSync(jsonFile).size};
    converted++;
    console.log(`轉換 ${rel}`);
  }

  const stale = oldManifest.files ? Object.keys(oldManifest.files).filter(f => !entries[f]) : [];
  if (CHECK && stale.length) throw new Error(`manifest 含 ${stale.length} 份已不存在的 Excel`);
  const expectedJson = new Set(Object.values(entries).map(entry => entry.json.replace(/^data-json\//, '')));
  const orphanJson = scanGeneratedJson(JSON_ROOT).filter(rel => !expectedJson.has(rel));
  if (CHECK && orphanJson.length) throw new Error(`data-json 含 ${orphanJson.length} 份無來源的舊 JSON`);

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    parserHash,
    generatedAt: CHECK ? oldManifest.generatedAt : new Date().toISOString(),
    files: entries
  };
  const fileList = {files};

  if (CHECK) {
    const currentFiles = readJson(path.join(DATA, 'manifest.json'));
    if (JSON.stringify(currentFiles) !== JSON.stringify(fileList)) throw new Error('data/manifest.json 與資料夾內容不同步');
    if (JSON.stringify(oldManifest.files || {}) !== JSON.stringify(entries)) throw new Error('data/json-manifest.json 與 JSON 檔不同步');
  } else {
    writeJson(path.join(DATA, 'manifest.json'), fileList);
    writeJson(path.join(DATA, 'json-manifest.json'), manifest);
    for (const rel of stale) {
      const oldJson = oldManifest.files[rel] && oldManifest.files[rel].json;
      if (oldJson && oldJson.startsWith('data-json/')) {
        const target = path.join(ROOT, ...oldJson.split('/'));
        if (fs.existsSync(target)) fs.unlinkSync(target);
      }
    }
    for (const rel of orphanJson) fs.unlinkSync(path.join(JSON_ROOT, ...rel.split('/')));
  }
  console.log(`${CHECK ? '檢查完成' : '轉換完成'}：${files.length} 份（新轉 ${converted}、沿用 ${reused}）`);
}

try { main(); } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
