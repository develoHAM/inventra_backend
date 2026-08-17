import { EFFECTS } from './inventory-effects';
import { InventoryTransactionType } from '../generated/prisma/enums';

describe('EFFECTS', () => {
  it('maps every transaction type (the table is total)', () => {
    for (const t of Object.values(InventoryTransactionType)) {
      expect(EFFECTS[t]).toBeDefined();
    }
  });

  it('SALE decrements available', () => {
    expect(EFFECTS.SALE).toEqual({
      kind: 'delta',
      deltas: [{ field: 'availableQuantity', sign: -1 }],
      primary: 'availableQuantity',
    });
  });

  it('BREAKAGE moves available -> damaged, primary = available (guarded side)', () => {
    expect(EFFECTS.BREAKAGE).toEqual({
      kind: 'delta',
      deltas: [
        { field: 'availableQuantity', sign: -1 },
        { field: 'damagedQuantity', sign: 1 },
      ],
      primary: 'availableQuantity',
    });
  });

  it('SAMPLE_ALLOCATION moves available -> sample', () => {
    expect(EFFECTS.SAMPLE_ALLOCATION).toEqual({
      kind: 'delta',
      deltas: [
        { field: 'availableQuantity', sign: -1 },
        { field: 'sampleQuantity', sign: 1 },
      ],
      primary: 'availableQuantity',
    });
  });

  it('ADJUSTMENT is an absolute set on available', () => {
    expect(EFFECTS.ADJUSTMENT).toEqual({ kind: 'set', field: 'availableQuantity' });
  });

  it('the decrement is listed first in cross-field transfers (guard before add)', () => {
    for (const t of ['BREAKAGE', 'SAMPLE_ALLOCATION'] as const) {
      const eff = EFFECTS[t];
      expect(eff.kind).toBe('delta');
      if (eff.kind === 'delta') expect(eff.deltas[0].sign).toBe(-1);
    }
  });
});
