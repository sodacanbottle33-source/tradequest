// React glue for live market mode: one LiveController per page, subscribed with useSyncExternalStore so the
// screen always shows the controller's latest snapshot. All the rules live in the controller and the engine.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createLiveSession } from '../engine';
import { LiveController, type LiveSnapshot } from './liveController';
import { browserScheduler } from './playback';
import { randomSeed } from './seed';

export interface LiveMarket extends LiveSnapshot {
  controller: LiveController;
}

export function useLiveMarket(): LiveMarket {
  const [controller] = useState(() => new LiveController(createLiveSession(randomSeed()), browserScheduler));
  // Stop the timer when the page goes away. (A restart after React's dev-mode remount is fine: the market starts paused.)
  useEffect(() => () => controller.dispose(), [controller]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, ...snapshot };
}
