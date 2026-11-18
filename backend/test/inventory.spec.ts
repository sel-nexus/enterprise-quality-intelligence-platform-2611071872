/** Exercise inventory authorization and persistence over real HTTP and SQLite. */
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
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

let directory: string;
let app: INestApplication;
let db: Database;
let admin: string;
let viewer: string;
let executive: string;
const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
const application = { id: 'app-a', name: 'Claims', segmentId: 'seg-a', owner: 'Team A', lifecycle: 'Active', criticality: 'High' };

beforeEach(async () => {
  directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-inventory-'));
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
  db.db.exec(`INSERT INTO segments VALUES ('seg-a', 'Alpha renamed'), ('seg-b', 'Beta');
    INSERT INTO applications VALUES ('app-a', 'Claims', 'seg-a', 'New owner', 'Active', 'High', 75), ('app-b', 'Billing', 'seg-b', 'Team A', 'Active', 'High', NULL);`);
});
afterEach(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

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
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: 'seg-c', name: 'Gamma' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: 'seg-d', name: 'Delta' }).expect(201);
    const renamed = await request(app.getHttpServer()).patch('/api/v1/segments/seg-c').set(headers(admin)).send({ name: 'Gamma renamed' }).expect(200);
    expect(renamed.body.name).toBe('Gamma renamed');
    expect(db.db.prepare("SELECT id, name FROM segments WHERE id IN ('seg-c', 'seg-d') ORDER BY id").all()).toEqual([{ id: 'seg-c', name: 'Gamma renamed' }, { id: 'seg-d', name: 'Delta' }]);
    const newApplication = { ...application, id: 'app-c', segmentId: 'seg-c' };
    const created = await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send(newApplication).expect(201);
    expect(created.body).toMatchObject({ ...newApplication, qualityScore: null });
    expect(db.db.prepare('SELECT id, name, segment_id, owner, lifecycle, criticality, quality_score FROM applications WHERE id = ?').get('app-c')).toMatchObject({ id: 'app-c', name: 'Claims', segment_id: 'seg-c', owner: 'Team A', lifecycle: 'Active', criticality: 'High', quality_score: null });
    await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send({ ...application, id: 'app-d', segmentId: 'seg-d', name: 'Billing' }).expect(201);
    const updated = await request(app.getHttpServer()).patch('/api/v1/applications/app-c').set(headers(admin)).send({ owner: 'New owner', qualityScore: 75 }).expect(200);
    expect(updated.body).toMatchObject({ owner: 'New owner', qualityScore: 75, segmentId: 'seg-c' });
    expect(db.db.prepare('SELECT owner, quality_score FROM applications WHERE id = ?').get('app-c')).toMatchObject({ owner: 'New owner', quality_score: 75 });
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
  it('rejects expired sessions on every inventory endpoint', async () => {
    const expired = jwt.sign({ sub: 'reader' }, process.env.SESSION_SECRET!, { expiresIn: -1 });
    for (const [method, path] of [['get', 'segments'], ['post', 'segments'], ['patch', 'segments/seg-a'], ['get', 'applications'], ['post', 'applications'], ['patch', 'applications/app-a']] as const) {
      await request(app.getHttpServer())[method](`/api/v1/${path}`).set(headers(expired)).send({}).expect(401);
    }
  });
  it('checks required fields, type, whitespace and limits without persisting invalid input', async () => {
    const beforeSegments = db.db.prepare('SELECT * FROM segments ORDER BY id').all();
    const beforeApps = db.db.prepare('SELECT * FROM applications ORDER BY id').all();
    for (const field of ['id', 'name']) {
      const body: Record<string, unknown> = { id: 'boundary', name: 'Valid' }; delete body[field];
      await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send(body).expect(400);
    }
    for (const field of ['id', 'name', 'segmentId', 'owner', 'lifecycle', 'criticality']) {
      const body: Record<string, unknown> = { ...application, id: 'validation-app' }; delete body[field];
      await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send(body).expect(400);
      for (const value of [null, 12, ' ', 'x'.repeat(field === 'id' || field === 'segmentId' ? 81 : 201)]) {
        await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send({ ...application, id: 'validation-app', [field]: value }).expect(400);
      }
    }
    for (const body of [[], { id: 'x'.repeat(81), name: 'Valid' }, { id: 42, name: 'Valid' }, { id: 'x', name: false }, { id: 'x', name: 'x'.repeat(201) }]) await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send(body).expect(400);
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: 'oversized', name: 'x'.repeat(110_000) }).expect(413);
    for (const score of [-1, 100.01, true, '0', {}]) await request(app.getHttpServer()).patch('/api/v1/applications/app-a').set(headers(admin)).send({ qualityScore: score }).expect(400);
    await request(app.getHttpServer()).patch('/api/v1/segments/seg-a').set(headers(admin)).send({ name: 'x'.repeat(201) }).expect(400);
    expect(db.db.prepare('SELECT * FROM segments ORDER BY id').all()).toEqual(beforeSegments);
    expect(db.db.prepare('SELECT * FROM applications ORDER BY id').all()).toEqual(beforeApps);
    const maxId = 'i'.repeat(80);
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: maxId, name: 'n'.repeat(200) }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send({ ...application, id: 'bounds', segmentId: maxId, name: 'n'.repeat(200), qualityScore: 0 }).expect(201);
    await request(app.getHttpServer()).patch('/api/v1/applications/bounds').set(headers(admin)).send({ qualityScore: 100 }).expect(200);
    expect(db.db.prepare('SELECT quality_score FROM applications WHERE id = ?').get('bounds')).toMatchObject({ quality_score: 100 });
    await request(app.getHttpServer()).patch('/api/v1/applications/bounds').set(headers(admin)).send({ qualityScore: null }).expect(200);
    expect(db.db.prepare('SELECT quality_score FROM applications WHERE id = ?').get('bounds')).toMatchObject({ quality_score: null });
    db.db.prepare('DELETE FROM applications WHERE id = ?').run('bounds');
    db.db.prepare('DELETE FROM segments WHERE id = ?').run(maxId);
  });
  it('treats SQL and script payloads as data, not SQL or HTML', async () => {
    const sql = "x'); DROP TABLE users; --";
    const script = '<script>alert(1)</script>';
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: sql, name: 'Invalid ID' }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/segments').set(headers(admin)).send({ id: 'payload', name: sql }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/applications').set(headers(admin)).send({ ...application, id: 'payload-app', segmentId: 'payload', name: script, owner: sql }).expect(201);
    await request(app.getHttpServer()).patch('/api/v1/applications/payload-app').set(headers(admin)).send({ lifecycle: sql }).expect(200);
    const list = await request(app.getHttpServer()).get('/api/v1/applications').set(headers(admin)).expect(200);
    expect(list.headers['content-type']).toMatch(/application\/json/);
    expect(list.body.items).toContainEqual(expect.objectContaining({ id: 'payload-app', name: script, owner: sql, lifecycle: sql }));
    expect(db.db.prepare('SELECT name FROM segments WHERE id = ?').get('payload')).toMatchObject({ name: sql });
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM users').get()).toMatchObject({ count: 3 });
    expect(db.db.prepare('SELECT name FROM applications WHERE id = ?').get('app-a')).toMatchObject({ name: 'Claims' });
    db.db.prepare('DELETE FROM applications WHERE id = ?').run('payload-app');
    db.db.prepare('DELETE FROM segments WHERE id = ?').run('payload');
  });
  it('enforces SQLite constraints and cascade without damaging unrelated data', () => {
    const before = db.db.prepare('SELECT * FROM applications ORDER BY id').all();
    expect(() => db.db.prepare('INSERT INTO segments (id, name) VALUES (?, ?)').run('null-name', null)).toThrow();
    expect(() => db.db.prepare('INSERT INTO segments (id, name) VALUES (?, ?)').run('seg-a', 'Duplicate')).toThrow();
    expect(() => db.db.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?)').run('bad-fk', 'Bad', 'missing', 'owner', 'Active', 'High', null)).toThrow();
    expect(() => db.db.prepare('INSERT INTO applications VALUES (?, ?, ?, ?, ?, ?, ?)').run('bad-score', 'Bad', 'seg-a', 'owner', 'Active', 'High', 101)).toThrow();
    expect(() => db.db.prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)').run('dupe', 'reader@example.test', 'viewer', 'hash')).toThrow();
    expect(() => db.db.prepare('INSERT INTO user_segments VALUES (?, ?)').run('missing', 'seg-a')).toThrow();
    expect(db.db.prepare('SELECT * FROM applications ORDER BY id').all()).toEqual(before);
    db.db.prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)').run('cascade', 'cascade@example.test', 'viewer', 'hash');
    db.db.prepare('INSERT INTO user_segments VALUES (?, ?)').run('cascade', 'seg-a');
    db.db.prepare('DELETE FROM users WHERE id = ?').run('cascade');
    expect(db.db.prepare('SELECT * FROM user_segments WHERE user_id = ?').all('cascade')).toEqual([]);
    expect(db.db.prepare('SELECT * FROM user_segments WHERE user_id = ?').all('reader')).toHaveLength(1);
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
