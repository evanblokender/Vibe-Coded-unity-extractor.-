/**
 * extractor.js
 * 
 * Orchestrates the full APK → Unity asset extraction pipeline:
 *   1. Unzip APK (APKs are just ZIP files)
 *   2. Find Unity asset bundles (assets/bin/Data/)
 *   3. Run AssetStudio CLI (if available) or parse raw .assets files
 *   4. Catalog all extracted assets
 * 
 * TOOL REQUIREMENTS (must be installed on the Render instance via build script):
 *   - Java 11+           (for apktool)
 *   - apktool.jar        (APK decompiler)
 *   - AssetStudio CLI    (Unity asset extractor) — see build.sh
 * 
 * If tools aren't available, the extractor falls back to raw ZIP parsing
 * and produces a best-effort asset list from the APK structure.
 */

const { execFile, exec } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { promisify } = require('util');

const execAsync = promisify(exec);

// ─── TOOL PATHS ───────────────────────────────────────────────────────────────
// These are set up by build.sh and placed in /opt/unityrip/
const APKTOOL_JAR        = process.env.APKTOOL_PATH        || '/opt/unityrip/apktool.jar';
const ASSETSTUDIO_CLI    = process.env.ASSETSTUDIO_PATH    || '/opt/unityrip/AssetStudioCLI';
const JAVA_BIN           = process.env.JAVA_BIN            || 'java';

// ─── MIME MAP ─────────────────────────────────────────────────────────────────
const EXT_TYPE_MAP = {
  png: 'texture',  jpg: 'texture', jpeg: 'texture', tga: 'texture', webp: 'texture',
  wav: 'audio',    mp3: 'audio',   ogg: 'audio',    aiff: 'audio',
  fbx: 'mesh',     obj: 'mesh',    dae: 'mesh',
  unity: 'scene',
  cs:  'script',   dll: 'script',
  mat: 'material',
  anim: 'anim',    controller: 'anim',
  prefab: 'prefab',
  asset: 'asset',
  shader: 'shader',
  ttf: 'font',     otf: 'font',
  txt: 'text',     json: 'text',   xml: 'text',
};

const TYPE_EMOJI = {
  texture: '🖼', audio: '🔊', mesh: '🧊', scene: '🌐',
  script: '📜', material: '🎨', anim: '🎬', prefab: '🧩',
  shader: '✨', font: '🔤', asset: '📦', text: '📄', unknown: '❓'
};

// ─── MAIN RUN FUNCTION ────────────────────────────────────────────────────────
async function run(jobId, apkPath, jobDir, updateJob) {
  const assetsOut = path.join(jobDir, 'assets');
  const apktoolOut = path.join(jobDir, 'decompiled');
  fs.mkdirSync(assetsOut, { recursive: true });

  try {
    // ── STEP 1: Upload complete (already done when we get here) ──
    updateJob(jobId, { step: 'upload', stepDetail: 'File received', progress: 10, status: 'running' });
    await sleep(500);

    // ── STEP 2: Decompile APK with apktool ───────────────────────────────────
    updateJob(jobId, { step: 'decompile', stepDetail: 'Running apktool...', progress: 20 });

    const hasApktool = await toolExists(`${JAVA_BIN} -jar ${APKTOOL_JAR} --version`);

    if (hasApktool) {
      await runApktool(apkPath, apktoolOut);
    } else {
      // Fallback: APK is just a ZIP, unzip it directly
      console.log(`[${jobId}] apktool not found, using ZIP fallback`);
      await unzipApk(apkPath, apktoolOut);
    }

    updateJob(jobId, { stepDetail: 'Decompilation complete', progress: 35 });

    // ── STEP 3: Locate Unity bundles ──────────────────────────────────────────
    updateJob(jobId, { step: 'find', stepDetail: 'Scanning for Unity bundles...', progress: 40 });

    const unityDataDir = findUnityDataDir(apktoolOut);
    const bundleFiles  = unityDataDir ? findBundleFiles(unityDataDir) : [];

    console.log(`[${jobId}] Unity data dir: ${unityDataDir}`);
    console.log(`[${jobId}] Found ${bundleFiles.length} bundle files`);

    updateJob(jobId, {
      stepDetail: `Found ${bundleFiles.length} Unity bundle(s)`,
      progress: 55,
      unityDataDir,
      bundleCount: bundleFiles.length,
    });

    // ── STEP 4: Extract assets ────────────────────────────────────────────────
    updateJob(jobId, { step: 'extract', stepDetail: 'Extracting assets...', progress: 60 });

    let extractedFiles = [];

    const hasAssetStudio = await toolExists(`${ASSETSTUDIO_CLI} --version`);

    if (hasAssetStudio && bundleFiles.length > 0) {
      // Premium path: AssetStudio CLI for proper Unity asset extraction
      extractedFiles = await runAssetStudio(bundleFiles, assetsOut, jobId);
    } else if (bundleFiles.length > 0) {
      // Intermediate path: raw scan of Unity data dir
      extractedFiles = await rawExtract(bundleFiles, assetsOut, jobId);
    } else {
      // Fallback path: catalog everything interesting in the APK
      extractedFiles = await catalogApkAssets(apktoolOut, assetsOut, jobId);
    }

    updateJob(jobId, { stepDetail: `Extracted ${extractedFiles.length} files`, progress: 80 });

    // ── STEP 5: Build asset catalog ───────────────────────────────────────────
    updateJob(jobId, { step: 'index', stepDetail: 'Building asset catalog...', progress: 88 });

    const assets = buildCatalog(extractedFiles, assetsOut, bundleFiles);
    const stats  = buildStats(assets);

    updateJob(jobId, {
      step: 'done',
      stepDetail: 'Extraction complete!',
      progress: 100,
      status: 'done',
      assets,
      stats,
    });

    console.log(`[${jobId}] Done — ${assets.length} assets cataloged`);

  } catch (err) {
    console.error(`[${jobId}] Extraction error:`, err);
    updateJob(jobId, { status: 'error', error: err.message, progress: 0 });
    throw err;
  }
}

// ─── APKTOOL ──────────────────────────────────────────────────────────────────
async function runApktool(apkPath, outDir) {
  const cmd = `${JAVA_BIN} -jar "${APKTOOL_JAR}" d "${apkPath}" -o "${outDir}" --no-src -f`;
  console.log('Running apktool:', cmd);
  await execAsync(cmd, { timeout: 120_000 });
}

// ─── ZIP FALLBACK ─────────────────────────────────────────────────────────────
async function unzipApk(apkPath, outDir) {
  return new Promise((resolve, reject) => {
    try {
      const zip = new AdmZip(apkPath);
      zip.extractAllTo(outDir, true);
      resolve();
    } catch (e) {
      reject(new Error(`Failed to unzip APK: ${e.message}`));
    }
  });
}

// ─── FIND UNITY DATA DIR ──────────────────────────────────────────────────────
function findUnityDataDir(decompileRoot) {
  // Unity games typically store assets in:
  //   assets/bin/Data/         (older Unity)
  //   assets/                  (with .bundle files)
  //   lib/.../libunity.so      (marker)
  const candidates = [
    path.join(decompileRoot, 'assets', 'bin', 'Data'),
    path.join(decompileRoot, 'assets', 'bin', 'data'),
    path.join(decompileRoot, 'assets'),
    decompileRoot,
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      const files = fs.readdirSync(c).map(f => f.toLowerCase());
      const hasUnityFiles = files.some(f =>
        f.endsWith('.assets') || f.endsWith('.bundle') ||
        f === 'globalgamemanagers' || f === 'sharedassets0.assets'
      );
      if (hasUnityFiles) return c;
    }
  }

  // Fallback: search entire tree for .assets files
  return findDirWithExtension(decompileRoot, '.assets') || null;
}

function findDirWithExtension(root, ext) {
  if (!fs.existsSync(root)) return null;
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        const found = findDirWithExtension(full, ext);
        if (found) return found;
      } else if (entry.name.endsWith(ext)) {
        return root;
      }
    }
  } catch { /* permission error, skip */ }
  return null;
}

// ─── FIND BUNDLE FILES ────────────────────────────────────────────────────────
function findBundleFiles(dir) {
  const results = [];
  const BUNDLE_EXTS = ['.assets', '.bundle', '.resource', '.resS'];
  const BUNDLE_NAMES = ['globalgamemanagers', 'sharedassets', 'level', 'resources'];

  function walk(d, depth = 0) {
    if (depth > 6 || !fs.existsSync(d)) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else {
          const ext  = path.extname(entry.name).toLowerCase();
          const base = path.basename(entry.name, ext).toLowerCase();
          if (BUNDLE_EXTS.includes(ext) || BUNDLE_NAMES.some(n => base.startsWith(n))) {
            results.push(full);
          }
        }
      }
    } catch { /* skip */ }
  }

  walk(dir);
  return results;
}

// ─── ASSETSTUDIO CLI ──────────────────────────────────────────────────────────
async function runAssetStudio(bundleFiles, outDir, jobId) {
  const extracted = [];
  for (const bundle of bundleFiles) {
    try {
      const bundleName = path.basename(bundle, path.extname(bundle));
      const bundleOut  = path.join(outDir, bundleName);
      fs.mkdirSync(bundleOut, { recursive: true });

      // AssetStudio CLI usage:
      //   AssetStudioCLI <input> <output_dir> --types Texture2D,AudioClip,Mesh,...
      const cmd = `"${ASSETSTUDIO_CLI}" "${bundle}" "${bundleOut}" --log-level Error`;
      await execAsync(cmd, { timeout: 60_000 });

      // Collect extracted files
      const files = walkDir(bundleOut);
      for (const f of files) {
        extracted.push({ file: f, bundle: path.relative(outDir, bundleOut) });
      }
    } catch (e) {
      console.warn(`[${jobId}] AssetStudio failed on ${bundle}:`, e.message);
    }
  }
  return extracted;
}

// ─── RAW EXTRACT (no AssetStudio) ────────────────────────────────────────────
// Copies raw bundle files and any known asset types it finds
async function rawExtract(bundleFiles, outDir, jobId) {
  const extracted = [];
  for (const bundle of bundleFiles) {
    const bundleName = path.basename(bundle, path.extname(bundle));
    const bundleOut  = path.join(outDir, bundleName);
    fs.mkdirSync(bundleOut, { recursive: true });

    const dest = path.join(bundleOut, path.basename(bundle));
    fs.copyFileSync(bundle, dest);
    extracted.push({ file: dest, bundle: bundleName, raw: true });
  }
  return extracted;
}

// ─── CATALOG APK ASSETS (full fallback) ───────────────────────────────────────
async function catalogApkAssets(decompileRoot, outDir, jobId) {
  const extracted = [];
  const INTERESTING_EXTS = new Set([
    '.png','.jpg','.jpeg','.tga','.webp',
    '.wav','.mp3','.ogg','.aiff',
    '.fbx','.obj',
    '.json','.xml','.txt',
    '.ttf','.otf',
    '.cs','.shader',
  ]);

  function walk(d, depth = 0) {
    if (depth > 8 || !fs.existsSync(d)) return;
    try {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (INTERESTING_EXTS.has(ext)) {
            const rel  = path.relative(decompileRoot, path.dirname(full));
            const dest = path.join(outDir, rel, entry.name);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(full, dest);
            extracted.push({ file: dest, bundle: rel || 'root' });
          }
        }
      }
    } catch { /* skip */ }
  }

  walk(decompileRoot);
  return extracted;
}

// ─── BUILD CATALOG ────────────────────────────────────────────────────────────
function buildCatalog(extractedFiles, assetsRoot, bundleFiles) {
  return extractedFiles.map((entry, i) => {
    const filePath = entry.file;
    const ext  = path.extname(filePath).replace('.', '').toLowerCase();
    const name = path.basename(filePath, path.extname(filePath));
    const type = EXT_TYPE_MAP[ext] || 'unknown';
    const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
    const size = stat ? stat.size : 0;
    const relativePath = path.relative(assetsRoot, filePath);

    return {
      id: uuidv4(),
      name,
      filename: path.basename(filePath),
      ext,
      type,
      emoji: TYPE_EMOJI[type] || '❓',
      size: formatBytes(size),
      sizeBytes: size,
      bundle: entry.bundle || 'unknown',
      relativePath,
      raw: entry.raw || false,
    };
  });
}

// ─── BUILD STATS ─────────────────────────────────────────────────────────────
function buildStats(assets) {
  const byType = {};
  let totalBytes = 0;
  for (const a of assets) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    totalBytes += a.sizeBytes || 0;
  }
  return {
    total: assets.length,
    byType,
    totalSize: formatBytes(totalBytes),
    bundleCount: [...new Set(assets.map(a => a.bundle))].length,
  };
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
async function toolExists(testCmd) {
  try {
    await execAsync(testCmd, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function walkDir(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...walkDir(full));
      else results.push(full);
    }
  } catch { /* skip */ }
  return results;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { run };
