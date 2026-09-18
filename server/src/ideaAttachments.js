// Přílohy u nápadů. Sdílí tabulku `attachments` s přílohami úkolů (vazba přes
// idea_id), takže žádná druhá implementace uploadu.
//
// Proti přílohám úkolů je tu PŘÍSNĚJŠÍ režim: veřejný formulář nahrává bez
// přihlášení, takže whitelist MIME typů + menší limit + omezený počet souborů.
// Servírování zůstává stejné (Content-Disposition: attachment + nosniff) v
// routes/attachments.js.

import multer from 'multer';
import crypto from 'node:crypto';
import { query } from './db.js';

export const MAX_IDEA_FILE_SIZE = 10 * 1024 * 1024; // 10 MB na soubor
export const MAX_IDEA_FILES = 5;

// Veřejný (nepřihlášený) formulář má přísnější strop — multer drží soubory
// v RAM a pak jdou jako BYTEA do Postgresu, takže neověřený odesílatel nesmí
// poslat desítky MB na jeden request.
export const MAX_PUBLIC_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
export const MAX_PUBLIC_FILES = 3;

// Povolené typy — obrázky, PDF a běžné kancelářské dokumenty.
// SVG záměrně NENÍ povolené: je to XML, které umí nést skript.
export const ALLOWED_IDEA_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf',
  'text/plain', 'text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

// Lidsky čitelný popis pro chybovou hlášku.
export const ALLOWED_IDEA_LABEL = 'JPG, PNG, WEBP, GIF, PDF, DOC(X), XLS(X), TXT, CSV';

// MIME hlavičku posílá klient, takže se na ni nedá spoléhat sama o sobě.
// Kontrolujeme proto i příponu — pořád to není záruka obsahu, ale zavírá to
// triviální obejití přejmenováním Content-Type.
const ALLOWED_IDEA_EXT = new Set([
  'jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf',
  'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx',
]);

export function isAllowedIdeaMime(mime) {
  return ALLOWED_IDEA_MIME.has(String(mime || '').toLowerCase());
}

export function isAllowedIdeaFile(originalName, mime) {
  const ext = String(originalName || '').split('.').pop()?.toLowerCase();
  return isAllowedIdeaMime(mime) && ALLOWED_IDEA_EXT.has(ext);
}

function fileFilter(req, file, cb) {
  if (!isAllowedIdeaFile(file.originalname, file.mimetype)) {
    const err = new Error('unsupported_type');
    err.code = 'UNSUPPORTED_TYPE';
    return cb(err);
  }
  cb(null, true);
}

// Multer pro veřejný i interní formulář nápadu. Requesty, které nejsou
// multipart (starý JSON klient), multer jen propustí dál.
export const publicIdeaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IDEA_FILE_SIZE, files: MAX_IDEA_FILES },
  fileFilter,
});

// Varianta pro veřejný formulář — nižší limity.
export const publicFormUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PUBLIC_FILE_SIZE, files: MAX_PUBLIC_FILES },
  fileFilter,
});

// Převod MIME na `kind` podle CHECK constraintu tabulky attachments.
function kindOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  return 'other';
}

// Uloží soubory k nápadu. uploaderId je null u veřejného formuláře.
// Vrací uložené záznamy (bez binárních dat).
export async function saveIdeaAttachments(ideaId, files, uploaderId) {
  const list = Array.isArray(files) ? files : [];
  const saved = [];
  for (const f of list) {
    // Druhá obrana: fileFilter už typ ověřil, ale kontrolujeme i tady, kdyby
    // někdo helper zavolal mimo multer.
    if (!isAllowedIdeaFile(f.originalname, f.mimetype)) continue;
    const r = await query(`
      INSERT INTO attachments (idea_id, uploader_id, filename, original_name, mime_type, size, kind, data)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, idea_id, uploader_id, filename, original_name, mime_type, size, kind, created_at
    `, [
      ideaId,
      uploaderId,
      `${crypto.randomUUID()}`,
      String(f.originalname || 'soubor').slice(0, 255),
      f.mimetype,
      f.size,
      kindOf(f.mimetype),
      f.buffer,
    ]);
    saved.push(r.rows[0]);
  }
  return saved;
}

// Sjednocený překlad chyb multeru na srozumitelnou hlášku.
// Vrací null, když o chybu uploadu nejde.
export function describeUploadError(err) {
  if (!err) return null;
  if (err.code === 'UNSUPPORTED_TYPE') {
    return { error: 'unsupported_type', message: `Tento typ souboru nepovolujeme. Povolené jsou: ${ALLOWED_IDEA_LABEL}.` };
  }
  if (err.code === 'LIMIT_FILE_SIZE') {
    return { error: 'file_too_large', message: 'Soubor je příliš velký.' };
  }
  if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
    return { error: 'too_many_files', message: 'Nahrál jsi víc souborů, než je povoleno.' };
  }
  return null;
}
