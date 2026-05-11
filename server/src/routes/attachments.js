// Upload příloh úkolů (foto/video).
// Soubory na disku, metadata v DB.
// POZNÁMKA: Render free tier nemá persistent disk – při restartu serveru se uploadované
// soubory ztratí. Pro produkční nasazení doporučujeme přidat S3/Cloudflare R2 storage.
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
const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const ALLOWED = /^(image|video)\//;
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 10);
    const id = crypto.randomBytes(12).toString('hex');
    cb(null, `${id}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED.test(file.mimetype)) return cb(new Error('only_images_videos'));
    cb(null, true);
  },
});

const router = Router();

router.get('/by-task/:taskId', requireAuth, async (req, res) => {
  const r = await query(`
    SELECT a.*, u.name AS uploader_name
    FROM attachments a
    JOIN users u ON u.id = a.uploader_id
    WHERE a.task_id = $1
    ORDER BY a.created_at DESC
  `, [Number(req.params.taskId)]);
  res.json({ attachments: r.rows });
});

router.post('/by-task/:taskId', requireAuth, upload.array('files', 10), async (req, res) => {
  const taskId = Number(req.params.taskId);
  const tR = await query('SELECT id FROM tasks WHERE id = $1', [taskId]);
  if (!tR.rows[0]) return res.status(404).json({ error: 'task_not_found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'no_files' });

  const created = [];
  for (const f of req.files) {
    const kind = f.mimetype.startsWith('image/') ? 'image'
               : f.mimetype.startsWith('video/') ? 'video' : 'other';
    const r = await query(`
      INSERT INTO attachments (task_id, uploader_id, filename, original_name, mime_type, size, kind)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [taskId, req.user.id, f.filename, f.originalname, f.mimetype, f.size, kind]);
    created.push(r.rows[0]);
  }
  res.json({ attachments: created });
});

router.delete('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const aR = await query('SELECT * FROM attachments WHERE id = $1', [id]);
  const a = aR.rows[0];
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (a.uploader_id !== req.user.id && !can.manageProjects(req.user)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const filePath = path.join(uploadsDir, a.filename);
  if (fs.existsSync(filePath)) {
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
