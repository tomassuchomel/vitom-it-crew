// Upload příloh úkolů (foto/video).
//
// PERSISTENCE: Binární data uložená v attachments.data (BYTEA) v PostgreSQL,
// nikoliv na disku. Důvod: Render bez persistent disku má ephemerální FS —
// po deploy se data/uploads/ smaže. BYTEA v DB persistuje napříč deployi
// (stejně jako děláme s users.avatar_data).
//
// Endpointy:
//   GET    /api/attachments/by-task/:taskId   – list metadata pro daný úkol
//   POST   /api/attachments/by-task/:taskId   – upload (multipart files[])
//   GET    /api/attachments/:id/file          – streamuje binární data
//   DELETE /api/attachments/:id               – smaže záznam
//
// Pro legacy záznamy bez data (před touto migrací) je tu fallback na disk —
// pokud filename existuje na disku, ještě se nahraje. Na Render free tier
// se to nestane, ale pro lokální dev se zachová zpětná kompatibilita.

import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query } from '../db.js';
import { requireAuth, can } from '../auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Ponecháno pro legacy fallback (data na disku ze starých uploadů).
// Nové soubory tam nepíšeme.
const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Povolené přípony/mime: obrázky, videa + text (.md, .txt). Kontrolujeme
// mime i extension — .md prohlížeč často posílá jako application/octet-stream
// nebo text/plain, extension je spolehlivější signál.
const ALLOWED_MIME = /^(image|video)\/|^text\/(plain|markdown|x-markdown)$|^application\/octet-stream$/;
const ALLOWED_EXT  = new Set(['.md', '.txt', '.markdown']);
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = ALLOWED_MIME.test(file.mimetype);
    const extOk  = /^(image|video)\//.test(file.mimetype) || ALLOWED_EXT.has(ext);
    if (!(mimeOk && extOk)) return cb(new Error('unsupported_type'));
    cb(null, true);
  },
});

const router = Router();

// List metadata (bez binárních dat — ta se loadí lazy přes /:id/file).
router.get('/by-task/:taskId', requireAuth, async (req, res) => {
  const r = await query(`
    SELECT a.id, a.task_id, a.uploader_id, a.filename, a.original_name,
           a.mime_type, a.size, a.kind, a.created_at,
           (a.data IS NOT NULL) AS has_data,
           u.name AS uploader_name
    FROM attachments a
    JOIN users u ON u.id = a.uploader_id
    WHERE a.task_id = $1
    ORDER BY a.created_at DESC
  `, [Number(req.params.taskId)]);
  res.json({ attachments: r.rows });
});

// Upload – data jdou do DB jako BYTEA.
router.post('/by-task/:taskId', requireAuth, upload.array('files', 10), async (req, res) => {
  const taskId = Number(req.params.taskId);
  const tR = await query('SELECT id FROM tasks WHERE id = $1', [taskId]);
  if (!tR.rows[0]) return res.status(404).json({ error: 'task_not_found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'no_files' });

  const created = [];
  for (const f of req.files) {
    const ext = path.extname(f.originalname || '').toLowerCase();
    const kind = f.mimetype.startsWith('image/') ? 'image'
               : f.mimetype.startsWith('video/') ? 'video'
               : (ext === '.md' || ext === '.markdown' || ext === '.txt') ? 'text'
               : 'other';
    // Pseudo-filename pro DB (kompatibilita s legacy schématem)
    const synthFilename = `${crypto.randomBytes(12).toString('hex')}${ext.slice(0, 10)}`;
    const r = await query(`
      INSERT INTO attachments (task_id, uploader_id, filename, original_name, mime_type, size, kind, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, task_id, uploader_id, filename, original_name, mime_type, size, kind, created_at
    `, [taskId, req.user.id, synthFilename, f.originalname, f.mimetype, f.size, kind, f.buffer]);
    created.push(r.rows[0]);
  }
  res.json({ attachments: created });
});

// Stream binárních dat. Cache 1 den (data se nemění).
router.get('/:id/file', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  const r = await query(
    `SELECT data, mime_type, original_name, filename FROM attachments WHERE id = $1`,
    [id]
  );
  const a = r.rows[0];
  if (!a) return res.status(404).end();

  // Primárně data z DB. Pokud chybí (legacy záznam), fallback na disk.
  if (a.data) {
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.end(a.data);
  }
  // Legacy fallback
  const filePath = path.join(uploadsDir, a.filename || '');
  if (a.filename && fs.existsSync(filePath)) {
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return fs.createReadStream(filePath).pipe(res);
  }
  // Soubor je definitivně pryč (ephemerálnímu disk Renderu padly za oběť)
  res.status(404).json({ error: 'file_missing', message: 'Soubor se ztratil (Render free tier ephemeral disk). Nahraj prosím znovu.' });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const aR = await query('SELECT * FROM attachments WHERE id = $1', [id]);
  const a = aR.rows[0];
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (a.uploader_id !== req.user.id && !can.manageProjects(req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  // Smaž z disku pokud existuje (legacy)
  const filePath = path.join(uploadsDir, a.filename || '');
  if (a.filename && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (err) { console.warn('[attachments] cannot delete file', err); }
  }
  await query('DELETE FROM attachments WHERE id = $1', [id]);
  res.json({ ok: true });
});

router.use((err, req, res, next) => {
  if (err.message === 'only_images_videos') return res.status(400).json({ error: 'only_images_videos', message: 'Povoleny jen obrázky a videa' });
  if (err.code === 'LIMIT_FILE_SIZE')       return res.status(400).json({ error: 'file_too_large', message: 'Soubor > 25 MB' });
  next(err);
});

export default router;
export { uploadsDir };
