// GitHub webhook → auto-deploy na VPS.
//
// Endpoint POST /api/deploy/github-webhook přijme GitHub push webhook, ověří
// HMAC-SHA256 podpis (X-Hub-Signature-256) proti GITHUB_WEBHOOK_SECRET a pro
// push na main spustí /home/vitom/deploy.sh (git pull + build + systemctl restart).
//
// Bezpečnost:
//   - HMAC verify PŘED čtením payloadu (crypto.timingSafeEqual).
//   - Jen event=push, ref=refs/heads/main. Ping vrátí pong.
//   - Bez secret: 503 (endpoint aktivně odmítá, nedělá nic).
//
// Nasazení (jednorázově):
//   1) V Admin panelu → Environment nastav GITHUB_WEBHOOK_SECRET (openssl rand -hex 32).
//   2) V GitHub repo → Settings → Webhooks → Add webhook:
//        URL:          https://it.realitniekosystem.cz/api/deploy/github-webhook
//        Content type: application/json
//        Secret:       (stejný jako v Admin panelu)
//        Events:       Just the push event
//   3) Na VPS jednou přidat sudoers rule, ať node může spustit deploy.sh:
//        echo 'vitom ALL=(root) NOPASSWD: /home/vitom/deploy.sh' | sudo tee /etc/sudoers.d/vitom-deploy
//        sudo chmod 440 /etc/sudoers.d/vitom-deploy

import express from 'express';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { recordError } from '../errorBuffer.js';

const router = express.Router();

// Guard proti souběžnému deployi (dva rychlé pushe za sebou).
let deploying = false;

function verifySignature(rawBody, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Extrahováno pro test — v produkci jen tuhle jednou zavoláme.
export function runDeploy(commit) {
  if (deploying) {
    console.warn('[deploy] concurrent request ignored');
    return;
  }
  deploying = true;
  console.log(`[deploy] triggered for ${commit || 'unknown'}`);
  try {
    // Deploy skript zabije server přes systemctl restart — proto detach + unref,
    // aby nás systemd nechytil s open pipe.
    const proc = spawn('sudo', ['-n', '/home/vitom/deploy.sh'], {
      detached: true,
      stdio: 'ignore',
    });
    proc.on('error', (err) => {
      deploying = false;
      console.error('[deploy] spawn error', err.message);
      recordError({ source: 'webhook-deploy', message: err.message, stack: err.stack });
    });
    proc.on('exit', (code) => {
      deploying = false;
      console.log(`[deploy] exit code ${code}`);
    });
    proc.unref();
  } catch (err) {
    deploying = false;
    recordError({ source: 'webhook-deploy', message: err.message, stack: err.stack });
  }
}

// Raw body parser — musí být PŘED globálním express.json(), jinak nebudeme mít
// bajty pro HMAC. Uvnitř routy si JSON parsneme ručně.
router.post('/github-webhook',
  express.raw({ type: 'application/json', limit: '5mb' }),
  (req, res) => {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'not_configured' });

    const signature = req.header('X-Hub-Signature-256') || '';
    if (!verifySignature(req.body, signature, secret)) {
      recordError({
        source: 'webhook-deploy',
        message: 'bad HMAC signature',
        path: '/api/deploy/github-webhook',
        status: 401,
      });
      return res.status(401).json({ error: 'bad_signature' });
    }

    const event = req.header('X-GitHub-Event') || '';
    if (event === 'ping') return res.json({ ok: true, pong: true });
    if (event !== 'push') return res.json({ ok: true, ignored: `event ${event}` });

    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ error: 'invalid_json' }); }

    if (payload.ref !== 'refs/heads/main') {
      return res.json({ ok: true, ignored: `ref ${payload.ref}` });
    }

    const commit = payload.after?.slice(0, 12);
    // Fire-and-forget: odpovíme, teprve pak spustíme deploy. Deploy si systemctl
    // restart nás beztak zabije — GitHub potřebuje 200 předtím.
    res.json({ ok: true, deploying: true, commit });
    setTimeout(() => runDeploy(commit), 300);
  }
);

export default router;
