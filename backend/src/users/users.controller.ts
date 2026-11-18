/** Expose guarded user administration endpoints. */
import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthenticatedRequest } from '../auth/auth.guard';
import { AuditEntry, ManagedUser, UsersService } from './users.service';

/** Delegate access checks and transactions to the user service. */
@Controller('api/v1/users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  /** List users for administrators. */
  @Get()
  list(@Req() request: AuthenticatedRequest): { items: ManagedUser[] } { return this.users.list(request.user); }

  /** List access changes for administrators. */
  @Get('audit')
  audit(@Req() request: AuthenticatedRequest): { items: AuditEntry[] } { return this.users.history(request.user); }

  /** Create a local-development account. */
  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown): ManagedUser { return this.users.create(request.user, body); }

  /** Update a user's access. */
  @Patch(':id')
  update(@Req() request: AuthenticatedRequest, @Param('id') id: string, @Body() body: unknown): ManagedUser { return this.users.update(request.user, id, body); }
}
