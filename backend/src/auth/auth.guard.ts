/** Protect endpoints with a verified, currently active identity. */
import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AuthService, AuthUser } from './auth.service';

export interface AuthenticatedRequest extends Request { user: AuthUser }

/** Attach the current database-backed identity to an authenticated request. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /** Reject invalid sessions before the controller executes. */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.user = this.auth.authenticate(request.headers.authorization);
    return true;
  }
}
