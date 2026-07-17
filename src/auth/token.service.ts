import { Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'node:crypto';
import { Env } from '../config/env.schema';

enum TokenType {
  ACCESS = 'access',
  REFRESH = 'refresh',
}

@Injectable()
export class TokenService {
  constructor(
    private jwt: JwtService,
    private config: ConfigService<Env, true>,
  ) {}

  async signAccess(userId: string) {
    const payload = {
      sub: userId,
      type: TokenType.ACCESS,
    };

    const signOptions: JwtSignOptions = {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN'),
    };

    return this.jwt.signAsync(payload, signOptions);
  }

  async signRefresh(userId: string) {
    const payload = {
      sub: userId,
      type: TokenType.REFRESH,
      jti: randomUUID(),
    };

    const signOptions: JwtSignOptions = {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN'),
    };

    return this.jwt.signAsync(payload, signOptions);
  }

  async verifyAccess(token: string) {
    const { sub, type } = await this.jwt.verifyAsync(token, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
    });

    if (!sub || !type) {
      throw new Error('Missing JWT claim');
    }

    if (type !== TokenType.ACCESS) {
      throw new Error('Wrong JWT type');
    }

    return { sub: sub };
  }

  async verifyRefresh(token: string) {
    const { sub, type, jti } = await this.jwt.verifyAsync(token, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
    });

    if (!sub || !type || !jti) {
      throw new Error('Missing JWT claim');
    }

    if (type !== TokenType.REFRESH) {
      throw new Error('Wrong JWT type');
    }

    return { sub: sub, jti: jti };
  }

  hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
