// YouTube Playlist Downloader backend (personal/local use)
// Run: npm i express && node server.js  -> http://localhost:3000
const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const DIR = path.join(__dirname, 'downloads');
fs.mkdirSync(DIR, { recursive: true });
app.use(express.json());
app.use('/files', express.static(DIR));
app.get('/', (q, r) => r.sendFile(path.join(__dirname, 'index.html')));

let items = [], paused = false, cur = null, seq = 0;

// ---- Playlist info ----
app.get('/api/playlist', (req, res) => {
  const url = String(req.query.url || '');
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Valid URL daalo' });
  let out = '', err = '', sent = false;
  const reply = (code, body) => { if (!sent) { sent = true; res.status(code).json(body); } };
  const p = spawn('yt-dlp', ['--flat-playlist', '-J', '--no-warnings', '--', url]);
  p.stdout.on('data', d => out += d);
  p.stderr.on('data', d => err += d);
  p.on('error', () => reply(500, { error: 'yt-dlp install nahi hai (pip install -U yt-dlp)' }));
  p.on('close', () => {
    try {
      const j = JSON.parse(out);
      const entries = (j.entries || [j]).filter(e => e && e.id).map((e, i) => ({
        id: e.id,
        title: e.title || e.id,
        duration: e.duration || 0,
        thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
        index: i + 1
      }));
      reply(200, { title: j.title || 'Playlist', entries });
    } catch { reply(500, { error: (err.trim().split('\n').pop()) || 'Playlist fetch fail hua' }); }
  });
});

// ---- Queue ----
function findFile(id) {
  const f = fs.readdirSync(DIR).find(n => n.includes(`[${id}]`) && !/\.(part|ytdl|temp)$/i.test(n) && !/\.f\d+\./.test(n));
  return f || null;
}

function next() {
  if (paused || cur) return;
  const it = items.find(i => i.status === 'queued');
  if (!it) return;
  it.status = 'downloading'; it.stop = null; cur = it;
  const a = ['--newline', '--no-warnings', '--js-runtimes', 'node', '-c', '--no-playlist',
    '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '-o', path.join(DIR, '%(title).120B [%(id)s].%(ext)s')];
  if (it.q === 'audio') a.push('-x', '--audio-format', 'mp3');
  else a.push('-f', `bv*[height<=?${it.q}]+ba/b[height<=?${it.q}]`, '--merge-output-format', 'mp4');
  a.push('--', 'https://www.youtube.com/watch?v=' + it.id);

  const p = spawn('yt-dlp', a);
  it.proc = p;
  let err = '';
  p.stdout.on('data', d => {
    for (const line of String(d).split(/\r?\n/)) {
      const m = line.trim().match(/^([\d.]+)%\|([^|]*)\|(.*)$/);
      if (m) { it.pct = parseFloat(m[1]); it.speed = m[2].trim(); it.eta = m[3].trim(); }
    }
  });
  p.stderr.on('data', d => err += d);
  p.on('error', () => { it.status = 'error'; it.error = 'yt-dlp nahi mila'; });
  p.on('close', code => {
    it.proc = null; cur = null; it.speed = ''; it.eta = '';
    if (it.stop === 'pause') it.status = 'queued';
    else if (it.stop === 'cancel') it.status = 'cancelled';
    else if (code === 0) { it.status = 'done'; it.pct = 100; it.file = findFile(it.id); }
    else if (it.status !== 'error') { it.status = 'error'; it.error = err.trim().split('\n').pop() || 'Download fail'; }
    next();
  });
}

app.post('/api/jobs', (req, res) => {
  const { videos, quality } = req.body || {};
  if (!Array.isArray(videos)) return res.status(400).json({ error: 'videos missing' });
  const q = quality === 'audio' ? 'audio' : (['360', '480', '720', '1080', '2160'].includes(String(quality)) ? String(quality) : '720');
  for (const v of videos) {
    if (!/^[\w-]{11}$/.test(v.id)) continue;
    items.push({ uid: ++seq, id: v.id, title: String(v.title || v.id).slice(0, 200), q, status: 'queued', pct: 0, speed: '', eta: '', file: null });
  }
  next();
  res.json({ ok: true });
});

app.get('/api/state', (req, res) => {
  res.json({ paused, items: items.map(({ proc, stop, ...r }) => r) });
});

app.post('/api/pause', (req, res) => {
  paused = true;
  if (cur && cur.proc) { cur.stop = 'pause'; cur.proc.kill('SIGTERM'); }
  res.json({ ok: true });
});

app.post('/api/resume', (req, res) => { paused = false; next(); res.json({ ok: true }); });

app.post('/api/cancel/:uid', (req, res) => {
  const it = items.find(i => i.uid === +req.params.uid);
  if (it) {
    if (it.status === 'downloading' && it.proc) { it.stop = 'cancel'; it.proc.kill('SIGTERM'); }
    else if (it.status === 'queued' || it.status === 'error') it.status = 'cancelled';
  }
  res.json({ ok: true });
});

app.post('/api/clear', (req, res) => {
  items = items.filter(i => i.status === 'downloading' || i.status === 'queued');
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Running on port ' + PORT));
