import { Router } from 'express';
import { requireAuth, can } from '../auth.js';
import { getAdvice, chat, computeAccuracy, HAS_AI } from '../ai.js';

const router = Router();

// Status – dostupnost AI
router.get('/status', requireAuth, (req, res) => {
  res.json({ enabled: HAS_AI });
});

// Přesnost odhadů per uživatel – datově nezávislé na AI klíči, počítá se z DB.
// Viditelné jen admin/manager (stejně jako náklady).
router.get('/accuracy', requireAuth, async (req, res) => {
  if (!can.seeAllHours(req.user)) return res.status(403).json({ error: 'forbidden' });
  try {
    const rows = await computeAccuracy();
    res.json({ accuracy: rows });
  } catch (err) {
    console.error('[ai/accuracy]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// Hlavní analýza projektů a tempa – jen admin/manager
router.get('/advice', requireAuth, async (req, res) => {
  if (!can.seeAllHours(req.user)) return res.status(403).json({ error: 'forbidden' });
  try {
    const result = await getAdvice();
    res.json(result);
  } catch (err) {
    console.error('[ai/advice]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// Chat – uživatel se může zeptat na cokoli
// Body: { messages: [{ role: 'user'|'assistant', content: '...' }, ...] }
router.post('/chat', requireAuth, async (req, res) => {
  if (!can.seeAllHours(req.user)) return res.status(403).json({ error: 'forbidden' });
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'no_messages' });
  }
  try {
    const result = await chat(messages);
    res.json(result);
  } catch (err) {
    console.error('[ai/chat]', err);
    res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default router;
