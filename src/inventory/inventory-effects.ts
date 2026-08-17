import { InventoryTransactionType } from '../generated/prisma/enums';

export type Bucket = 'availableQuantity' | 'sampleQuantity' | 'damagedQuantity';
export type Effect =
  | {
      kind: 'delta';
      deltas: { field: Bucket; sign: 1 | -1 }[];
      primary: Bucket;
    }
  | { kind: 'set'; field: 'availableQuantity' };

const avail: Bucket = 'availableQuantity';
const smp: Bucket = 'sampleQuantity';
const dmg: Bucket = 'damagedQuantity';

const inc = (f: Bucket): Effect => ({
  kind: 'delta',
  deltas: [{ field: f, sign: 1 }],
  primary: f,
});

const dec = (f: Bucket): Effect => ({
  kind: 'delta',
  deltas: [{ field: f, sign: -1 }],
  primary: f,
});

export const EFFECTS: Record<InventoryTransactionType, Effect> = {
  INITIAL_STOCK: inc(avail),
  RESTOCK: inc(avail),
  TRANSFER_IN: inc(avail),
  CUSTOMER_RETURN: inc(avail),
  SALE: dec(avail),
  TRANSFER_OUT: dec(avail),
  RETURN: dec(avail),
  ADJUSTMENT: { kind: 'set', field: avail },
  CUSTOMER_DAMAGED_RETURN: inc(dmg),
  BREAKAGE: {
    kind: 'delta',
    deltas: [
      { field: avail, sign: -1 },
      { field: dmg, sign: 1 },
    ],
    primary: avail,
  },
  DAMAGED_DISPOSAL: dec(dmg),
  DAMAGED_RETURN: dec(dmg),
  SAMPLE_ALLOCATION: {
    kind: 'delta',
    deltas: [
      { field: avail, sign: -1 },
      { field: smp, sign: 1 },
    ],
    primary: avail,
  },
  SAMPLE_TRANSFER_IN: inc(smp),
  SAMPLE_TRANSFER_OUT: dec(smp),
  SAMPLE_RETURN: dec(smp),
  SAMPLE_DISPOSAL: dec(smp),
};
