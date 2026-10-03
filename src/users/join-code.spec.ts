import { InternalServerErrorException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import {
  JOIN_CODE_PATTERN,
  generateJoinCode,
  generateUniqueJoinCode,
  normalizeJoinCode,
} from './join-code';

// Replace only randomInt so tests can choose the "random" draws; everything
// else in node:crypto stays real.
jest.mock('node:crypto', () => ({
  ...jest.requireActual('node:crypto'),
  randomInt: jest.fn(),
}));
const randomIntMock = randomInt as unknown as jest.Mock;
const realRandomInt = jest.requireActual('node:crypto').randomInt;

describe('generateJoinCode', () => {
  beforeEach(() => {
    randomIntMock.mockImplementation(realRandomInt);
  });

  it('is exactly 8 digits', () => {
    expect(generateJoinCode()).toMatch(/^\d{8}$/);
  });

  it('draws from 0–99,999,999 and left-pads small numbers', () => {
    randomIntMock.mockReturnValue(4207);

    expect(generateJoinCode()).toBe('00004207');
    expect(randomIntMock).toHaveBeenCalledWith(0, 100_000_000);
  });

  it('gives different codes across many draws', () => {
    const codes = new Set(
      Array.from({ length: 200 }, () => generateJoinCode()),
    );

    expect(codes.size).toBeGreaterThan(195); // collisions possible, but rare
  });
});

describe('generateUniqueJoinCode', () => {
  let prisma: { company: { findUnique: jest.Mock } };

  beforeEach(() => {
    prisma = { company: { findUnique: jest.fn().mockResolvedValue(null) } };
  });

  it('returns the first draw when no company uses it', async () => {
    randomIntMock.mockReturnValue(48291307);

    await expect(generateUniqueJoinCode(prisma as any)).resolves.toBe(
      '48291307',
    );
    expect(prisma.company.findUnique).toHaveBeenCalledWith({
      where: { joinCode: '48291307' },
      select: { id: true },
    });
  });

  it('redraws when a code is already taken', async () => {
    randomIntMock.mockReturnValueOnce(11111111).mockReturnValueOnce(22222222);
    prisma.company.findUnique
      .mockResolvedValueOnce({ id: 'other-company' }) // 11111111 taken
      .mockResolvedValueOnce(null); // 22222222 free

    await expect(generateUniqueJoinCode(prisma as any)).resolves.toBe(
      '22222222',
    );
    expect(prisma.company.findUnique).toHaveBeenCalledTimes(2);
  });

  it('gives up after 5 taken draws instead of looping forever', async () => {
    randomIntMock.mockReturnValue(11111111);
    prisma.company.findUnique.mockResolvedValue({ id: 'other-company' });

    await expect(generateUniqueJoinCode(prisma as any)).rejects.toThrow(
      InternalServerErrorException,
    );
    expect(prisma.company.findUnique).toHaveBeenCalledTimes(5);
  });
});

describe('normalizeJoinCode', () => {
  it.each([
    ['4829 1307', '48291307'],
    ['4829-1307', '48291307'],
    [' 48291307 ', '48291307'],
  ])('%p → %p', (typed, stored) => {
    expect(normalizeJoinCode(typed)).toBe(stored);
  });

  it('passes non-strings through for the validator to reject', () => {
    expect(normalizeJoinCode(48291307)).toBe(48291307);
  });
});

describe('JOIN_CODE_PATTERN', () => {
  it('accepts exactly 8 digits', () => {
    expect(JOIN_CODE_PATTERN.test('48291307')).toBe(true);
    expect(JOIN_CODE_PATTERN.test('00004207')).toBe(true);
  });

  it.each([
    ['7 digits', '4829130'],
    ['9 digits', '482913071'],
    ['letters', '4829130A'],
    ['the old INV- format', 'INV-3FA91C07B2DE'],
    ['unnormalized spaces', '4829 1307'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(JOIN_CODE_PATTERN.test(value)).toBe(false);
  });
});
