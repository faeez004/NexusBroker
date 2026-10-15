import { isIP } from 'node:net';
import { Router } from 'express';
import {
  getMarketStatus,
  setDemoMarketState,
} from '../market/marketClock.mjs';
import { startMarketScheduler } from '../market/marketScheduler.mjs';

export function isLocalClientAddress(address) {
  if (!address || !isIP(address)) return false;
  if (address === '::1') return true;
  if (address.startsWith('::ffff:')) {
    return isLocalClientAddress(address.slice('::ffff:'.length));
  }
  return address.startsWith('127.');
}

export function createMarketDemoRouter({
  enabled,
  nodeEnv = process.env.NODE_ENV,
  marketProvider = { getMarketStatus, setDemoMarketState },
  getScheduler = startMarketScheduler,
} = {}) {
  if (enabled && nodeEnv?.toLowerCase() === 'production') {
    throw new Error('The market demo control route is unavailable in production.');
  }
  if (!enabled) {
    throw new Error('The market demo control route requires MARKET_DEMO_MODE=true.');
  }

  const router = Router();
  let transition = Promise.resolve();

  router.use((req, res, next) => {
    if (!isLocalClientAddress(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Market demo controls are local-only.' });
    }
    next();
  });

  router.get('/', (req, res) => {
    res.json({ data: marketProvider.getMarketStatus() });
  });

  router.post('/', async (req, res, next) => {
    if (req.body?.state !== 'OPEN' && req.body?.state !== 'CLOSED') {
      return res.status(400).json({ error: 'state must be OPEN or CLOSED.' });
    }

    const task = transition.then(async () => {
      const previousState = marketProvider.getMarketStatus().state;
      const status = marketProvider.setDemoMarketState(req.body?.state);
      const scheduler = getScheduler();

      if (status.state === 'CLOSED') {
        const activationSettled = await scheduler.waitForIdle();
        if (!activationSettled) {
          return res.status(503).json({
            error: 'Market is CLOSED, but in-flight LIMIT activation failed; remaining orders can retry on the next OPEN transition.',
            data: marketProvider.getMarketStatus(),
            activation: 'failed',
          });
        }
        return res.json({ data: status, activation: 'not-required' });
      }

      if (previousState === 'CLOSED') {
        const activated = await scheduler.tick();
        if (!activated) {
          return res.status(503).json({
            error: 'Market is OPEN, but queued LIMIT order activation failed; the scheduler will retry.',
            data: marketProvider.getMarketStatus(),
            activation: 'failed',
          });
        }
        return res.json({ data: marketProvider.getMarketStatus(), activation: 'completed' });
      }

      return res.json({ data: status, activation: 'not-required' });
    });

    transition = task.catch(() => {});
    try {
      await task;
    } catch (err) {
      next(err);
    }
  });

  return router;
}
