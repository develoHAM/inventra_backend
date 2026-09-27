import { StockChange, stockAlertsFrom } from './stock-change';

describe('stockAlertsFrom', () => {
  const change = (
    placementId: number,
    availableBefore: number,
    availableAfter: number,
    targetStockQuantity = 10,
  ): StockChange => ({
    placementId: placementId,
    availableBefore: availableBefore,
    availableAfter: availableAfter,
    targetStockQuantity: targetStockQuantity,
  });

  it('alerts when a write crosses from at/above target to below it', () => {
    expect(stockAlertsFrom([change(1, 12, 7)])).toEqual([
      { placementId: 1, availableQuantity: 7, targetStockQuantity: 10 },
    ]);
  });

  it('alerts when starting exactly AT target and dropping below', () => {
    expect(stockAlertsFrom([change(1, 10, 9)])).toHaveLength(1);
  });

  it('does not alert when stock stays at or above target', () => {
    expect(stockAlertsFrom([change(1, 15, 10)])).toEqual([]);
  });

  it('does not re-alert when stock was already below target (repeat sales)', () => {
    expect(stockAlertsFrom([change(1, 7, 5)])).toEqual([]);
  });

  it('does not alert when stock rises', () => {
    expect(stockAlertsFrom([change(1, 3, 12)])).toEqual([]);
  });

  it('never alerts for a placement with no target (0)', () => {
    expect(stockAlertsFrom([change(1, 5, 0, 0)])).toEqual([]);
  });

  it('fulfill (RELEASE then SALE, same placement) causes NO false alarm when already below target', () => {
    // available 8 < target 10 before the transaction; release lifts to 10, sale drops back to 8.
    // Judged write-by-write, the SALE (10 → 8) would look like a fresh crossing.
    const fulfill = [change(1, 8, 10), change(1, 10, 8)];

    expect(stockAlertsFrom(fulfill)).toEqual([]);
  });

  it('judges a placement by its FIRST before and LAST after across the transaction', () => {
    // 12 → 11 → 6: one crossing overall, reported with the final quantity
    expect(stockAlertsFrom([change(1, 12, 11), change(1, 11, 6)])).toEqual([
      { placementId: 1, availableQuantity: 6, targetStockQuantity: 10 },
    ]);
  });

  it('a temporary dip that recovers within the transaction does not alert', () => {
    expect(stockAlertsFrom([change(1, 12, 6), change(1, 6, 12)])).toEqual([]);
  });

  it('judges several placements independently (e.g. one audit apply)', () => {
    const alerts = stockAlertsFrom([
      change(1, 12, 7), // crosses
      change(2, 12, 11), // stays above
      change(3, 20, 3, 5), // crosses its own target of 5
    ]);

    expect(alerts.map((alert) => alert.placementId)).toEqual([1, 3]);
  });

  it('returns nothing for no changes', () => {
    expect(stockAlertsFrom([])).toEqual([]);
  });
});
