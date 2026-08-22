import { InventoryTransactionType } from '../generated/prisma/enums';

export type Bucket = 'availableQuantity' | 'sampleQuantity' | 'damagedQuantity';
export type Effect =
  | {
      kind: 'delta';
      deltas: { field: Bucket; sign: 1 | -1 }[];
      primaryBucket: Bucket;
    }
  | { kind: 'set'; field: 'availableQuantity' };

const availableQuantity: Bucket = 'availableQuantity';
const sampleQuantity: Bucket = 'sampleQuantity';
const damagedQuantity: Bucket = 'damagedQuantity';

const inc = (f: Bucket): Effect => ({
  kind: 'delta',
  deltas: [{ field: f, sign: 1 }],
  primaryBucket: f,
});

const dec = (f: Bucket): Effect => ({
  kind: 'delta',
  deltas: [{ field: f, sign: -1 }],
  primaryBucket: f,
});

export const EFFECTS: Record<InventoryTransactionType, Effect> = {
  INITIAL_STOCK: inc(availableQuantity),
  RESTOCK: inc(availableQuantity),
  TRANSFER_IN: inc(availableQuantity),
  CUSTOMER_RETURN: inc(availableQuantity),
  SALE: dec(availableQuantity),
  TRANSFER_OUT: dec(availableQuantity),
  RETURN: dec(availableQuantity),
  ADJUSTMENT: { kind: 'set', field: availableQuantity },
  CUSTOMER_DAMAGED_RETURN: inc(damagedQuantity),
  BREAKAGE: {
    kind: 'delta',
    deltas: [
      { field: availableQuantity, sign: -1 },
      { field: damagedQuantity, sign: 1 },
    ],
    primaryBucket: availableQuantity,
  },
  DAMAGED_DISPOSAL: dec(damagedQuantity),
  DAMAGED_RETURN: dec(damagedQuantity),
  SAMPLE_ALLOCATION: {
    kind: 'delta',
    deltas: [
      { field: availableQuantity, sign: -1 },
      { field: sampleQuantity, sign: 1 },
    ],
    primaryBucket: availableQuantity,
  },
  SAMPLE_TRANSFER_IN: inc(sampleQuantity),
  SAMPLE_TRANSFER_OUT: dec(sampleQuantity),
  SAMPLE_RETURN: dec(sampleQuantity),
  SAMPLE_DISPOSAL: dec(sampleQuantity),
};
