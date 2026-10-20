/** How an owned flight ended: its result was stored, or it failed / was not cacheable. */
export type FlightOutcome = 'stored' | 'abandoned';

/** The first claimant of a key owns the flight and must settle it; later claimants wait for its outcome. */
export type FlightClaim =
  | { isOwner: true; settle(outcome: FlightOutcome): void }
  | { isOwner: false; outcome: Promise<FlightOutcome> };

export interface SingleFlight {
  /** Synchronous check-and-claim, so two callers can never both own one key. */
  claim(key: string): FlightClaim;
}

/** Shares one in-progress lookup-and-run per key between concurrent identical calls. */
export function createSingleFlight(): SingleFlight {
  const flights = new Map<string, Promise<FlightOutcome>>();

  function claim(key: string): FlightClaim {
    const existing = flights.get(key);
    if (existing != null) return { isOwner: false, outcome: existing };
    let resolve: (outcome: FlightOutcome) => void = () => undefined;
    const flight = new Promise<FlightOutcome>(resolveFlight => { resolve = resolveFlight; });
    flights.set(key, flight);
    let isSettled = false;
    return {
      isOwner: true,
      settle: outcome => {
        if (isSettled) return;
        isSettled = true;
        // Only this flight's own entry is removed; a later flight for the key must survive.
        if (flights.get(key) === flight) flights.delete(key);
        resolve(outcome);
      },
    };
  }

  return { claim };
}
