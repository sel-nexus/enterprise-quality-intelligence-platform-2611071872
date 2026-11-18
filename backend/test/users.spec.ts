/** Exercise user administration through HTTP and real file-backed SQLite. */
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
import { UsersService } from '../src/users/users.service';

let directory: string;
const credentials = { email: 'admin@example.test', password: 'correct-local-password' };
const newUser = { email: 'reader@example.test', password: 'reader-local-password', role: 'viewer', active: true, segments: ['alpha'] };
let app: INestApplication;
let db: Database;
let token: string;
let reader: string;
let readerId: string;
let adminId: string;
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });

beforeEach(async () => {
  directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-users-'));
  process.env.NODE_ENV = 'test'; process.env.DEV_LOGIN_ENABLED = 'true';
  process.env.DEV_ADMIN_EMAIL = credentials.email; process.env.DEV_ADMIN_PASSWORD = credentials.password;
  process.env.SESSION_SECRET = 'test-secret-long-enough-for-signing-sessions';
  process.env.DATABASE_PATH = join(directory, 'users.sqlite');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication(); await app.init(); db = app.get(Database);
  const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send(credentials).expect(200);
  token = login.body.token; adminId = login.body.user.id;
  await request(app.getHttpServer()).post('/api/v1/segments').set(auth(token)).send({ id: 'alpha', name: 'Alpha' }).expect(201);
  await request(app.getHttpServer()).post('/api/v1/segments').set(auth(token)).send({ id: 'beta', name: 'Beta' }).expect(201);
  readerId = (await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(newUser).expect(201)).body.id;
  reader = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: newUser.email, password: newUser.password }).expect(200)).body.token;
});
afterEach(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

describe('user administration', () => {
  it('migrates and creates an account with assigned segments and no exposed secrets', async () => {
    expect(db.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    const createdUser = { ...newUser, email: 'created@example.test' };
    const created = await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(createdUser).expect(201);
    expect(created.body).toMatchObject({ email: createdUser.email, role: 'viewer', active: true, segments: ['alpha'] });
    expect(JSON.stringify(created.body)).not.toContain('password');
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: createdUser.email, password: createdUser.password }).expect(200);
    expect((await request(app.getHttpServer()).get('/api/v1/segments').set(auth(login.body.token)).expect(200)).body.items).toEqual([{ id: 'alpha', name: 'Alpha' }]);
    const list = await request(app.getHttpServer()).get('/api/v1/users').set(auth(token)).expect(200);
    expect(list.body.items).toContainEqual(created.body);
    expect(JSON.stringify(list.body)).not.toContain('password');
  });
  it('rejects unauthenticated and non-administrator access at every endpoint', async () => {
    for (const [method, path] of [['get', ''], ['get', '/audit'], ['post', ''], ['patch', '/x']] as const) {
      await request(app.getHttpServer())[method](`/api/v1/users${path}`).send({}).expect(401);
      await request(app.getHttpServer())[method](`/api/v1/users${path}`).set(auth(reader)).set('X-Role', 'admin').send({}).expect(403);
    }
    const service = app.get(UsersService);
    expect(() => service.list({ id: readerId, email: newUser.email, role: 'admin', segments: [] })).toThrow();
  });
  it('validates fields and rejects duplicates and nonexistent records without auditing', async () => {
    const before = (await request(app.getHttpServer()).get('/api/v1/users/audit').set(auth(token)).expect(200)).body.items.length;
    for (const body of [{}, { role: 'root' }, { active: 1 }, { segments: ['missing'] }, { segments: ['alpha', 'alpha'] }, { role: null }, { password: 'secret' }]) {
      await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send(body).expect(400);
    }
    await request(app.getHttpServer()).patch('/api/v1/users/missing').set(auth(token)).send({ active: false }).expect(404);
    await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(newUser).expect(409);
    for (const body of [{ ...newUser, email: 'bad' }, { ...newUser, email: 'other@example.test', password: 'short' }, { ...newUser, email: 'other@example.test', role: 'root' }, { ...newUser, email: 'other@example.test', segments: ['missing'] }]) {
      await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(body).expect(400);
    }
    expect((await request(app.getHttpServer()).get('/api/v1/users/audit').set(auth(token)).expect(200)).body.items).toHaveLength(before);
  });
  it('rejects each missing or malformed account field without creating users or audit records', async () => {
    const beforeUsers = db.db.prepare('SELECT * FROM users ORDER BY id').all();
    const beforeAudit = db.db.prepare('SELECT * FROM user_audit ORDER BY id').all();
    for (const field of ['email', 'password', 'role', 'active', 'segments']) {
      const body: Record<string, unknown> = { ...newUser, email: 'boundary@example.test' }; delete body[field];
      await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(body).expect(400);
    }
    const invalid = [
      { email: null }, { email: ' ' }, { email: `${'a'.repeat(250)}@x.test` },
      { password: null }, { password: '' }, { password: 'x'.repeat(257) },
      { role: null }, { role: 1 }, { active: null }, { active: 'true' },
      { segments: null }, { segments: 'alpha' }, { segments: [null] }, { segments: [''] },
      { segments: ['x'.repeat(81)] }, { segments: ['alpha', 'alpha'] }, { segments: ['missing'] },
      { extra: true },
    ];
    for (const bad of invalid) await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send({ ...newUser, email: 'boundary@example.test', ...bad }).expect(400);
    for (const bad of [{ segments: {} }, { segments: [5] }, { segments: ['x'.repeat(81)] }, { active: 0 }, { role: false }, { unexpected: 1 }]) {
      await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send(bad).expect(400);
    }
    expect(db.db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(beforeUsers);
    expect(db.db.prepare('SELECT * FROM user_audit ORDER BY id').all()).toEqual(beforeAudit);
    const made = await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send({ ...newUser, email: ' LIMIT@EXAMPLE.TEST ', password: 'x'.repeat(256), segments: ['beta', 'alpha'] }).expect(201);
    expect(made.body).toMatchObject({ email: 'limit@example.test', segments: ['alpha', 'beta'] });
    expect(db.db.prepare('SELECT email FROM users WHERE id = ?').get(made.body.id)).toMatchObject({ email: 'limit@example.test' });
    await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send({ ...newUser, email: 'LIMIT@example.test', password: 'x'.repeat(12) }).expect(409);
  });
  it('persists changes, scopes existing sessions and records old and new values', async () => {
    const result = await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ role: 'engineer', segments: ['beta'] }).expect(200);
    expect(result.body).toMatchObject({ role: 'engineer', segments: ['beta'], active: true });
    expect((await request(app.getHttpServer()).get('/api/v1/segments').set(auth(reader)).expect(200)).body.items).toEqual([{ id: 'beta', name: 'Beta' }]);
    const history = (await request(app.getHttpServer()).get('/api/v1/users/audit').set(auth(token)).expect(200)).body.items;
    expect(history[0]).toMatchObject({ actorId: adminId, targetId: readerId, oldValues: { role: 'viewer', segments: ['alpha'] }, newValues: { role: 'engineer', segments: ['beta'] } });
    expect(Date.parse(history[0].occurredAt)).not.toBeNaN();
    expect(JSON.stringify(history)).not.toContain('password');
    expect(JSON.stringify(history)).not.toContain(newUser.password);
  });
  it('protects the final active administrator from demotion and disabling', async () => {
    for (const body of [{ role: 'viewer' }, { active: false }, { role: 'viewer', active: false }]) await request(app.getHttpServer()).patch(`/api/v1/users/${adminId}`).set(auth(token)).send(body).expect(409);
    expect(db.db.prepare('SELECT role, active FROM users WHERE id = ?').get(adminId)).toMatchObject({ role: 'admin', active: 1 });
  });
  it('rejects oversized create and update bodies without changing users, audit or assignments', async () => {
    const users = db.db.prepare('SELECT * FROM users ORDER BY id').all();
    const audit = db.db.prepare('SELECT * FROM user_audit ORDER BY id').all();
    const assignments = db.db.prepare('SELECT * FROM user_segments ORDER BY user_id, segment_id').all();
    await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send({ ...newUser, email: 'large@example.test', password: 'x'.repeat(110_000) }).expect(413);
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ role: 'x'.repeat(110_000) }).expect(413);
    expect(db.db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(users);
    expect(db.db.prepare('SELECT * FROM user_audit ORDER BY id').all()).toEqual(audit);
    expect(db.db.prepare('SELECT * FROM user_segments ORDER BY user_id, segment_id').all()).toEqual(assignments);
  });
  it('does not audit a no-op update, including reordered assignments', async () => {
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ segments: ['alpha', 'beta'] }).expect(200);
    const users = db.db.prepare('SELECT * FROM users ORDER BY id').all();
    const audit = db.db.prepare('SELECT * FROM user_audit ORDER BY id').all();
    const assignments = db.db.prepare('SELECT * FROM user_segments ORDER BY user_id, segment_id').all();
    const result = await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ role: 'viewer', active: true, segments: ['beta', 'alpha'] }).expect(200);
    expect(result.body).toMatchObject({ id: readerId, role: 'viewer', active: true, segments: ['alpha', 'beta'] });
    expect(db.db.prepare('SELECT * FROM users ORDER BY id').all()).toEqual(users);
    expect(db.db.prepare('SELECT * FROM user_audit ORDER BY id').all()).toEqual(audit);
    expect(db.db.prepare('SELECT * FROM user_segments ORDER BY user_id, segment_id').all()).toEqual(assignments);
  });
  it('allows demotion of an administrator when another active administrator remains', async () => {
    const other = await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send({ ...newUser, email: 'other-admin@example.test', role: 'admin' }).expect(201);
    const demoted = await request(app.getHttpServer()).patch(`/api/v1/users/${other.body.id}`).set(auth(token)).send({ role: 'viewer' }).expect(200);
    expect(demoted.body).toMatchObject({ id: other.body.id, role: 'viewer', active: true, segments: ['alpha'] });
    expect(db.db.prepare('SELECT role, active FROM users WHERE id = ?').get(other.body.id)).toEqual({ role: 'viewer', active: 1 });
    expect(db.db.prepare('SELECT role, active FROM users WHERE id = ?').get(adminId)).toEqual({ role: 'admin', active: 1 });
    const history = (await request(app.getHttpServer()).get('/api/v1/users/audit').set(auth(token)).expect(200)).body.items;
    expect(history[0]).toMatchObject({ actorId: adminId, targetId: other.body.id, oldValues: { role: 'admin' }, newValues: { role: 'viewer' } });
  });
  it('revokes sessions permanently when disabled, including after reactivation', async () => {
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ active: false }).expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(reader)).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: newUser.email, password: newUser.password }).expect(401);
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ active: true }).expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(reader)).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: newUser.email, password: newUser.password }).expect(200);
  });
  it('rolls back access updates if audit insertion fails', async () => {
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ role: 'engineer', segments: ['beta'] }).expect(200);
    db.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON user_audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    try { await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ role: 'vendor', segments: ['alpha'] }).expect(500); }
    finally { db.db.exec('DROP TRIGGER reject_audit'); }
    const row = (await request(app.getHttpServer()).get('/api/v1/users').set(auth(token)).expect(200)).body.items.find((u: { id: string }) => u.id === readerId);
    expect(row).toMatchObject({ role: 'engineer', segments: ['beta'] });
  });
});
