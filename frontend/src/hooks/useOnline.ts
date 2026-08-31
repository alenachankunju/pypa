/**
 * Connectivity state (FSD 6.8, JDG-08-02).
 *
 * navigator.onLine reports only whether the device has a network interface, not
 * whether the API is reachable — a venue captive portal reports "online" while
 * every request fails, which is exactly the situation FSD 6.8 is written for.
 * The API layer reports real request outcomes through reportReachability, and
 * this hook reflects both signals.
 */
import { useEffect, useState } from 'react';

let apiReachable = true;
const listeners = new Set<(online: boolean) => void>();

function currentState(): boolean {
  return navigator.onLine && apiReachable;
}

/** Called after a request succeeds or fails with a network error. */
export function reportReachability(reachable: boolean): void {
  if (apiReachable === reachable) return;
  apiReachable = reachable;
  for (const listener of listeners) listener(currentState());
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(currentState);

  useEffect(() => {
    const update = () => setOnline(currentState());

    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    listeners.add(setOnline);

    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
      listeners.delete(setOnline);
    };
  }, []);

  return online;
}
