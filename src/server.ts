import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from './config';
import { assertSchema, pool } from './db';
import {
  clearSession,
  currentUser,
  issueSession,
  requirePageAuth,
  verifyCredentials,
} from './auth';
import { recordAudit } from './audit';
import { sendersRouter } from './routes/senders';
import { auditRouter } from './routes/audit';
import { usersRouter } from './routes/users';

const app = express();
const publicDir = path.join(__dirname, '..', 'public');
// HTML lives outside the static root so express.static cannot serve the
// dashboard shell to an unauthenticated caller via /index.html.
const viewsDir = path.join(__dirname, '..', 'views');

// Trust the first proxy hop so req.ip is the real client address in the
// audit log when this runs behind nginx/Kong.
app.set('trust proxy', 1);

// COOKIE_SECURE doubles as "this deployment is served over https": it decides
// the cookie flag, and the two headers below that are actively harmful on a
// plain-http vhost.
const servedOverHttps = config.cookieSecure;

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        // helmet sets upgrade-insecure-requests by default. Over plain http
        // that makes the browser rewrite every stylesheet and script URL to
        // https, which has no listener -- the HTML renders but arrives with no
        // CSS and no JS, failing silently with nothing in the server log.
        // `null` removes the directive; keep it only where TLS actually exists.
        ...(servedOverHttps ? {} : { upgradeInsecureRequests: null }),
      },
    },
    // Browsers ignore HSTS over plain http, and honouring it later would pin
    // the host to https before there is anything listening there.
    hsts: servedOverHttps,
  }),
);
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, try again later' },
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/login', async (req, res) => {
  if (await currentUser(req)) {
    res.redirect('/');
    return;
  }
  res.sendFile(path.join(viewsDir, 'login.html'));
});

const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(200),
});

app.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Username and password are required' });
      return;
    }
    const { username, password } = parsed.data;
    const user = await verifyCredentials(username, password);

    if (!user) {
      await recordAudit({
        actorUserId: null,
        actorUsername: username,
        action: 'login_failed',
        ip: req.ip ?? null,
      });
      res.status(401).json({ error: 'Invalid username or password' });
      return;
    }

    await issueSession(res, user);
    await pool.execute('UPDATE dashboard_users SET last_login_at = NOW() WHERE id = ?', [
      user.id,
    ]);
    await recordAudit({
      actorUserId: user.id,
      actorUsername: user.username,
      action: 'login',
      ip: req.ip ?? null,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/logout', (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  const user = await currentUser(req);
  if (!user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  res.json({ user });
});

app.use('/api/senders', sendersRouter);
app.use('/api/audit', auditRouter);
app.use('/api/users', usersRouter);

app.get('/', requirePageAuth, (_req, res) => {
  res.sendFile(path.join(viewsDir, 'index.html'));
});

// Only CSS/JS live here; both HTML pages are served from viewsDir by the
// guarded routes above, so there is no unauthenticated path to the shell.
app.use(express.static(publicDir, { index: false }));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Internal server error' });
});

async function main(): Promise<void> {
  await assertSchema();
  app.listen(config.port, config.bindHost, () => {
    console.log(
      `grantiliff-senders listening on http://${config.bindHost}:${config.port}`,
    );
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
