import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthProfile } from '../types/auth-profile';

export const CurrentProfile = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthProfile => {
    const request = ctx.switchToHttp().getRequest();
    return request.profile;
  },
);
