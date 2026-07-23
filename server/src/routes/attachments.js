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

// Povolené typy: obrázky, videa, text, PDF, MS Office (Word/Excel/PowerPoint),
// CSV, JSON, ZIP. Kontrolujeme mime i extension — prohlížeč občas posílá
// application/octet-stream u .md/.docx/.pptx, extension je spolehlivější.
const ALLOWED_MIME = new RegExp([
  '^(image|video)/',
  '^text/(plain|markdown|x-markdown|csv)$',
  '^application/(pdf|zip|x-zip-compressed|json|octet-stream',
    // MS Office (starší)
    '|msword|vnd\\.ms-excel|vnd\\.ms-powerpoint',
    // MS Office 2007+ (OOXML)
    '|vnd\\.openxmlformats-officedocument\\.wordprocessingml\\.document',
    '|vnd\\.openxmlformats-officedocument\\.spreadsheetml\\.sheet',
    '|vnd\\.openxmlformats-officedocument\\.presentationml\\.presentation',
    ')$',
].join(''));
const ALLOWED_EXT = new Set([
  '.md', '.markdown', '.txt', '.csv', '.json',
  '.pdf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.zip',
]);
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeOk = ALLOWED_MIME.test(file.mimetype);
    // Extension whitelist: image/video se řídí mime (u obrázků nemá smysl vypisovat všechny),
    // ostatní musí mít explicit extension v ALLOWED_EXT.
    const extOk = /^(image|video)\//.test(file.mimetype) || ALLOWED_EXT.has(ext);
    // SVG obsahuje JS a jde vyrenderovat inline → stored XSS. I když download
    // route nutí attachment, obrana do hloubky: neber ho vůbec.
    const isSvg = file.mimetype === 'image/svg+xml' || ext === '.svg' || ext === '.svgz';
    if (!(mimeOk && extOk) || isSvg) return cb(new Error('unsupported_type'));
    cb(null, true);
  },
});

// Content-Disposition hlavička: ASCII fallback (RFC 2616) + UTF-8 filename*
// (RFC 5987) pro diakritiku. Escape " a \ v ASCII větvi.
function formatContentDisposition(name) {
  const raw = String(name || 'soubor');
  const ascii = raw
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_') || 'soubor';
  const utf8 = encodeURIComponent(raw).replace(/['()]/g, escape).replace(/\*/g, '%2A');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

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
    // Používá se v UI pro ikonu / náhled. 'document' zahrnuje kancelářské
    // formáty (pdf/office/csv/json) — všechny je klient renderuje jako
    // download link se štítkem.
    const DOC_EXTS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.json', '.zip']);
    const kind = f.mimetype.startsWith('image/') ? 'image'
               : f.mimetype.startsWith('video/') ? 'video'
               : (ext === '.md' || ext === '.markdown' || ext === '.txt') ? 'text'
               : DOC_EXTS.has(ext) ? 'document'
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

// Stream binárních dat.
//
// Autorizace: příloha se servíruje jen tomu, kdo má právo vidět nadřazený úkol —
// admin, člen týmu projektu, assignee úkolu, nebo manager projektu. Jinak 404
// (ne 403), aby uhádnuté id nezveřejnilo existenci cizí přílohy.
//
// Vynucený download: Content-Disposition attachment + nosniff, i pro obrázky.
// UI si obrázky renderuje z `<img src=…>` — attachment header render v <img>
// nezakazuje, jen brání otevření souboru inline v novém tabu (kde by SVG
// mohl spustit stored XSS). SVG je navíc odmítnutý už při uploadu.
router.get('/:id/file', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).end();
  const r = await query(`
    SELECT a.data, a.mime_type, a.original_name, a.filename,
           t.assignee_id, p.team_id AS project_team_id, p.manager_id AS project_manager_id
    FROM attachments a
    JOIN tasks t    ON t.id = a.task_id
    JOIN projects p ON p.id = t.project_id
    WHERE a.id = $1
  `, [id]);
  const a = r.rows[0];
  if (!a) return res.status(404).end();

  const isAdmin       = req.user.role === 'admin';
  const isAssignee    = a.assignee_id === req.user.id;
  const isProjectMgr  = a.project_manager_id === req.user.id;
  let isTeamMember    = false;
  if (!isAdmin && !isAssignee && !isProjectMgr) {
    const m = await query(
      `SELECT 1 FROM team_members WHERE user_id = $1 AND team_id = $2 LIMIT 1`,
      [req.user.id, a.project_team_id]
    );
    isTeamMember = m.rows.length > 0;
  }
  if (!isAdmin && !isAssignee && !isProjectMgr && !isTeamMember) {
    return res.status(404).end();
  }

  const setDownloadHeaders = () => {
    res.setHeader('Content-Type', a.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', formatContentDisposition(a.original_name || a.filename));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
  };

  // Primárně data z DB. Pokud chybí (legacy záznam), fallback na disk.
  if (a.data) {
    setDownloadHeaders();
    return res.end(a.data);
  }
  // Legacy fallback
  const filePath = path.join(uploadsDir, a.filename || '');
  if (a.filename && fs.existsSync(filePath)) {
    setDownloadHeaders();
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
