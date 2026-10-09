const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const { exportScenes } = require('./exporter');

let ffmpegPath, ffprobePath;
// In packaged app, ffmpeg/ffprobe are in process.resourcesPath (extraResources)
// In dev, use the npm packages directly
if (app.isPackaged) {
  ffmpegPath  = path.join(process.resourcesPath, 'ffmpeg.exe');
  ffprobePath = path.join(process.resourcesPath, 'ffprobe.exe');
} else {
  try { ffmpegPath = require('ffmpeg-static'); ffprobePath = require('ffprobe-static').path; }
  catch(e) { ffmpegPath = 'ffmpeg'; ffprobePath = 'ffprobe'; }
}

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: '#0d0d10',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false
    }
  });
  mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ─── helpers ─────────────────────────────────────────────────────────────────
function runFF(args, onStderr) {
  return new Promise((res, rej) => {
    const p = spawn(ffmpegPath, args);
    let err = '';
    p.stderr.on('data', d => { err += d; if (onStderr) onStderr(d.toString()); });
    p.on('close', c => c === 0 ? res() : rej(new Error(err.slice(-1500))));
    p.on('error', rej);
  });
}

function runFFprobe(args) {
  return new Promise((res, rej) => {
    const p = spawn(ffprobePath, args);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', () => { try { res(JSON.parse(out)); } catch(e) { rej(new Error(err.slice(-500))); } });
    p.on('error', rej);
  });
}

// ─── dialogs ─────────────────────────────────────────────────────────────────
ipcMain.handle('open-file-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Video', extensions: ['mp4','mkv','mov','avi','webm','flv','m4v','wmv','ts','mts','mpg','mpeg','m2t','m2ts','3gp','mxf','ogv','vob','divx','rm','rmvb'] },
      { name: 'All Files', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('open-save-dialog', async (_, name) => {
  const ext = (name.match(/\.([^.]+)$/) || ['','mp4'])[1].toLowerCase();
  const r = await dialog.showSaveDialog(mainWindow, {
    defaultPath: name || 'output.mp4',
    filters: [
      { name: ext.toUpperCase() + ' (original format)', extensions: [ext] },
      { name: 'MKV (universal — recommended)', extensions: ['mkv'] },
      { name: 'MP4', extensions: ['mp4'] },
      { name: 'Other', extensions: ['mov','avi','webm','ts'] }
    ]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('get-video-info', async (_, fp) =>
  runFFprobe(['-v','quiet','-print_format','json','-show_format','-show_streams', fp])
);

ipcMain.handle('get-fps', async (_, fp) => {
  try {
    const info = await runFFprobe(['-v','quiet','-print_format','json','-show_streams','-select_streams','v:0', fp]);
    const st = (info.streams||[])[0];
    if (!st) return 25;
    const rfr = st.r_frame_rate || st.avg_frame_rate || '25/1';
    const [n, d] = rfr.split('/').map(Number);
    return d ? n/d : 25;
  } catch(e) { return 25; }
});

// ─── playability check ────────────────────────────────────────────────────────
const CHROMIUM_SAFE_CODECS = new Set(['h264','hevc','vp8','vp9','av1','theora']);
const CHROMIUM_SAFE_CONTAINERS = new Set(['.mp4','.mkv','.webm','.mov','.m4v','.ogv']);

ipcMain.handle('check-playability', async (_, fp) => {
  try {
    const info = await runFFprobe(['-v','quiet','-print_format','json','-show_streams','-show_format', fp]);
    const vStream = (info.streams||[]).find(s => s.codec_type === 'video');
    const ext = path.extname(fp).toLowerCase();
    const codec = vStream?.codec_name || '';
    return {
      playable: CHROMIUM_SAFE_CONTAINERS.has(ext) && CHROMIUM_SAFE_CODECS.has(codec),
      codec, ext, hasVideo: !!vStream
    };
  } catch(e) { return { playable: false, codec: '', ext: '', hasVideo: false }; }
});

// ─── preview transcoding ──────────────────────────────────────────────────────
const previewCache = new Map();

ipcMain.handle('make-preview', async (_, fp) => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  // Always delete ALL existing previews for this base filename before creating
  // a new one. This guarantees we never serve a stale preview regardless of
  // cache state, file size, or modification time.
  const baseName = path.basename(fp).replace(/[^a-zA-Z0-9]/g, '_');
  try {
    const existing = fs.readdirSync(tmpDir).filter(f => f.startsWith(`preview_${baseName}_`));
    for (const f of existing) {
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch(_) {}
    }
  } catch(_) {}

  // Also clear this path from the in-memory cache entirely
  for (const [key] of previewCache) {
    if (key.startsWith(fp)) previewCache.delete(key);
  }

  // New unique filename: baseName + timestamp → always fresh
  const previewPath = path.join(tmpDir, `preview_${baseName}_${Date.now()}.mp4`);

  mainWindow.webContents.send('preview-progress', { status: 'converting', pct: 0 });
  await runFF([
    '-i', fp,
    '-vf', 'scale=trunc(iw/4)*2:trunc(ih/4)*2',
    '-vcodec', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-acodec', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', '-y', previewPath
  ], chunk => {
    const m = chunk.match(/time=(\d+):(\d+):([\d.]+)/);
    if (m) mainWindow.webContents.send('preview-progress', {
      status: 'converting', pct: +m[1]*3600 + +m[2]*60 + +m[3]
    });
  });
  previewCache.set(fp, previewPath);
  mainWindow.webContents.send('preview-progress', { status: 'done' });
  return previewPath;
});

// ─── keyframes near a time ────────────────────────────────────────────────────
ipcMain.handle('get-keyframes-near', async (_, fp, time, windowSec) => {
  const w = windowSec || 10;
  const from = Math.max(0, time - w);
  try {
    const info = await runFFprobe([
      '-v','quiet','-print_format','json','-select_streams','v:0',
      '-show_packets','-read_intervals', `${from}%+${w*2}`,
      '-show_entries','packet=pts_time,flags', fp
    ]);
    const kfs = (info.packets||[])
      .filter(p => p.flags && p.flags.includes('K'))
      .map(p => parseFloat(p.pts_time)).filter(t => !isNaN(t));
    if (kfs.length > 0) return kfs;
  } catch(e) {}
  // fallback
  try {
    const info2 = await runFFprobe([
      '-v','quiet','-print_format','json','-select_streams','v:0',
      '-show_frames','-read_intervals', `${Math.max(0,time-w)}%+${w*2}`,
      '-show_entries','frame=best_effort_timestamp_time,pkt_pts_time,key_frame', fp
    ]);
    return (info2.frames||[]).filter(f=>f.key_frame===1)
      .map(f=>parseFloat(f.pkt_pts_time??f.best_effort_timestamp_time)).filter(t=>!isNaN(t));
  } catch(e2) { return []; }
});

// ─── scene detection ─────────────────────────────────────────────────────────
ipcMain.handle('detect-scenes', async (_, fp, th) => new Promise((res, rej) => {
  const threshold = typeof th === 'number' ? th : 0.3;
  runFFprobe(['-v','quiet','-print_format','json','-show_format', fp]).then(info => {
    const duration = parseFloat(info.format.duration) || 0;
    const proc = spawn(ffmpegPath, ['-i', fp, '-vf', `select='gt(scene,${threshold})',showinfo`, '-vsync','0','-an','-f','null','-']);
    let stderr = '';
    proc.stderr.on('data', d => {
      const chunk = d.toString(); stderr += chunk;
      const m = chunk.match(/time=(\d+):(\d+):(\d+)/);
      if (m && duration > 0) mainWindow.webContents.send('detect-progress',
        Math.round(((+m[1]*3600 + +m[2]*60 + +m[3]) / duration) * 100));
    });
    proc.on('close', () => {
      const pts = []; const re = /pts_time:([\d.]+)/g; let m;
      while ((m = re.exec(stderr)) !== null) {
        const t = parseFloat(m[1]);
        if (!isNaN(t) && (pts.length === 0 || t - pts[pts.length-1] >= 2.0)) pts.push(t);
      }
      res({ changePoints: pts, duration });
    });
    proc.on('error', rej);
  }).catch(rej);
}));

ipcMain.handle('detect-scenes-range', async (_, fp, th, rangeStart, rangeEnd) => new Promise((res, rej) => {
  const threshold = typeof th === 'number' ? th : 0.3;
  const duration = rangeEnd - rangeStart;
  const proc = spawn(ffmpegPath, [
    '-ss', String(rangeStart), '-i', fp, '-t', String(duration),
    '-vf', `select='gt(scene,${threshold})',showinfo`, '-vsync','0','-an','-f','null','-'
  ]);
  let stderr = '';
  proc.stderr.on('data', d => {
    const chunk = d.toString(); stderr += chunk;
    const m = chunk.match(/time=(\d+):(\d+):(\d+)/);
    if (m && duration > 0) mainWindow.webContents.send('detect-progress',
      Math.round(((+m[1]*3600 + +m[2]*60 + +m[3]) / duration) * 100));
  });
  proc.on('close', () => {
    const pts = []; const re = /pts_time:([\d.]+)/g; let m;
    while ((m = re.exec(stderr)) !== null) {
      const t = parseFloat(m[1]) + rangeStart;
      if (!isNaN(t) && (pts.length === 0 || t - pts[pts.length-1] >= 2.0)) pts.push(t);
    }
    res({ changePoints: pts, rangeStart, rangeEnd });
  });
  proc.on('error', rej);
}));

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORT — the engine lives in exporter.js (see the header there for details)
// ═══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('export-scenes', async (_, { inputPath, scenes, outputPath, mode }) =>
  exportScenes({
    inputPath, scenes, outputPath, mode,
    ffmpegPath, ffprobePath,
    tmpDir: path.join(os.tmpdir(), 'scene-cutter-export'),
    send: d => mainWindow.webContents.send('export-progress', d)
  })
);


ipcMain.handle('show-in-folder', async (_, fp) => shell.showItemInFolder(fp));

// ─── preview cache management ─────────────────────────────────────────────────
ipcMain.handle('get-preview-cache-info', async () => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) return { count: 0, sizeBytes: 0, dir: tmpDir };
  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp4'));
  let sizeBytes = 0;
  for (const f of files) { try { sizeBytes += fs.statSync(path.join(tmpDir, f)).size; } catch(_) {} }
  return { count: files.length, sizeBytes, dir: tmpDir };
});

ipcMain.handle('clear-preview-cache', async () => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) return { deleted: 0 };
  const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.mp4'));
  let deleted = 0;
  for (const f of files) { try { fs.unlinkSync(path.join(tmpDir, f)); deleted++; } catch(_) {} }
  previewCache.clear();
  return { deleted };
});

ipcMain.handle('open-preview-folder', async () => {
  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-preview');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  shell.openPath(tmpDir);
});
