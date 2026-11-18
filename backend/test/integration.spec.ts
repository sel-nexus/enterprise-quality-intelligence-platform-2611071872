/** Cross-feature HTTP journeys against a fresh, file-backed SQLite database. */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database';

let directory: string;
let app: INestApplication;
let db: Database;
let admin: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const credentials = { email: 'admin@example.test', password: 'correct-local-password' };

beforeEach(async () => {
  directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-integration-'));
  process.env.NODE_ENV = 'test'; process.env.DEV_LOGIN_ENABLED = 'true';
  process.env.DEV_ADMIN_EMAIL = credentials.email; process.env.DEV_ADMIN_PASSWORD = credentials.password;
  process.env.SESSION_SECRET = 'test-secret-long-enough-for-signing-sessions';
  process.env.DATABASE_PATH = join(directory, 'integration.sqlite');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication(); await app.init(); db = app.get(Database);
  admin = (await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(200)).body.token;
});
afterEach(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

describe('identity, inventory and reporting integration', () => {
  it('propagates API assignment and role changes to inventory, reporting and export', async () => {
    for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) await request(app.getHttpServer()).post('/api/v1/segments').set(auth(admin)).send({ id, name }).expect(201);
    for (const [id, segmentId, qualityScore] of [['app-a', 'alpha', 50], ['app-b', 'beta', null]] as const) {
      await request(app.getHttpServer()).post('/api/v1/applications').set(auth(admin)).send({ id, segmentId, name: id, owner: 'Private', lifecycle: 'Active', criticality: 'High', qualityScore }).expect(201);
    }
    const user = await request(app.getHttpServer()).post('/api/v1/users').set(auth(admin)).send({ email: 'reader@example.test', password: 'reader-password', role: 'viewer', active: true, segments: ['alpha'] }).expect(201);
    const reader = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'reader@example.test', password: 'reader-password' }).expect(200)).body.token;
    expect((await request(app.getHttpServer()).get('/api/v1/applications').set(auth(reader)).expect(200)).body.items.map((a: { id: string }) => a.id)).toEqual(['app-a']);
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(reader)).expect(200)).body).toMatchObject({ segmentCount: 1, applicationCount: 1, scoredApplicationCount: 1, segments: [{ id: 'alpha', name: 'Alpha', applicationCount: 1 }] });
    await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(reader)).expect(403);
    await request(app.getHttpServer()).patch(`/api/v1/users/${user.body.id}`).set(auth(admin)).send({ segments: ['beta'] }).expect(200);
    expect((await request(app.getHttpServer()).get('/api/v1/applications').set(auth(reader)).expect(200)).body.items.map((a: { id: string }) => a.id)).toEqual(['app-b']);
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(reader)).expect(200)).body).toMatchObject({ segmentCount: 1, applicationCount: 1, scoredApplicationCount: 0, unknownScoreCount: 1, segments: [{ id: 'beta', name: 'Beta', applicationCount: 1 }] });
    await request(app.getHttpServer()).patch(`/api/v1/users/${user.body.id}`).set(auth(admin)).send({ role: 'executive' }).expect(200);
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(reader)).expect(200)).body).toMatchObject({ segmentCount: 2, applicationCount: 2 });
    const csv = await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(reader)).expect(200);
    expect(csv.text).toContain('"app-a"'); expect(csv.text).toContain('"app-b"'); expect(csv.text).not.toContain('Private');
    await request(app.getHttpServer()).patch(`/api/v1/users/${user.body.id}`).set(auth(admin)).send({ role: 'viewer', segments: [] }).expect(200);
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(reader)).expect(200)).body).toEqual({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
    await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(reader)).expect(403);
    expect(db.db.prepare('SELECT * FROM user_segments WHERE user_id = ?').all(user.body.id)).toEqual([]);
    expect(db.db.prepare('SELECT id, segment_id FROM applications ORDER BY id').all()).toEqual([{ id: 'app-a', segment_id: 'alpha' }, { id: 'app-b', segment_id: 'beta' }]);
    const history = db.db.prepare('SELECT actor_id, target_id, old_values, new_values FROM user_audit WHERE target_id = ? ORDER BY id').all(user.body.id) as unknown as { actor_id: string; target_id: string; old_values: string | null; new_values: string }[];
    expect(history).toHaveLength(4);
    expect(history.every(row => row.target_id === user.body.id && row.actor_id !== user.body.id)).toBe(true);
    expect(JSON.parse(history[3].new_values)).toMatchObject({ role: 'viewer', segments: [] });
    expect(db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.db.prepare('SELECT us.* FROM user_segments us LEFT JOIN segments s ON s.id = us.segment_id LEFT JOIN users u ON u.id = us.user_id WHERE s.id IS NULL OR u.id IS NULL').all()).toEqual([]);
  });

  it('propagates an application move, rename and score to scoped reports and export', async () => {
    for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) await request(app.getHttpServer()).post('/api/v1/segments').set(auth(admin)).send({ id, name }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/applications').set(auth(admin)).send({ id: 'app-a', name: 'Original', segmentId: 'alpha', owner: 'Private', lifecycle: 'Active', criticality: 'High', qualityScore: null }).expect(201);
    const readers: { id: string; token: string; segment: string }[] = [];
    for (const segment of ['alpha', 'beta']) {
      const email = `${segment}@example.test`;
      const created = await request(app.getHttpServer()).post('/api/v1/users').set(auth(admin)).send({ email, password: 'reader-password', role: 'viewer', active: true, segments: [segment] }).expect(201);
      const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email, password: 'reader-password' }).expect(200);
      readers.push({ id: created.body.id, token: login.body.token, segment });
    }
    const [oldScope, newScope] = readers;
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(oldScope.token)).expect(200)).body).toMatchObject({ applicationCount: 1, scoredApplicationCount: 0, unknownScoreCount: 1, segments: [{ id: 'alpha', name: 'Alpha', applicationCount: 1 }] });
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(newScope.token)).expect(200)).body).toMatchObject({ applicationCount: 0, segments: [{ id: 'beta', name: 'Beta', applicationCount: 0 }] });
    const updated = await request(app.getHttpServer()).patch('/api/v1/applications/app-a').set(auth(admin)).send({ segmentId: 'beta', name: 'Moved application', qualityScore: 83 }).expect(200);
    expect(updated.body).toMatchObject({ id: 'app-a', segmentId: 'beta', name: 'Moved application', qualityScore: 83 });
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(oldScope.token)).expect(200)).body).toMatchObject({ applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [{ id: 'alpha', name: 'Alpha', applicationCount: 0 }] });
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(newScope.token)).expect(200)).body).toMatchObject({ applicationCount: 1, scoredApplicationCount: 1, unknownScoreCount: 0, segments: [{ id: 'beta', name: 'Beta', applicationCount: 1 }] });
    expect((await request(app.getHttpServer()).get('/api/v1/applications').set(auth(oldScope.token)).expect(200)).body.items).toEqual([]);
    expect((await request(app.getHttpServer()).get('/api/v1/applications').set(auth(newScope.token)).expect(200)).body.items).toMatchObject([{ id: 'app-a', segmentId: 'beta', name: 'Moved application', qualityScore: 83 }]);
    const csv = await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(admin)).expect(200);
    expect(csv.text).toContain('"Internal","app-a","Moved application","beta","Active","High","83"');
    expect(csv.text).not.toContain('Original'); expect(csv.text).not.toContain('Private');
    expect(db.db.prepare('SELECT id, name, segment_id, quality_score FROM applications WHERE id = ?').get('app-a')).toEqual({ id: 'app-a', name: 'Moved application', segment_id: 'beta', quality_score: 83 });
    for (const reader of readers) expect(db.db.prepare('SELECT segment_id FROM user_segments WHERE user_id = ?').all(reader.id)).toEqual([{ segment_id: reader.segment }]);
    expect(db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('fails overview and export on a real inventory read error and recovers after restoration', async () => {
    await request(app.getHttpServer()).post('/api/v1/segments').set(auth(admin)).send({ id: 'alpha', name: 'Alpha' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/applications').set(auth(admin)).send({ id: 'app-a', name: 'A', segmentId: 'alpha', owner: 'Private', lifecycle: 'Active', criticality: 'High', qualityScore: 42 }).expect(201);
    const before = db.db.prepare('SELECT * FROM applications').all();
    const overview = (await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(admin)).expect(200)).body;
    const csv = (await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(admin)).expect(200)).text;
    db.db.exec('ALTER TABLE applications RENAME TO applications_unavailable');
    try {
      await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(admin)).expect(500);
      await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(admin)).expect(500);
    } finally { db.db.exec('ALTER TABLE applications_unavailable RENAME TO applications'); }
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(admin)).expect(200)).body).toEqual(overview);
    expect((await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(admin)).expect(200)).text).toEqual(csv);
    expect(db.db.prepare('SELECT * FROM applications').all()).toEqual(before);
    expect(db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('preserves scope and report data when assignment or inventory writes fail', async () => {
    await request(app.getHttpServer()).post('/api/v1/segments').set(auth(admin)).send({ id: 'alpha', name: 'Alpha' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/applications').set(auth(admin)).send({ id: 'app-a', name: 'A', segmentId: 'alpha', owner: 'Private', lifecycle: 'Active', criticality: 'High' }).expect(201);
    const user = await request(app.getHttpServer()).post('/api/v1/users').set(auth(admin)).send({ email: 'reader@example.test', password: 'reader-password', role: 'viewer', active: true, segments: ['alpha'] }).expect(201);
    const reader = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'reader@example.test', password: 'reader-password' }).expect(200)).body.token;
    const beforeAudit = db.db.prepare('SELECT * FROM user_audit ORDER BY id').all();
    await request(app.getHttpServer()).patch(`/api/v1/users/${user.body.id}`).set(auth(admin)).send({ segments: ['missing'] }).expect(400);
    await request(app.getHttpServer()).post('/api/v1/applications').set(auth(admin)).send({ id: 'invalid', name: 'Invalid', segmentId: 'missing', owner: 'Private', lifecycle: 'Active', criticality: 'High' }).expect(400);
    await request(app.getHttpServer()).patch('/api/v1/applications/app-a').set(auth(reader)).send({ name: 'Unauthorized' }).expect(403);
    db.db.exec("CREATE TRIGGER reject_integration_audit BEFORE INSERT ON user_audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    try { await request(app.getHttpServer()).patch(`/api/v1/users/${user.body.id}`).set(auth(admin)).send({ role: 'executive', segments: [] }).expect(500); }
    finally { db.db.exec('DROP TRIGGER reject_integration_audit'); }
    expect((await request(app.getHttpServer()).get('/api/v1/applications').set(auth(reader)).expect(200)).body.items).toMatchObject([{ id: 'app-a', name: 'A', segmentId: 'alpha' }]);
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(reader)).expect(200)).body).toMatchObject({ segmentCount: 1, applicationCount: 1 });
    await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(reader)).expect(403);
    const csv = await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(admin)).expect(200);
    expect(csv.text).toContain('"app-a"'); expect(csv.text).not.toContain('invalid');
    expect(db.db.prepare('SELECT role, active FROM users WHERE id = ?').get(user.body.id)).toMatchObject({ role: 'viewer', active: 1 });
    expect(db.db.prepare('SELECT segment_id FROM user_segments WHERE user_id = ?').all(user.body.id)).toEqual([{ segment_id: 'alpha' }]);
    expect(db.db.prepare('SELECT id, segment_id FROM applications').all()).toEqual([{ id: 'app-a', segment_id: 'alpha' }]);
    expect(db.db.prepare('SELECT * FROM user_audit ORDER BY id').all()).toEqual(beforeAudit);
    expect(db.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.db.prepare('SELECT us.* FROM user_segments us LEFT JOIN segments s ON s.id = us.segment_id LEFT JOIN users u ON u.id = us.user_id WHERE s.id IS NULL OR u.id IS NULL').all()).toEqual([]);
  });
});
