import { createScheduler } from '../scheduler/scheduler.js';
import type { Scheduler, SchedulerOptions } from '../scheduler/scheduler-types.js';
import type { Clock, Sleeper } from './runtime-services.js';

function isScheduler(value: Scheduler | SchedulerOptions): value is Scheduler {
  return typeof (value as Partial<Scheduler>).acquire === 'function';
}

/** The given scheduler, or one built from options (defaulting to this aigent's clock and sleep). */
export function resolveScheduler(params: { scheduler: Scheduler | SchedulerOptions | undefined; clock: Clock; sleep: Sleeper }): Scheduler {
  const { scheduler = {}, clock, sleep } = params;
  return isScheduler(scheduler) ? scheduler : createScheduler({ clock, sleep, ...scheduler });
}
