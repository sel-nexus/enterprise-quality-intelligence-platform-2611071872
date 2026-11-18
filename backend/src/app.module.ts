/** Wire the identity API and public liveness endpoint. */
import { Controller, Get, Module } from '@nestjs/common';
import { Database } from './database';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { AuthGuard } from './auth/auth.guard';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';

/** Report process liveness without requiring credentials. */
@Controller('api')
export class HealthController {
  /** Return a minimal liveness response. */
  @Get('health')
  health(): { status: string } { return { status: 'ok' }; }
}

/** Register identity providers for this application. */
@Module({ controllers: [HealthController, AuthController, InventoryController, UsersController, ReportsController], providers: [Database, AuthService, AuthGuard, InventoryService, UsersService, ReportsService] })
export class AppModule {}
