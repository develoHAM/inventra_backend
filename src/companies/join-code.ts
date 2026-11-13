import { InternalServerErrorException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';

/** Exactly 8 digits — the only join code format. */
export const JOIN_CODE_PATTERN = /^\d{8}$/;

const MAX_DRAWS = 5;

/** 8 digits, e.g. '48291307' — easy to read aloud, type, and handwrite. */
export function generateJoinCode(): string {
  return randomInt(0, 100_000_000).toString().padStart(8, '0');
}

/**
 * A code no company uses yet. With 10^8 codes a draw can collide with an
 * existing company's, so redraw; the unique index backstops the tiny
 * check-then-write race.
 */
export async function generateUniqueJoinCode(
  prisma: Prisma.TransactionClient,
): Promise<string> {
  for (let draw = 1; draw <= MAX_DRAWS; draw += 1) {
    const joinCode = generateJoinCode();
    const taken = await prisma.company.findUnique({
      where: { joinCode: joinCode },
      select: { id: true },
    });
    if (!taken) return joinCode;
  }
  throw new InternalServerErrorException(
    'Could not generate a unique join code',
  );
}

/**
 * class-transformer hook: '4829 1307' / '4829-1307' → '48291307'.
 * Non-strings pass through so the validator can reject them with a 400.
 */
export function normalizeJoinCode(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/[-\s]/g, '') : value;
}
