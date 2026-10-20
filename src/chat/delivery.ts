import type { DeliveryMode } from './message.js';

/** What happens to a message: start now, wait in the queue, join the running turn, or cut it short. */
export type DeliveryAction = 'start' | 'queue' | 'steer' | 'interrupt';

export interface RouteDeliveryParams {
  mode: DeliveryMode;
  /** A turn is running (or waiting for an answer). */
  isBusy: boolean;
  /** Messages are already waiting: a new one must not overtake them. */
  hasQueue: boolean;
}

/** Busy-time delivery: an idle agent starts at once (behind anything queued); a busy one follows the message's mode. */
export function routeDelivery(params: RouteDeliveryParams): DeliveryAction {
  const { mode, isBusy, hasQueue } = params;
  if (!isBusy) return hasQueue ? 'queue' : 'start';
  return mode;
}
