import { Injectable } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'node:crypto';
import { Env } from '../config/env.schema';

enum TokenType {
  ACCESS = 'access',
  REFRESH = 'refresh',
}

/** The claims we sign (absent = a token we didn't make; verify rejects it). */
type TokenClaims = {
  sub?: string;
  pid?: string;
  type?: TokenType;
  jti?: string;
};

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * `sub` = the account (the person); `pid` = the company profile the
   * session has open. No profile open → no `pid` claim at all.
   */
  async signAccess(session: { accountId: string; profileId: string | null }) {
    const payload = {
      sub: session.accountId,
      ...(session.profileId !== null ? { pid: session.profileId } : {}),
      type: TokenType.ACCESS,
    };

    const signOptions: JwtSignOptions = {
      secret: this.config.get('JWT_ACCESS_SECRET'),
      expiresIn: this.config.get('JWT_ACCESS_EXPIRES_IN'),
    };

    return this.jwt.signAsync(payload, signOptions);
  }

  /** Names only the account: the session's row remembers which profile is open. */
  async signRefresh(accountId: string) {
    const jti = randomUUID();

    const payload = {
      sub: accountId,
      type: TokenType.REFRESH,
      jti: jti,
    };

    const signOptions: JwtSignOptions = {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRES_IN'),
    };

    const token = await this.jwt.signAsync(payload, signOptions);

    const { exp } = this.jwt.decode(token); // exp is seconds since epoch
    return { token: token, jti: jti, expiresAt: new Date(exp * 1000) };
  }

  async verifyAccess(
    token: string,
  ): Promise<{ accountId: string; profileId: string | null }> {
    const { sub, pid, type } = await this.jwt.verifyAsync<TokenClaims>(token, {
      secret: this.config.get('JWT_ACCESS_SECRET'),
    });

    if (!sub || !type) throw new Error('Missing JWT claim');

    if (type !== TokenType.ACCESS) throw new Error('Wrong JWT type');

    return { accountId: sub, profileId: pid ?? null };
  }

  async verifyRefresh(
    token: string,
  ): Promise<{ accountId: string; jti: string }> {
    const { sub, type, jti } = await this.jwt.verifyAsync<TokenClaims>(token, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
    });

    if (!sub || !type || !jti) throw new Error('Missing JWT claim');

    if (type !== TokenType.REFRESH) throw new Error('Wrong JWT type');

    return { accountId: sub, jti: jti };
  }

  hashToken(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }
}
