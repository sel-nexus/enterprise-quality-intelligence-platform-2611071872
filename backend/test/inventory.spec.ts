/** Exercise inventory authorization and persistence over real HTTP and SQLite. */
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
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-inventory-'));
let app: INestApplication;
let db: Database;
let admin: string;
let viewer: string;
let executive: string;
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
const application = { id: 'app-a', name: 'Claims', segmentId: 'seg-a', owner: 'Team A', lifecycle: 'Active', criticality: 'High' };

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DEV_LOGIN_ENABLED = 'true';
  process.env.DEV_ADMIN_EMAIL = 'admin@example.test';
  process.env.DEV_ADMIN_PASSWORD = 'correct-local-password';
  process.env.SESSION_SECRET = 'test-secret-long-enough-for-signing-sessions';
  process.env.DATABASE_PATH = join(directory, 'inventory.sqlite');
  const old = new DatabaseSync(process.env.DATABASE_PATH);
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, password_hash TEXT NOT NULL);
    CREATE TABLE user_segments (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, segment_id TEXT NOT NULL, PRIMARY KEY (user_id, segment_id));
    INSERT INTO users VALUES ('reader', 'reader@example.test', 'viewer', 1, 'unused');
    INSERT INTO users VALUES ('leader', 'leader@example.test', 'executive', 1, 'unused');
    INSERT INTO user_segments VALUES ('reader', 'seg-a'); PRAGMA user_version = 1;`);
  old.close();
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.init();
  db = app.get(Database);
  admin = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'admin@example.test', password: 'correct-local-password' }).expect(200)).body.token;
  viewer = jwt.sign({ sub: 'reader', role: 'admin' }, process.env.SESSION_SECRET!, { expiresIn: '1h' });
  executive = jwt.sign({ sub: 'leader' }, process.env.SESSION_SECRET!, { expiresIn: '1h' });
});
afterAll(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

describe('inventory API', () => {
  it('migrates version 1 without losing identity and assignment data', () => {
    expect(db.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    expect(db.db.prepare('SELECT role FROM users WHERE id = ?').get('reader')).toMatchObject({ role: 'viewer' });
    expect(db.db.prepare('SELECT segment_id FROM user_segments WHERE user_id = ?').get('reader')).toMatchObject({ segment_id: 'seg-a' });
  });
  it('requires authentication on every endpoint', async () => {
    for (const [method, path] of [['get', 'segments'], ['post', 'segments'], ['patch', 'segments/x'], ['get', 'applications'], ['post', 'applications'], ['patch', 'applications/x']] as const) {
      await request(app.getHttpServer())[method](`/api/v1/${path}`).set('X-Role', 'admin').send({}).expect(401);
    }
  });
  it('creates and updates segments and applications with persisted values', async () => {
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: 'seg-a', name: 'Alpha' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: 'seg-b', name: 'Beta' }).expect(201);
    const renamed = await request(app.getHttpServer()).patch('/api/v1/segments/seg-a').set(headers(admin)).send({ name: 'Alpha renamed' }).expect(200);
    expect(renamed.body.name).toBe('Alpha renamed');
    const created = await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send(application).expect(201);
    expect(created.body).toMatchObject({ ...application, qualityScore: null });
    await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send({ ...application, id: 'app-b', segmentId: 'seg-b', name: 'Billing' }).expect(201);
    const updated = await request(app.getHttpServer()).patch('/api/v1/applications/app-a').set(headers(admin)).send({ owner: 'New owner', qualityScore: 75 }).expect(200);
    expect(updated.body).toMatchObject({ owner: 'New owner', qualityScore: 75, segmentId: 'seg-a' });
    expect(db.db.prepare('SELECT owner, quality_score FROM applications WHERE id = ?').get('app-a')).toMatchObject({ owner: 'New owner', quality_score: 75 });
  });
  it('scopes both lists and ignores spoofed roles while executive sees enterprise data', async () => {
    const segs = await request(app.getHttpServer()).get('/api/v1/segments').set(headers(viewer)).set('X-Role', 'admin').expect(200);
    expect(segs.body.items.map((s: { id: string }) => s.id)).toEqual(['seg-a']);
    const apps = await request(app.getHttpServer()).get('/api/v1/applications').set(headers(viewer)).expect(200);
    expect(apps.body.items.map((a: { id: string }) => a.id)).toEqual(['app-a']);
    expect((await request(app.getHttpServer()).get('/api/v1/applications').set(headers(executive)).expect(200)).body.items).toHaveLength(2);
    db.db.prepare('DELETE FROM user_segments WHERE user_id = ?').run('reader');
    expect((await request(app.getHttpServer()).get('/api/v1/segments').set(headers(viewer)).expect(200)).body.items).toEqual([]);
    expect((await request(app.getHttpServer()).get('/api/v1/applications').set(headers(viewer)).expect(200)).body.items).toEqual([]);
    db.db.prepare('INSERT INTO user_segments VALUES (?, ?)').run('reader', 'seg-a');
  });
  it('rejects all non-admin writes regardless of supplied role', async () => {
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(viewer)).set('X-Role', 'admin').send({ id: 'x', name: 'X' }).expect(403);
    await request(app.getHttpServer()).patch('/api/v1/segments/seg-a').set(headers(viewer)).send({ name: 'X' }).expect(403);
    await request(app.getHttpServer()).post('/api/v1/applications').set(headers(executive)).send(application).expect(403);
    await request(app.getHttpServer()).patch('/api/v1/applications/app-a').set(headers(viewer)).send({ owner: 'X', role: 'admin' }).expect(403);
  });
  it('rejects duplicates, invalid fields, unknown fields and invalid references', async () => {
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: 'seg-a', name: 'Duplicate' }).expect(409);
    await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send(application).expect(409);
    for (const body of [{ id: '', name: 'x' }, { id: 'bad id', name: 'x' }, { id: 'x', name: ' ' }, { id: 'x', name: 'x', role: 'admin' }]) await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send(body).expect(400);
    for (const body of [{ ...application, id: 'new', segmentId: 'missing' }, { ...application, id: 'new', owner: '' }, { ...application, id: 'new', qualityScore: 101 }, { ...application, id: 'new', qualityScore: '90' }, { ...application, id: 'new', role: 'admin' }]) await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send(body).expect(400);
    await request(app.getHttpServer()).patch('/api/v1/applications/app-a').set(headers(admin)).send({ segmentId: 'missing' }).expect(400);
    await request(app.getHttpServer()).patch('/api/v1/applications/app-a').set(headers(admin)).send({}).expect(400);
    await request(app.getHttpServer()).patch('/api/v1/applications/missing').set(headers(admin)).send({ name: 'X' }).expect(404);
    await request(app.getHttpServer()).patch('/api/v1/segments/missing').set(headers(admin)).send({ name: 'X' }).expect(404);
    await request(app.getHttpServer()).patch('/api/v1/segments/seg-a').set(headers(admin)).send({ name: '' }).expect(400);
  });
});
