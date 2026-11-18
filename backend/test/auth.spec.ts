/** Exercise real HTTP authentication against isolated file-backed SQLite. */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
const directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-auth-'));
let app: INestApplication;
let db: Database;
const credentials = { email: 'admin@example.test', password: 'correct-local-password' };

beforeAll(async () => {
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

afterAll(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

describe('development identity API', () => {
  it('exposes public health and persists a salted password hash', async () => {
    expect((await request(app.getHttpServer()).get('/api/health')).body).toEqual({ status: 'ok' });
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
  it('rejects missing, malformed, tampered and expired tokens', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('X-Role', 'admin').expect(401);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', 'Bearer invalid').expect(401);
    const expired = jwt.sign({ sub: 'unknown' }, process.env.SESSION_SECRET!, { expiresIn: -1 });
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${expired}`).expect(401);
    const unknown = jwt.sign({ sub: 'unknown' }, process.env.SESSION_SECRET!, { expiresIn: '1h' });
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${unknown}`).expect(401);
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
