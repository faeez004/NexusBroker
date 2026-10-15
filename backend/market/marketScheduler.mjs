import { getMarketActivationKey, isMarketOpen } from './marketClock.mjs';

const DEFAULT_POLL_MS = 1000;

async function activatePendingOrders() {
  const { engine } = await import('../engine/matchingEngine.mjs');
  return engine.processPendingOrders();
}

/**
 * Polls market-clock state and activates persisted PENDING LIMIT orders
 * once per market activation key. Does not touch the OrderBook itself.
 */
export function createMarketScheduler({
  activate = activatePendingOrders,
  pollIntervalMs = DEFAULT_POLL_MS,
  clock = () => new Date(),
  marketState = { getActivationKey: getMarketActivationKey, isMarketOpen },
} = {}) {
  let timer = null;
  // Process-local only; restart/multi-instance coordination requires persistence.
  let lastActivatedKey = null;
  let inFlight = null;

  async function tick(now = new Date()) {
    if (!marketState.isMarketOpen(now)) return false;

    const activationKey = marketState.getActivationKey(now);
    if (lastActivatedKey === activationKey) return true;
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        await activate();
        lastActivatedKey = activationKey;
        console.log(`[Market] Activated queued LIMIT orders for ${activationKey}.`);
        return true;
      } catch (err) {
        console.error('[Market] Failed to activate pending orders:', err);
        return false;
      }
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  }

  function start() {
    if (timer) return;
    tick(clock()).catch((err) => console.error('[Market] Startup activation failed:', err));
    timer = setInterval(() => {
      tick(clock()).catch((err) => console.error('[Market] Scheduler tick failed:', err));
    }, pollIntervalMs);
    console.log(`[Market] Session scheduler polling every ${pollIntervalMs}ms.`);
  }

  async function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (inFlight) await inFlight;
  }

  async function waitForIdle() {
    if (inFlight) return inFlight;
    return true;
  }

  return { start, stop, tick, waitForIdle };
}

let scheduler = null;

export function startMarketScheduler(pollIntervalMs = DEFAULT_POLL_MS) {
  if (!scheduler) {
    scheduler = createMarketScheduler({ pollIntervalMs });
  }
  scheduler.start();
  return scheduler;
}

export function stopMarketScheduler() {
  return scheduler?.stop();
}
