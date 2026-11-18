/** Wire the identity API and public liveness endpoint. */
import { Controller, Get, Module } from '@nestjs/common';
import { Database } from './database';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';

/** Report process liveness without requiring credentials. */
@Controller('api')
export class HealthController {
  /** Return a minimal liveness response. */
  @Get('health')
  health(): { status: string } { return { status: 'ok' }; }
}

/** Register identity providers for this application. */
@Module({ controllers: [HealthController, AuthController], providers: [Database, AuthService, AuthGuard] })
export class AppModule {}
