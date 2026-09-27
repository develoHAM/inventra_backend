import type { StockBelowTargetEvent } from '../notifications/notification-events';

export interface StockChange {
  placementId: number;
  availableBefore: number;
  availableAfter: number;
  targetStockQuantity: number;
}

/**
 * One transaction may touch the same placement several times (fulfill = RELEASE then SALE).
 * Judge each placement by its FIRST availableBefore vs its LAST availableAfter, so a
 * temporary dip or rise inside the transaction can't cause a false alarm.
 */
export function stockAlertsFrom(
  changes: StockChange[],
): StockBelowTargetEvent[] {
  const byPlacement = new Map<
    number,
    { first: StockChange; last: StockChange }
  >();
  for (const change of changes) {
    const seen = byPlacement.get(change.placementId);
    if (seen) seen.last = change;
    else byPlacement.set(change.placementId, { first: change, last: change });
  }

  const alerts: StockBelowTargetEvent[] = [];
  for (const { first, last } of byPlacement.values()) {
    const target = last.targetStockQuantity;
    if (
      target > 0 &&
      first.availableBefore >= target &&
      last.availableAfter < target
    ) {
      alerts.push({
        placementId: last.placementId,
        availableQuantity: last.availableAfter,
        targetStockQuantity: target,
      });
    }
  }
  return alerts;
}
