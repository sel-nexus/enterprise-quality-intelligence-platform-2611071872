/** Exercise real HTTP authentication against isolated file-backed SQLite. */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database';

// Some sandbox workspace mounts do not support SQLite locking; use guest-local temp on Linux.
let directory: string;
let app: INestApplication;
let db: Database;
const credentials = { email: 'admin@example.test', password: 'correct-local-password' };

beforeEach(async () => {
  directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-auth-'));
  process.env.NODE_ENV = 'test';
  process.env.DEV_LOGIN_ENABLED = 'true';
  process.env.DEV_ADMIN_EMAIL = credentials.email;
  process.env.DEV_ADMIN_PASSWORD = credentials.password;
  process.env.SESSION_SECRET = 'test-secret-long-enough-for-signing-sessions';
  process.env.DATABASE_PATH = join(directory, 'auth.sqlite');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.init();
  db = app.get(Database);
});

afterEach(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

describe('development identity API', () => {
  it('exposes public health and persists a salted password hash', async () => {
    expect((await request(app.getHttpServer()).get('/api/health').expect(200)).body).toEqual({ status: 'ok' });
    const row = db.db.prepare('SELECT password_hash FROM users WHERE email = ?').get(credentials.email) as { password_hash: string };
    expect(row.password_hash).not.toContain(credentials.password);
    expect(row.password_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
  });
  it('issues a session and reads the current database identity', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(200);
    expect(response.body.user).toMatchObject({ email: credentials.email, role: 'admin', segments: [] });
    expect(response.body.user.password_hash).toBeUndefined();
    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${response.body.token}`).set('X-Role', 'viewer').expect(200);
    expect(me.body).toEqual(response.body.user);
  });
  it('rejects incorrect and unknown credentials', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ ...credentials, password: 'wrong' }).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ ...credentials, email: 'missing@example.test' }).expect(401);
  });
  it('rejects invalid inputs and caller-controlled role', async () => {
    for (const input of [{}, { email: 42, password: 'x' }, { email: 'invalid', password: 'x' }, { ...credentials, role: 'admin' }, { ...credentials, password: 'x'.repeat(257) }]) {
      await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(400);
    }
  });
  it('rejects an oversized login body without changing users, audit or assignments', async () => {
    const user = db.db.prepare('SELECT id FROM users WHERE email = ?').get(credentials.email) as { id: string };
    db.db.prepare('INSERT INTO segments (id, name) VALUES (?, ?)').run('alpha', 'Alpha');
    db.db.prepare('INSERT INTO user_segments (user_id, segment_id) VALUES (?, ?)').run(user.id, 'alpha');
    db.db.prepare('INSERT INTO user_audit (actor_id, target_id, occurred_at, old_values, new_values) VALUES (?, ?, ?, ?, ?)').run(user.id, user.id, '2026-01-01T00:00:00.000Z', null, '{}');
    const users = db.db.prepare('SELECT * FROM users ORDER BY id').all();
    const audit = db.db.prepare('SELECT * FROM user_audit ORDER BY id').all();
    const assignments = db.db.prepare('SELECT * FROM user_segments ORDER BY user_id, segment_id').all();
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ ...credentials, password: 'x'.repeat(110_000) }).expect(413);
    expect(db.db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(users);
    expect(db.db.prepare('SELECT * FROM user_audit ORDER BY id').all()).toEqual(audit);
    expect(db.db.prepare('SELECT * FROM user_segments ORDER BY user_id, segment_id').all()).toEqual(assignments);
  });
  it('rejects missing, malformed, tampered and expired tokens', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('X-Role', 'admin').expect(401);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', 'Bearer invalid').expect(401);
    const expired = jwt.sign({ sub: 'unknown' }, process.env.SESSION_SECRET!, { expiresIn: -1 });
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`).expect(401);
    const unknown = jwt.sign({ sub: 'unknown' }, process.env.SESSION_SECRET!, { expiresIn: '1h' });
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${unknown}`).expect(401);
    for (const path of ['/api/v1/users', '/api/v1/users/audit', '/api/v1/reports/overview', '/api/v1/reports/applications.csv']) {
      await request(app.getHttpServer()).get(path).set('Authorization', `Bearer ${expired}`).expect(401);
    }
  });
  it('validates login shapes and lengths without changing the account', async () => {
    const before = db.db.prepare('SELECT * FROM users WHERE email = ?').get(credentials.email);
    const inputs = [[], { password: credentials.password }, { email: credentials.email },
      { email: null, password: credentials.password }, { email: credentials.email, password: null },
      { email: credentials.email, password: '' }, { email: `${'a'.repeat(250)}@x.test`, password: credentials.password },
      { email: "admin@example.test' OR 1=1--", password: credentials.password }];
    for (const input of inputs) await request(app.getHttpServer()).post('/api/v1/auth/login').send(input).expect(400);
    expect(db.db.prepare('SELECT * FROM users WHERE email = ?').get(credentials.email)).toEqual(before);
  });
  it('checks signed payload shape, algorithm, header and session version', async () => {
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(200);
    const id = login.body.user.id;
    const secret = process.env.SESSION_SECRET!;
    const tokens = [jwt.sign('text', secret), jwt.sign({}, secret), jwt.sign({ sub: '' }, secret),
      jwt.sign({ sub: id, sessionVersion: 1 }, secret), jwt.sign({ sub: id, sessionVersion: '0' }, secret),
      jwt.sign({ sub: id }, 'another-secret-long-enough-to-sign'), jwt.sign({ sub: id }, secret, { algorithm: 'HS384' })];
    for (const token of tokens) await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`).expect(401);
    for (const header of ['Basic abc', 'Bearer', 'Bearer two tokens']) await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', header).expect(401);
    const legacy = jwt.sign({ sub: id }, secret);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacy}`).expect(200);
    db.db.prepare('UPDATE users SET session_version = 1 WHERE id = ?').run(id);
    try {
      await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${legacy}`).expect(401);
      await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.token}`).expect(401);
      await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${jwt.sign({ sub: id, sessionVersion: 1 }, secret)}`).expect(200);
    } finally { db.db.prepare('UPDATE users SET session_version = 0 WHERE id = ?').run(id); }
  });
  it('reflects changed role and disables existing sessions for inactive users', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(200);
    db.db.prepare('UPDATE users SET role = ? WHERE email = ?').run('viewer', credentials.email);
    const me = await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${response.body.token}`).expect(200);
    expect(me.body.role).toBe('viewer');
    db.db.prepare('UPDATE users SET active = 0 WHERE email = ?').run(credentials.email);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${response.body.token}`).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(401);
    db.db.prepare('UPDATE users SET active = 1, role = ? WHERE email = ?').run('admin', credentials.email);
  });
  it('fails closed when disabled and in production even with an existing token', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(200);
    process.env.DEV_LOGIN_ENABLED = 'false';
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(401);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${response.body.token}`).expect(401);
    process.env.DEV_LOGIN_ENABLED = 'true';
    process.env.NODE_ENV = 'production';
    await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(401);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${response.body.token}`).expect(401);
    process.env.NODE_ENV = 'test';
  });
});
