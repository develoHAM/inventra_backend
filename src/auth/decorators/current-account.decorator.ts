import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthAccount } from '../types/auth-account';

/** The signed-in account (`request.account`, set by JwtAuthGuard). */
export const CurrentAccount = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthAccount => {
    const request = ctx.switchToHttp().getRequest<{ account: AuthAccount }>();
    return request.account;
  },
);
