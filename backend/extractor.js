/**
 * extractor.js
 * Calls extract.py (UnityPy) to do the actual Unity asset extraction.
 * UnityPy natively handles APKs — no apktool or AssetRipper needed.
 */

const { exec } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const { promisify } = require('util');

const execAsync = promisify(exec);

const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const EXTRACT_PY = path.join(__dirname, 'extract.py');

async function run(jobId, apkPath, jobDir, updateJob) {
  const assetsDir    = path.join(jobDir, 'assets');
  const manifestPath = path.join(jobDir, 'manifest.json');

  fs.mkdirSync(assetsDir, { recursive: true });

  try {
    updateJob(jobId, { status: 'running', step: 'upload', stepDetail: 'File received', progress: 10 });

    updateJob(jobId, { step: 'decompile', stepDetail: 'Parsing APK structure...', progress: 20 });

    updateJob(jobId, { step: 'find', stepDetail: 'Locating Unity asset bundles...', progress: 40 });

    updateJob(jobId, { step: 'extract', stepDetail: 'Extracting assets with UnityPy...', progress: 55 });

    const cmd = `"${PYTHON_BIN}" "${EXTRACT_PY}" "${apkPath}" "${assetsDir}" "${manifestPath}"`;
    console.log(`[${jobId}] Running: ${cmd}`);

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stdout) console.log(`[${jobId}] py:`, stdout.slice(0, 500));
      if (stderr) console.warn(`[${jobId}] py err:`, stderr.slice(0, 500));
    } catch (execErr) {
      console.warn(`[${jobId}] Python exited non-zero:`, execErr.message);
    }

    updateJob(jobId, { step: 'index', stepDetail: 'Reading asset catalog...', progress: 88 });

    if (!fs.existsSync(manifestPath)) {
      throw new Error('No manifest produced. The APK may not be a Unity game, or UnityPy failed.');
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!manifest.ok) throw new Error(manifest.error || 'UnityPy extraction failed');

    const { assets, stats } = manifest;

    updateJob(jobId, {
      step: 'done', stepDetail: 'Extraction complete!',
      progress: 100, status: 'done', assets, stats,
    });

    console.log(`[${jobId}] Done — ${assets.length} assets`);

  } catch (err) {
    console.error(`[${jobId}] Fatal:`, err);
    updateJob(jobId, { status: 'error', error: err.message });
    throw err;
  }
}

module.exports = { run };
