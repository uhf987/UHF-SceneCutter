// ═══════════════════════════════════════════════════════════════════════════════
//  exporter.js — export engine (no Electron dependency, testable from plain Node)
//
//  Every export is ONE ffmpeg pass that re-encodes the chosen segments into a
//  standard H.264 + AAC .mp4:
//
//    • same resolution as the source (no scaling; only rounded down to an even
//      size if the source is odd, which H.264 4:2:0 requires)
//    • same average video bitrate as the source
//    • same frame rate
//    • cuts are exact to the frame, audio is cut sample-accurately in the same
//      filter graph, so there are no keyframe snaps, no stream-copy joins, no
//      A/V drift and no per-piece temp files that can break
//
//  The old lossless / smart-cut modes were removed on purpose: stream copy
//  depends on keyframes, codec parameter sets and container quirks, which made
//  exports fail or hang on some sources. Re-encoding works on everything
//  ffmpeg can decode.
// ═══════════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn } = require('child_process');

// Tweak here if you want "a bit better than the source" (1.0 = same bitrate)
const BITRATE_FACTOR = 1.0;
const MAX_VIDEO_BITRATE = 100e6;   // H.264 above this is not playable on most devices
const X264_PRESET = 'fast';

// ─── process helpers ─────────────────────────────────────────────────────────
function runProbe(ffprobePath, args) {
  return new Promise((res, rej) => {
    const p = spawn(ffprobePath, args);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', () => { try { res(JSON.parse(out)); } catch (e) { rej(new Error(err.slice(-500) || 'ffprobe failed')); } });
    p.on('error', rej);
  });
}

function ffmpegMajor(ffmpegPath) {
  return new Promise(res => {
    try {
      const p = spawn(ffmpegPath, ['-version']);
      let out = '';
      p.stdout.on('data', d => out += d);
      p.on('close', () => {
        const m = out.match(/ffmpeg version (?:n|N-)?(\d+)/);
        // git builds ("N-12345-g...") are newer than any release we care about
        res(/ffmpeg version N-/.test(out) ? 99 : (m ? parseInt(m[1]) : 6));
      });
      p.on('error', () => res(6));
    } catch (e) { res(6); }
  });
}

// ─── hardware encoder detection ──────────────────────────────────────────────
// Tries NVIDIA → Intel → AMD with a tiny test encode; falls back to CPU (x264).
// Hardware encoding is several times faster, quality at equal bitrate is
// slightly below x264 — fine for a bitrate-matched copy.
let encoderCache = null;
const HW_ENCODERS = [
  { name: 'h264_nvenc', label: 'GPU · NVIDIA NVENC' },
  { name: 'h264_qsv',   label: 'GPU · Intel Quick Sync' },
  { name: 'h264_amf',   label: 'GPU · AMD AMF' },
];
const CPU_ENCODER = { name: 'libx264', label: 'CPU · x264' };

async function detectEncoder(ffmpegPath) {
  if (encoderCache) return encoderCache;
  for (const enc of HW_ENCODERS) {
    const ok = await new Promise(res => {
      let done = false;
      const fin = v => { if (!done) { done = true; res(v); } };
      try {
        const p = spawn(ffmpegPath, ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=s=640x360:r=25:d=0.2',
          '-pix_fmt', 'yuv420p', '-c:v', enc.name, '-f', 'null', '-']);
        const t = setTimeout(() => { try { p.kill(); } catch (_) {} fin(false); }, 8000);
        p.on('close', c => { clearTimeout(t); fin(c === 0); });
        p.on('error', () => { clearTimeout(t); fin(false); });
      } catch (e) { fin(false); }
    });
    if (ok) return (encoderCache = enc);
  }
  return (encoderCache = CPU_ENCODER);
}

// ─── probing ─────────────────────────────────────────────────────────────────
const COVER_CODECS = new Set(['png', 'mjpeg', 'bmp', 'gif', 'webp', 'tiff']);

// MP4 cover art is reported as a *video* stream (often "90000 fps"). Never use it.
function isAttachedPic(s) {
  if (s.disposition && s.disposition.attached_pic === 1) return true;
  return COVER_CODECS.has(s.codec_name) && (!s.avg_frame_rate || s.avg_frame_rate === '0/0');
}

function parseRate(str) {
  if (!str) return null;
  const [n, d] = String(str).split('/').map(Number);
  if (!n || !d) return null;
  const v = n / d;
  return v > 0 && v <= 1000 ? { n, d, v } : null;
}

function pickFps(v) {
  const avg = parseRate(v.avg_frame_rate);
  const r   = parseRate(v.r_frame_rate);
  if (avg && r && Math.abs(avg.v - r.v) / r.v < 0.01) return r;      // CFR
  if (avg) return avg;
  if (r && r.v <= 240) return r;
  return { n: 25, d: 1, v: 25 };
}

async function probeSource(ffprobePath, inputPath) {
  const info = await runProbe(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath]);
  const streams = info.streams || [];
  const fmt = info.format || {};
  const v = streams.find(s => s.codec_type === 'video' && !isAttachedPic(s));
  const a = streams.find(s => s.codec_type === 'audio');
  const brOf = s => parseInt(s.bit_rate) || parseInt(s.tags && (s.tags.BPS || s.tags['BPS-eng'])) || 0;

  let size = 0; try { size = fs.statSync(inputPath).size; } catch (_) {}
  const src = {
    duration: parseFloat(fmt.duration) || 0,
    fmtBitrate: parseInt(fmt.bit_rate) || 0,
    size, video: null, audio: null
  };
  if (v) {
    src.video = {
      index: v.index, codec: v.codec_name, pixFmt: v.pix_fmt,
      width: v.width, height: v.height,
      fps: pickFps(v), bitrate: brOf(v),
      color: { range: v.color_range, space: v.color_space, trc: v.color_transfer, primaries: v.color_primaries }
    };
  }
  if (a) {
    src.audio = {
      index: a.index, codec: a.codec_name,
      sampleRate: parseInt(a.sample_rate) || 0, channels: a.channels || 0,
      bitrate: brOf(a)
    };
  }
  return src;
}

// Average video bitrate of the source, in bits per second
function sourceVideoBitrate(src) {
  const V = src.video, A = src.audio;
  let br = V.bitrate;
  if (!br) {
    let total = src.fmtBitrate;
    if (!total && src.size && src.duration > 0) total = src.size * 8 / src.duration;
    if (total) br = total - (A ? (A.bitrate || 192000) : 0);
  }
  if (!br || br < 200000) br = br && br > 0 ? Math.max(br, 200000) : 8000000;
  return Math.min(MAX_VIDEO_BITRATE, Math.round(br * BITRATE_FACTOR));
}

// ═══════════════════════════════════════════════════════════════════════════════
async function exportScenes({ inputPath, scenes, outputPath, ffmpegPath, ffprobePath, send, forceCpu }) {
  send = send || (() => {});
  if (!/\.mp4$/i.test(outputPath)) outputPath += '.mp4';
  if (path.resolve(outputPath).toLowerCase() === path.resolve(inputPath).toLowerCase())
    throw new Error('The output file must be different from the input file.');

  // sorted, non-overlapping, non-empty
  const segs = [];
  for (const s of [...scenes].sort((a, b) => a.start - b.start)) {
    if (!(s.end - s.start > 0.001)) continue;
    const last = segs[segs.length - 1];
    if (last && s.start <= last.end + 1e-6) last.end = Math.max(last.end, s.end);
    else segs.push({ start: Math.max(0, s.start), end: s.end });
  }
  if (!segs.length) throw new Error('Nothing to export (no segments selected).');

  send({ status: 'scanning' });
  const src = await probeSource(ffprobePath, inputPath);
  if (!src.video) throw new Error('No video stream found in the input file.');
  const V = src.video, A = src.audio;
  const totalOut = segs.reduce((a, s) => a + (s.end - s.start), 0);

  // Decode only what is needed: start a little before the first segment and
  // stop right after the last one. All trim times are relative to `base`.
  const base = Math.max(0, segs[0].start - 0.5);
  const span = segs[segs.length - 1].end - base + 1;
  const rel = t => (t - base).toFixed(6);

  // ── filter graph ──────────────────────────────────────────────────────────
  const N = segs.length;
  const g = [];
  if (N === 1) {
    g.push(`[0:${V.index}]trim=start=${rel(segs[0].start)}:end=${rel(segs[0].end)},setpts=PTS-STARTPTS[vc]`);
    if (A) g.push(`[0:${A.index}]atrim=start=${rel(segs[0].start)}:end=${rel(segs[0].end)},asetpts=PTS-STARTPTS[ac]`);
  } else {
    g.push(`[0:${V.index}]split=${N}${segs.map((_, i) => `[vs${i}]`).join('')}`);
    if (A) g.push(`[0:${A.index}]asplit=${N}${segs.map((_, i) => `[as${i}]`).join('')}`);
    segs.forEach((s, i) => {
      g.push(`[vs${i}]trim=start=${rel(s.start)}:end=${rel(s.end)},setpts=PTS-STARTPTS[v${i}]`);
      if (A) g.push(`[as${i}]atrim=start=${rel(s.start)}:end=${rel(s.end)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    const ins = segs.map((_, i) => A ? `[v${i}][a${i}]` : `[v${i}]`).join('');
    g.push(`${ins}concat=n=${N}:v=1:a=${A ? 1 : 0}[vc]${A ? '[ac]' : ''}`);
  }
  // constant frame rate, 4:2:0, even dimensions (resolution otherwise unchanged)
  g.push(`[vc]fps=${V.fps.n}/${V.fps.d},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p[vout]`);
  const graph = g.join(';\n');

  // ── encoder settings ──────────────────────────────────────────────────────
  const vbr = sourceVideoBitrate(src);
  const kb = v => Math.round(v / 1000) + 'k';
  const colorArgs = [];
  const c = V.color || {};
  if (c.range     && c.range     !== 'unknown') colorArgs.push('-color_range', c.range);
  if (c.space     && c.space     !== 'unknown') colorArgs.push('-colorspace', c.space);
  if (c.trc       && c.trc       !== 'unknown') colorArgs.push('-color_trc', c.trc);
  if (c.primaries && c.primaries !== 'unknown') colorArgs.push('-color_primaries', c.primaries);

  const tmpDir = path.join(os.tmpdir(), 'scene-cutter-export');
  fs.mkdirSync(tmpDir, { recursive: true });
  const scriptFile = path.join(tmpDir, `graph_${Date.now()}_${Math.floor(Math.random() * 1e6)}.txt`);
  fs.writeFileSync(scriptFile, graph);
  const newSyntax = (await ffmpegMajor(ffmpegPath)) >= 7;

  function videoEncArgs(enc) {
    const b = ['-b:v', kb(vbr), '-maxrate', kb(vbr * 1.5), '-bufsize', kb(vbr * 2)];
    if (enc === 'h264_nvenc') return ['-c:v', enc, '-preset', 'p5', '-rc', 'vbr', ...b];
    if (enc === 'h264_qsv')   return ['-c:v', enc, '-preset', 'medium', ...b];
    if (enc === 'h264_amf')   return ['-c:v', enc, '-quality', 'quality', '-rc', 'vbr_peak', ...b];
    return ['-c:v', 'libx264', '-preset', X264_PRESET, ...b];
  }

  function buildArgs({ useNewSyntax, downmix, enc }) {
    const args = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
    if (base > 0) args.push('-ss', base.toFixed(3));
    args.push('-t', span.toFixed(3), '-i', inputPath);
    args.push(useNewSyntax ? '-/filter_complex' : '-filter_complex_script', scriptFile);
    args.push('-map', '[vout]');
    if (A) args.push('-map', '[ac]');
    args.push('-sn', '-dn', '-map_metadata', '-1');
    args.push(...videoEncArgs(enc), '-pix_fmt', 'yuv420p', ...colorArgs);
    if (A) {
      const abr = Math.min(384000, Math.max(128000, A.bitrate || 192000));
      args.push('-c:a', 'aac', '-b:a', kb(abr));
      if (A.sampleRate) args.push('-ar', String(A.sampleRate));
      if (downmix) args.push('-ac', '2');
    }
    args.push('-movflags', '+faststart', outputPath);
    return args;
  }

  function run(args) {
    return new Promise((res, rej) => {
      const p = spawn(ffmpegPath, args);
      let err = '', outBuf = '';
      p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-8000); });
      p.stdout.on('data', d => {
        outBuf += d;
        const lines = outBuf.split('\n'); outBuf = lines.pop();
        for (const l of lines) {
          const m = l.match(/^out_time_(?:us|ms)=(\d+)/);       // both are microseconds
          if (m) send({ status: 'encoding', pct: Math.max(0, Math.min(99, (+m[1] / 1e6) / totalOut * 100)) });
        }
      });
      p.on('close', code => code === 0 ? res() : rej(new Error(err.trim().split('\n').slice(-6).join('\n') || `ffmpeg exited with code ${code}`)));
      p.on('error', rej);
    });
  }

  try {
    const hw = forceCpu ? CPU_ENCODER : await detectEncoder(ffmpegPath);
    const encList = hw.name === 'libx264' ? [CPU_ENCODER] : [hw, CPU_ENCODER];   // GPU first, CPU as safety net
    let finished = false, lastErr = null;
    for (const enc of encList) {
      send({ status: 'encoding', pct: 0, encoder: enc.label });
      let useNew = newSyntax, downmix = false, toggled = false;
      for (let attempt = 0; attempt < 4 && !finished; attempt++) {
        try { await run(buildArgs({ useNewSyntax: useNew, downmix, enc: enc.name })); finished = true; }
        catch (e) {
          lastErr = e;
          const msg = String(e.message);
          if (!toggled && /Unrecognized option|Option not found/i.test(msg)) { useNew = !useNew; toggled = true; continue; }   // other ffmpeg generation
          if (A && !downmix && /channel layout|Unsupported channel|Invalid channel/i.test(msg)) { downmix = true; continue; }
          break;      // this encoder failed → try the next one
        }
      }
      if (finished) break;
    }
    if (!finished) { try { fs.unlinkSync(outputPath); } catch (_) {} throw lastErr; }
    send({ status: 'done' });
    return outputPath;
  } finally {
    try { fs.unlinkSync(scriptFile); } catch (_) {}
  }
}

module.exports = { exportScenes, detectEncoder, probeSource, isAttachedPic, pickFps, sourceVideoBitrate };
