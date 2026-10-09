// ═══════════════════════════════════════════════════════════════════════════════
//  exporter.js — Lossless + Smart Cut export engine (no Electron dependency,
//  so it can be unit-tested from plain Node).
//
//  What changed vs. the old inline implementation in main.js
//  ─────────────────────────────────────────────────────────
//  1. The source probe ignored "attached picture" streams (MP4 cover art).
//     A PNG cover is reported by ffprobe as a *video* stream with
//     pix_fmt=rgb24 and r_frame_rate=90000/1. The old loop let that stream
//     overwrite the real video's settings, so every re-encoded head/tail was
//     run with `-pix_fmt rgb24 -r 90000`:
//       • x264 silently switched to High 4:4:4 Predictive (yuv444p) → a
//         stream that cannot be joined with the 4:2:0 source  → broken output
//       • 90 000 fps means ~3000x more frames to encode        → "forever"
//     Now only the real video stream is probed, and it is mapped explicitly.
//
//  2. Re-encoded pieces are made to look like the source: same profile, level,
//     pix_fmt, colour tags, exact rational fps and (for x264 sources) the
//     original ref/bframes/b-pyramid/... settings read from the x264 SEI.
//     CRF + veryfast preset is used instead of the default `medium` + ABR.
//
//  3. H.264/HEVC pieces are written as MPEG-TS, which carries SPS/PPS *in-band*
//     in every piece. With MKV/MP4 pieces only the first file's parameter sets
//     (avcC) survive concat, so any piece with a different SPS/PPS (different
//     level, refs, ...) decoded as garbage.
//
//  4. Cuts are done in whole FRAMES (CFR sources): `-frames:v N` instead of
//     `-t`, so a copied body never gains/loses the B-frame-delay frames at
//     its end and neighbouring pieces never overlap or leave gaps. Each
//     piece's exact length is handed to the concat demuxer via `duration`.
//
//  5. Audio is no longer cut per piece (AAC frames do not line up with video
//     frames, which caused clicks and accumulating A/V drift). In smart mode it
//     is cut sample-accurately in ONE pass (atrim+concat) and muxed at the end.
//
//  6. Temp files are always cleaned up, also on failure.
// ═══════════════════════════════════════════════════════════════════════════════
const path = require('path');
const fs   = require('fs');
const os   = require('os');
const { spawn } = require('child_process');

function makeRunners(ffmpegPath, ffprobePath) {
  function runFF(args, onStderr) {
    return new Promise((res, rej) => {
      const p = spawn(ffmpegPath, args);
      let err = '';
      p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-8000); if (onStderr) onStderr(d.toString()); });
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
      p.on('close', () => { try { res(JSON.parse(out)); } catch (e) { rej(new Error(err.slice(-500))); } });
      p.on('error', rej);
    });
  }
  return { runFF, runFFprobe };
}

// ─── probing helpers ─────────────────────────────────────────────────────────
const COVER_CODECS = new Set(['png', 'mjpeg', 'bmp', 'gif', 'webp', 'tiff']);

function isAttachedPic(s) {
  if (s.disposition && s.disposition.attached_pic === 1) return true;
  // Some muxers do not set the disposition; a still image codec with no real
  // frame rate is still not a video track.
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

function x264ProfileName(p) {
  if (!p) return null;
  if (/baseline/i.test(p)) return 'baseline';
  if (/4:4:4/.test(p))     return 'high444';
  if (/4:2:2/.test(p))     return 'high422';
  if (/high 10/i.test(p))  return 'high10';
  if (/high/i.test(p))     return 'high';
  if (/main/i.test(p))     return 'main';
  return null;
}

function levelString(level) {
  const l = parseInt(level);
  if (!l || l <= 0 || l > 99) return null;
  return (Math.floor(l / 10)) + '.' + (l % 10);
}

// x264 writes its full option string into a SEI in the first IDR. Reading it
// lets the re-encoded head/tail use the very same ref/bframes/pyramid/... so
// the resulting SPS/PPS are (nearly always) identical to the source's.
function sniffX264Options(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4 * 1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const text = buf.toString('latin1', 0, n);
    const i = text.indexOf('x264 - core');
    if (i < 0) return null;
    const j = text.indexOf(' options: ', i);
    if (j < 0 || j - i > 200) return null;
    let end = text.indexOf('\0', j);
    if (end < 0) end = j + 1500;
    const opts = {};
    for (const tok of text.slice(j + 10, end).trim().split(/\s+/)) {
      const k = tok.indexOf('=');
      if (k > 0) opts[tok.slice(0, k)] = tok.slice(k + 1);
    }
    return opts;
  } catch (e) { return null; }
}

function x264ParamsFromSource(opts, hasB) {
  const p = ['open-gop=0', 'scenecut=0', 'keyint=600', 'min-keyint=1'];
  if (!opts) { if (!hasB) p.push('bframes=0'); return p; }
  const num = k => (opts[k] !== undefined && /^-?\d+$/.test(opts[k])) ? opts[k] : null;
  const copy = (srcKey, dstKey) => { const v = num(srcKey); if (v !== null) p.push(`${dstKey}=${v}`); };
  copy('ref', 'ref');
  copy('bframes', 'bframes');
  copy('b_pyramid', 'b-pyramid');
  copy('weightp', 'weightp');
  copy('weightb', 'weightb');
  copy('direct', 'direct');
  copy('cabac', 'cabac');
  copy('8x8dct', '8x8dct');
  copy('mixed_ref', 'mixed-refs');
  copy('chroma_qp_offset', 'chroma-qp-offset');
  if (opts.deblock && /^-?\d+:-?\d+:-?\d+$/.test(opts.deblock)) p.push('deblock=' + opts.deblock.replace(/:/g, ','));
  // b_pyramid=1 (strict) / 2 (normal) in the SEI map to the x264 names
  const bp = p.findIndex(x => x.startsWith('b-pyramid='));
  if (bp >= 0) p[bp] = 'b-pyramid=' + ({ 0: 'none', 1: 'strict', 2: 'normal' }[opts.b_pyramid] || 'normal');
  return p;
}

async function probeSource(runFFprobe, inputPath) {
  const info = await runFFprobe(['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', inputPath]);
  const streams = info.streams || [];
  const fmt = info.format || {};
  const v = streams.find(s => s.codec_type === 'video' && !isAttachedPic(s));
  const a = streams.find(s => s.codec_type === 'audio');
  const audioOrdinal = a ? streams.filter(s => s.codec_type === 'audio').indexOf(a) : -1;

  const src = {
    duration: parseFloat(fmt.duration) || 0,
    fmtStart: parseFloat(fmt.start_time) || 0,
    fmtBitrate: parseInt(fmt.bit_rate) || 0,
    video: null, audio: null, audioOrdinal
  };
  if (v) {
    const fps = pickFps(v);
    src.video = {
      index: v.index, codec: v.codec_name, profile: v.profile, level: v.level,
      pixFmt: v.pix_fmt || 'yuv420p', fps,
      start: parseFloat(v.start_time) || 0,
      bitrate: parseInt(v.bit_rate) || 0,
      hasB: (v.has_b_frames || 0) > 0,
      color: {
        range: v.color_range, space: v.color_space,
        trc: v.color_transfer, primaries: v.color_primaries
      }
    };
  }
  if (a) {
    src.audio = {
      index: a.index, codec: a.codec_name,
      sampleRate: a.sample_rate || null, channels: a.channels || null,
      bitrate: parseInt(a.bit_rate) || 0
    };
  }
  return src;
}

// ═══════════════════════════════════════════════════════════════════════════════
async function exportScenes({ inputPath, scenes, outputPath, mode, ffmpegPath, ffprobePath, tmpDir, send }) {
  const exportMode = mode || 'smart';
  send = send || (() => {});
  const { runFF, runFFprobe } = makeRunners(ffmpegPath, ffprobePath);
  tmpDir = tmpDir || path.join(os.tmpdir(), 'scene-cutter-export');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const jobId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const outExt = path.extname(outputPath).toLowerCase();
  const tmpFiles = [];
  const tmp = name => { const f = path.join(tmpDir, `${jobId}_${name}`); tmpFiles.push(f); return f; };

  const sorted = [...scenes].sort((a, b) => a.start - b.start);
  const N = sorted.length;

  function containerFlags(ext) {
    if (ext === '.mp4' || ext === '.m4v' || ext === '.mov') return ['-movflags', '+faststart'];
    if (ext === '.ts' || ext === '.mts' || ext === '.m2ts') return ['-f', 'mpegts'];
    return [];
  }

  // ── concat helper (shared) ────────────────────────────────────────────────
  // `durations` (seconds) is optional; when given, the concat demuxer uses it
  // instead of guessing each file's length.
  async function concatCopy(pieces, durations, extraInputs, mapArgs, outFile, zeroTs) {
    const listFile = tmp('list.txt');
    const lines = [];
    pieces.forEach((p, i) => {
      lines.push(`file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
      if (durations) lines.push(`duration ${durations[i].toFixed(9)}`);
    });
    fs.writeFileSync(listFile, lines.join('\n'));
    await runFF([
      '-f', 'concat', '-safe', '0', '-i', listFile,
      ...extraInputs,
      ...mapArgs,
      '-c', 'copy',
      ...(zeroTs ? ['-avoid_negative_ts', 'make_zero'] : []),
      ...containerFlags(outExt),
      '-y', outFile
    ]);
  }

  try {
    // ════════════════════════════════════════════════════════════════════════
    //  LOSSLESS MODE (unchanged behaviour: stream copy per scene, then join)
    // ════════════════════════════════════════════════════════════════════════
    if (exportMode === 'lossless') {
      send({ status: 'scanning' });
      if (N === 1) {
        send({ status: 'cutting', current: 1, total: 1, method: 'lossless' });
        await runFF(['-ss', String(sorted[0].start), '-i', inputPath, '-t', String(sorted[0].end - sorted[0].start),
          '-c', 'copy', '-avoid_negative_ts', 'make_zero', ...containerFlags(outExt), '-y', outputPath]);
        send({ status: 'done' });
        return outputPath;
      }
      const pieces = [];
      let offset = 0;
      for (let i = 0; i < N; i++) {
        send({ status: 'cutting', current: i + 1, total: N, method: 'lossless' });
        const s = sorted[i];
        const f = tmp(`ll_${i}.mkv`);
        await runFF(['-ss', String(s.start), '-i', inputPath, '-t', String(s.end - s.start),
          '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-output_ts_offset', String(offset), '-y', f]);
        pieces.push(f);
        offset += s.end - s.start;
      }
      send({ status: 'merging' });
      await concatCopy(pieces, null, [], [], outputPath);
      send({ status: 'done' });
      return outputPath;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  SMART MODE
    // ════════════════════════════════════════════════════════════════════════
    send({ status: 'scanning' });
    const src = await probeSource(runFFprobe, inputPath);
    if (!src.video) throw new Error('No video stream found in the input file.');
    const V = src.video, A = src.audio;
    const fps = V.fps.v;
    const fpsStr = `${V.fps.n}/${V.fps.d}`;
    const fstart = src.fmtStart;                  // ffmpeg times are relative to this
    const vStartRel = V.start - fstart;           // pts of frame #0, relative
    const frameTime = i => vStartRel + i / fps;                       // relative seconds
    const idxCeil   = t => Math.ceil((t - vStartRel) * fps - 1e-3);   // first frame with pts >= t
    const idxRound  = t => Math.round((t - vStartRel) * fps);
    const totalFrames = src.duration > 0 ? Math.round((src.duration - vStartRel) * fps) : Infinity;

    const isAvc  = V.codec === 'h264';
    const isHevc = V.codec === 'hevc' || V.codec === 'h265';
    const tsAudioOk = !A || ['aac', 'mp3', 'ac3', 'eac3', 'mp2'].includes(A.codec);
    const useTs = (isAvc || isHevc) && tsAudioOk;         // in-band parameter sets
    const pieceExt = useTs ? '.ts' : '.mkv';
    const pieceMuxArgs = useTs ? ['-f', 'mpegts'] : [];

    // ── encoder args that mimic the source ────────────────────────────────
    const colorArgs = [];
    const c = V.color || {};
    if (c.range      && c.range      !== 'unknown') colorArgs.push('-color_range', c.range);
    if (c.space      && c.space      !== 'unknown') colorArgs.push('-colorspace', c.space);
    if (c.trc        && c.trc        !== 'unknown') colorArgs.push('-color_trc', c.trc);
    if (c.primaries  && c.primaries  !== 'unknown') colorArgs.push('-color_primaries', c.primaries);

    const srcBr = V.bitrate || src.fmtBitrate || 8000000;
    const maxrate = Math.round(srcBr * 1.6 / 1000) + 'k';
    const bufsize = Math.round(srcBr * 3.2 / 1000) + 'k';

    const x264Opts = isAvc ? sniffX264Options(inputPath) : null;

    function videoEncodeArgs() {
      const common = ['-pix_fmt', V.pixFmt, '-r', fpsStr, '-fps_mode', 'cfr', ...colorArgs];
      if (isAvc) {
        const a = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
          '-maxrate', maxrate, '-bufsize', bufsize];
        const prof = x264ProfileName(V.profile); if (prof) a.push('-profile:v', prof);
        const lvl = levelString(V.level);         if (lvl)  a.push('-level:v', lvl);
        a.push('-x264-params', x264ParamsFromSource(x264Opts, V.hasB).join(':'));
        return [...a, ...common];
      }
      if (isHevc) {
        return ['-c:v', 'libx265', '-preset', 'veryfast', '-crf', '20', '-tag:v', 'hvc1',
          '-x265-params', 'open-gop=0:keyint=600:min-keyint=1:scenecut=0:repeat-headers=1:log-level=error',
          ...common];
      }
      // generic fallback for other codecs
      const cm = { vp9: 'libvpx-vp9', vp8: 'libvpx', av1: 'libaom-av1', mpeg2video: 'mpeg2video', mpeg1video: 'mpeg1video', mpeg4: 'mpeg4' };
      return ['-c:v', cm[V.codec] || 'libx264', '-b:v', Math.round(srcBr / 1000) + 'k', ...common];
    }
    const mapV = ['-map', `0:${V.index}`, '-an', '-sn', '-dn'];

    // Encode frames [fa, fb) of the source (video only)
    async function encodeFrames(fa, fb, outFile) {
      const n = fb - fa;
      await runFF([
        '-ss', Math.max(0, frameTime(fa) - 0.25 / fps).toFixed(6),
        '-i', inputPath, ...mapV,
        ...videoEncodeArgs(),
        '-frames:v', String(n),
        ...pieceMuxArgs, '-y', outFile
      ]);
    }
    // Copy frames [fa, fb) — fa MUST be a keyframe, fb MUST be a keyframe (or EOF)
    async function copyFrames(fa, fb, outFile) {
      const n = fb - fa;
      // Seek a quarter frame AFTER the keyframe: with -c copy ffmpeg starts at the
      // last keyframe <= ss and also writes the packets before ss, so seeking
      // even slightly before the IDR would pull in the whole previous GOP.
      await runFF([
        '-ss', (Math.max(0, frameTime(fa)) + 0.25 / fps).toFixed(6),
        '-i', inputPath, ...mapV,
        '-c:v', 'copy',
        '-frames:v', String(n),
        '-avoid_negative_ts', 'make_zero',
        ...pieceMuxArgs, '-y', outFile
      ]);
    }

    // ── keyframes (as frame indices) around a time ────────────────────────
    async function keyframeIdxsAround(t, window) {
      const from = Math.max(0, t - window);
      const relFrom = from + fstart;       // ffprobe works on raw container time
      try {
        const info = await runFFprobe([
          '-v', 'quiet', '-print_format', 'json', '-select_streams', String(V.index),
          '-show_packets', '-read_intervals', `${relFrom}%+${window * 2}`,
          '-show_entries', 'packet=pts_time,flags', inputPath
        ]);
        return (info.packets || []).filter(p => p.flags && p.flags.includes('K'))
          .map(p => parseFloat(p.pts_time)).filter(x => !isNaN(x))
          .map(x => idxRound(x - fstart)).filter(i => i >= 0)
          .sort((x, y) => x - y);
      } catch (e) { return []; }
    }

    send({ status: 'keyframes', current: 0, total: N });
    const plans = [];
    for (let i = 0; i < N; i++) {
      send({ status: 'keyframes', current: i + 1, total: N });
      const s = sorted[i];
      const fs_ = Math.max(0, idxCeil(s.start));
      const fe  = Math.min(totalFrames, idxCeil(s.end));
      if (fe - fs_ < 1) continue;
      let kfs = await keyframeIdxsAround(s.start, 12);
      let kfe = await keyframeIdxsAround(s.end, 12);
      if (!kfs.some(k => k >= fs_) || !kfe.some(k => k <= fe)) {
        kfs = await keyframeIdxsAround(s.start, 40);
        kfe = await keyframeIdxsAround(s.end, 40);
      }
      const kStart = kfs.find(k => k >= fs_);                          // first KF in scene
      const kEnd   = [...kfe].reverse().find(k => k <= fe);            // last KF <= end
      plans.push({ fs: fs_, fe, kStart, kEnd });
    }

    // ── cut every scene into encode/copy pieces ───────────────────────────
    const pieces = [];       // files
    const durations = [];    // seconds, exact (frames / fps)
    const addPiece = (file, frames) => { pieces.push(file); durations.push(frames / fps); };
    const MIN_BODY = 2;      // frames; below this it is not worth a separate copy
    const sceneFrameRanges = [];   // for audio: [startFrame, endFrame) per scene

    for (let i = 0; i < plans.length; i++) {
      const { fs: a, fe: b, kStart, kEnd } = plans[i];
      sceneFrameRanges.push([a, b]);
      const uid = `${i}`;
      const haveBody = kStart !== undefined && kEnd !== undefined && kEnd - kStart >= MIN_BODY && kStart < b;

      if (haveBody && kStart === a && kEnd === b) {
        send({ status: 'cutting', current: i + 1, total: plans.length, method: 'lossless' });
        const f = tmp(`p_${uid}${pieceExt}`);
        await copyFrames(a, b, f); addPiece(f, b - a);
      } else if (haveBody) {
        send({ status: 'cutting', current: i + 1, total: plans.length, method: 'smart' });
        if (kStart > a) {
          const f = tmp(`head_${uid}${pieceExt}`);
          await encodeFrames(a, kStart, f); addPiece(f, kStart - a);
        }
        const bf = tmp(`body_${uid}${pieceExt}`);
        await copyFrames(kStart, kEnd, bf); addPiece(bf, kEnd - kStart);
        if (b > kEnd) {
          const f = tmp(`tail_${uid}${pieceExt}`);
          await encodeFrames(kEnd, b, f); addPiece(f, b - kEnd);
        }
      } else {
        // scene lies inside a single GOP (or no usable keyframes) → encode it
        send({ status: 'cutting', current: i + 1, total: plans.length, method: 'smart' });
        const f = tmp(`p_${uid}${pieceExt}`);
        await encodeFrames(a, b, f); addPiece(f, b - a);
      }
    }
    if (pieces.length === 0) throw new Error('Nothing to export (all scenes are empty).');

    // ── audio: one sample-accurate pass ───────────────────────────────────
    let audioFile = null;
    if (A) {
      send({ status: 'cutting', current: plans.length, total: plans.length, method: 'smart' });
      const am = { aac: 'aac', mp3: 'libmp3lame', opus: 'libopus', vorbis: 'libvorbis', flac: 'flac', ac3: 'ac3', eac3: 'eac3', mp2: 'libmp3lame', pcm_s16le: 'pcm_s16le' };
      const aCodec = am[A.codec] || 'aac';
      const aEnc = ['-c:a', aCodec];
      if (!['flac', 'pcm_s16le'].includes(aCodec)) aEnc.push('-b:a', (A.bitrate > 0 ? Math.round(A.bitrate / 1000) : 192) + 'k');
      if (A.sampleRate) aEnc.push('-ar', String(A.sampleRate));
      if (A.channels)   aEnc.push('-ac', String(A.channels));

      const chains = [], labels = [];
      sceneFrameRanges.forEach(([a, b], i) => {
        const t0 = frameTime(a), t1 = frameTime(b);
        chains.push(`[0:a:${src.audioOrdinal}]atrim=start=${t0.toFixed(6)}:end=${t1.toFixed(6)},asetpts=PTS-STARTPTS[a${i}]`);
        labels.push(`[a${i}]`);
      });
      const graph = chains.join(';\n') + ';\n' + labels.join('') + `concat=n=${labels.length}:v=0:a=1[aout]`;
      const script = tmp('audio_graph.txt');
      fs.writeFileSync(script, graph);
      audioFile = tmp('audio.mka');
      await runFF(['-i', inputPath, '-filter_complex_script', script, '-map', '[aout]', '-vn', ...aEnc, '-y', audioFile]);
    }

    // ── final: join video pieces (+ audio) with stream copy ───────────────
    send({ status: 'merging' });
    if (audioFile) {
      await concatCopy(pieces, durations, ['-i', audioFile], ['-map', '0:v:0', '-map', '1:a:0'], outputPath, true);
    } else {
      await concatCopy(pieces, durations, [], ['-map', '0:v:0'], outputPath, true);
    }
    send({ status: 'done' });
    return outputPath;
  } finally {
    for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch (_) {} }
  }
}

module.exports = { exportScenes, probeSource, isAttachedPic, sniffX264Options, x264ParamsFromSource };
