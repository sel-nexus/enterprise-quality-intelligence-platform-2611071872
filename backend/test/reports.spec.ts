/** Exercise reporting against a real HTTP application and file-backed SQLite. */
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
import { ReportsService } from '../src/reports/reports.service';

const directory = mkdtempSync(join(process.platform === 'linux' ? '/tmp' : tmpdir(), 'eqip-reports-'));
let app: INestApplication;
let db: Database;
let admin: string;
let executive: string;
let viewer: string;
let empty: string;
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DEV_LOGIN_ENABLED = 'true';
  process.env.DEV_ADMIN_EMAIL = 'admin@example.test';
  process.env.DEV_ADMIN_PASSWORD = 'correct-local-password';
  process.env.SESSION_SECRET = 'test-secret-long-enough-for-signing-sessions';
  process.env.DATABASE_PATH = join(directory, 'reports.sqlite');
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = module.createNestApplication();
  await app.init();
  db = app.get(Database);
  for (const [id, role] of [['leader', 'executive'], ['reader', 'viewer'], ['empty', 'viewer']]) {
    db.db.prepare('INSERT INTO users (id, email, role, password_hash) VALUES (?, ?, ?, ?)').run(id, `${id}@example.test`, role, 'unused');
  }
  admin = (await request(app.getHttpServer()).post('/api/v1/auth/login').send({ email: 'admin@example.test', password: 'correct-local-password' }).expect(200)).body.token;
  executive = jwt.sign({ sub: 'leader' }, process.env.SESSION_SECRET!);
  viewer = jwt.sign({ sub: 'reader', role: 'admin', segments: ['b'] }, process.env.SESSION_SECRET!);
  empty = jwt.sign({ sub: 'empty' }, process.env.SESSION_SECRET!);
});
afterAll(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

describe('scoped reports', () => {
  it('reports no accessible segments for an unassigned viewer', () => {
    expect(app.get(ReportsService).overview({ id: 'empty', email: 'empty@example.test', role: 'viewer', segments: [] })).toEqual({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
  });

  it('returns empty persisted inventory and a header-only CSV', async () => {
    const overview = await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(admin)).expect(200);
    expect(overview.body).toEqual({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
    const csv = await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(admin)).expect(200);
    expect(csv.text.trim().split('\r\n')).toHaveLength(1);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['cache-control']).toBe('no-store');
  });

  it('requires authentication and forbids non-enterprise export even with spoofed inputs', async () => {
    await request(app.getHttpServer()).get('/api/v1/reports/overview').expect(401);
    await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set('X-Role', 'admin').expect(401);
    await request(app.getHttpServer()).get('/api/v1/reports/applications.csv?role=admin&segment=b').set(auth(viewer)).set('X-Role', 'admin').expect(403);
    expect(() => app.get(ReportsService).applicationsCsv({ id: 'reader', email: 'reader@example.test', role: 'viewer', segments: ['a'] })).toThrow();
  });

  it('uses persisted inventory and current assignments for counts and export', async () => {
    for (const segment of [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]) await request(app.getHttpServer()).post('/api/v1/segments').set(auth(admin)).send(segment).expect(201);
    db.db.prepare('INSERT INTO user_segments VALUES (?, ?)').run('reader', 'a');
    await request(app.getHttpServer()).post('/api/v1/applications').set(auth(admin)).send({ id: 'one', name: '=SUM(1,2)', segmentId: 'a', owner: 'Private owner', lifecycle: '+Active', criticality: 'High' }).expect(201);
    await request(app.getHttpServer()).post('/api/v1/applications').set(auth(admin)).send({ id: 'two', name: 'Billing "quoted"', segmentId: 'b', owner: 'Other owner', lifecycle: 'Active', criticality: 'High', qualityScore: 80 }).expect(201);
    const scoped = await request(app.getHttpServer()).get('/api/v1/reports/overview?segment=b&role=admin').set(auth(viewer)).expect(200);
    expect(scoped.body).toEqual({ segmentCount: 1, applicationCount: 1, scoredApplicationCount: 0, unknownScoreCount: 1, segments: [{ id: 'a', name: 'Alpha', applicationCount: 1 }] });
    const service = app.get(ReportsService);
    expect(service.overview({ id: 'reader', email: '', role: 'viewer', segments: ['a'] })).toEqual(scoped.body);
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(empty)).expect(200)).body.applicationCount).toBe(0);
    for (const token of [admin, executive]) {
      const result = await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(token)).expect(200);
      expect(result.body).toMatchObject({ segmentCount: 2, applicationCount: 2, scoredApplicationCount: 1, unknownScoreCount: 1 });
      const csv = await request(app.getHttpServer()).get('/api/v1/reports/applications.csv').set(auth(token)).expect(200);
      expect(csv.text).toContain('"Internal","one","\'=SUM(1,2)","a","\'+Active","High",""');
      expect(csv.text).toContain('"Billing ""quoted"""');
      expect(csv.text).not.toContain('Private owner');
      expect(csv.text).toContain('"80"');
    }
    db.db.prepare('DELETE FROM user_segments WHERE user_id = ?').run('reader');
    expect((await request(app.getHttpServer()).get('/api/v1/reports/overview').set(auth(viewer)).expect(200)).body).toEqual({ segmentCount: 0, applicationCount: 0, scoredApplicationCount: 0, unknownScoreCount: 0, segments: [] });
  });
});
