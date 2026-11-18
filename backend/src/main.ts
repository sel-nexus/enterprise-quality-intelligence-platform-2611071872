/** Start the HTTP API using tier-local environment configuration. */
import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/** Start the server and allow only the configured direct frontend origin. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bodyParser: true });
  if (process.env.CORS_ORIGIN) app.enableCors({ origin: process.env.CORS_ORIGIN });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch(error => { console.error('API startup failed', error); process.exitCode = 1; });
