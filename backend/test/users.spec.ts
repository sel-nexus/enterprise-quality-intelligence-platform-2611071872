/** Exercise user administration through HTTP and real file-backed SQLite. */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module';
import { Database } from '../src/database';
import { UsersService } from '../src/users/users.service';

const directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-users-'));
const credentials = { email: 'admin@example.test', password: 'correct-local-password' };
const newUser = { email: 'reader@example.test', password: 'reader-local-password', role: 'viewer', active: true, segments: ['alpha'] };
let app: INestApplication;
let db: Database;
let token: string;
let reader: string;
let readerId: string;
let adminId: string;
const auth = (value: string) => ({ Authorization: `Bearer ${value}` });

beforeAll(async () => {
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
});
afterAll(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

describe('user administration', () => {
  it('migrates and creates an account with assigned segments and no exposed secrets', async () => {
    expect(db.db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
    const created = await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(newUser).expect(201);
    expect(created.body).toMatchObject({ email: newUser.email, role: 'viewer', active: true, segments: ['alpha'] });
    expect(JSON.stringify(created.body)).not.toContain('password');
    readerId = created.body.id;
    const login = await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: newUser.email, password: newUser.password }).expect(200);
    reader = login.body.token;
    expect((await request(app.getHttpServer()).get('/api/v1/segments').set(auth(reader)).expect(200)).body.items).toEqual([{ id: 'alpha', name: 'Alpha' }]);
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
    const before = (await request(app.getHttpServer()).get('/api/v1/users/audit').set(auth(token))).body.items.length;
    for (const body of [{}, { role: 'root' }, { active: 1 }, { segments: ['missing'] }, { segments: ['alpha', 'alpha'] }, { role: null }, { password: 'secret' }]) {
      await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send(body).expect(400);
    }
    await request(app.getHttpServer()).patch('/api/v1/users/missing').set(auth(token)).send({ active: false }).expect(404);
    await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(newUser).expect(409);
    for (const body of [{ ...newUser, email: 'bad' }, { ...newUser, email: 'other@example.test', password: 'short' }, { ...newUser, email: 'other@example.test', role: 'root' }, { ...newUser, email: 'other@example.test', segments: ['missing'] }]) {
      await request(app.getHttpServer()).post('/api/v1/users').set(auth(token)).send(body).expect(400);
    }
    expect((await request(app.getHttpServer()).get('/api/v1/users/audit').set(auth(token))).body.items).toHaveLength(before);
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
  it('revokes sessions permanently when disabled, including after reactivation', async () => {
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ active: false }).expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(reader)).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: newUser.email, password: newUser.password }).expect(401);
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ active: true }).expect(200);
    await request(app.getHttpServer()).get('/api/v1/auth/me').set(auth(reader)).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: newUser.email, password: newUser.password }).expect(200);
  });
  it('rolls back access updates if audit insertion fails', async () => {
    db.db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON user_audit BEGIN SELECT RAISE(ABORT, 'audit failed'); END");
    await request(app.getHttpServer()).patch(`/api/v1/users/${readerId}`).set(auth(token)).send({ role: 'vendor', segments: ['alpha'] }).expect(500);
    db.db.exec('DROP TRIGGER reject_audit');
    const row = (await request(app.getHttpServer()).get('/api/v1/users').set(auth(token))).body.items.find((u: { id: string }) => u.id === readerId);
    expect(row).toMatchObject({ role: 'engineer', segments: ['beta'] });
  });
});
