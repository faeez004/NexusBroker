import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import cookieParser from 'cookie-parser';
import express from 'express';
import { createServer } from 'node:http';
import jwt from 'jsonwebtoken';
import test, { after } from 'node:test';
import pool from '../config/db.mjs';
import { MatchingEngine } from '../engine/matchingEngine.mjs';
import { OrderBook } from '../engine/orderbook.mjs';
import { createMarketScheduler } from '../market/marketScheduler.mjs';
import {
  createMarketStateProvider,
  getIstTradingDate,
  isMarketOpen,
} from '../market/marketClock.mjs';
import { createMarketDemoRouter } from '../routes/marketDemoRoutes.mjs';

const openTime = new Date('2026-10-15T03:45:00.000Z');
const testAccessTokenSecret = 'market-demo-test-secret';
process.env.ACCESS_TOKEN_SECRET = testAccessTokenSecret;

after(async () => {
  await pool.end();
});

function makeOrder(overrides = {}) {
  return {
    id: 'order-1',
    userId: 'user-1',
    instrumentId: 'instrument-1',
    symbol: 'TEST',
    side: 'BUY',
    orderType: 'LIMIT',
    quantity: 10,
    price: 1000,
    productType: 'CNC',
    createdAt: new Date('2026-10-14T10:00:00.000Z'),
    ...overrides,
  };
}

function makeDatabase(order, { statusReadGate } = {}) {
  const state = {
    ...order,
    instrument_id: order.instrumentId,
    order_type: order.orderType,
    product_type: order.productType,
    filled_quantity: 0,
    reserved: 0,
    status: 'PENDING',
    created_at: order.createdAt,
  };

  return {
    state,
    async execute(sql) {
      if (sql.includes('SELECT status, quantity, filled_quantity')) {
        if (statusReadGate) await statusReadGate;
        return [[{
          status: state.status,
          quantity: state.quantity,
          filled_quantity: state.filled_quantity,
        }]];
      }
      if (sql.includes('FROM orders o')) {
        return state.status === 'PENDING' || state.status === 'PARTIAL'
          ? [[{
            id: state.id,
            user_id: state.userId,
            instrument_id: state.instrument_id,
            side: state.side,
            order_type: state.order_type,
            quantity: state.quantity,
            price: state.price,
            product_type: state.product_type,
            created_at: state.created_at,
            symbol: state.symbol,
          }]]
          : [[]];
      }
      if (sql.includes('SELECT instrument_id')) return [[{ instrument_id: state.instrument_id }]];
      throw new Error(`Unexpected pool query: ${sql}`);
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {},
        async rollback() {},
        release() {},
        async execute(sql) {
          if (sql.includes('SELECT id, user_id, instrument_id')) return [[state]];
          if (sql.includes("SET status = 'CANCELLED'")) {
            state.status = 'CANCELLED';
            return [{ affectedRows: 1 }];
          }
          return [{ affectedRows: 1 }];
        },
      };
    },
  };
}

function authCookie(userId) {
  return `ACCESS_TOKEN=${jwt.sign({}, testAccessTokenSecret, { subject: userId })}`;
}

function requestOptions(userId, options = {}) {
  return {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(userId ? { Cookie: authCookie(userId) } : {}),
      ...options.headers,
    },
  };
}

test('market clock enforces IST boundaries and weekdays', () => {
  const cases = [
    ['2026-10-15T03:44:59.000Z', false],
    ['2026-10-15T03:45:00.000Z', true],
    ['2026-10-15T09:59:59.000Z', true],
    ['2026-10-15T10:00:00.000Z', false],
    ['2026-10-17T05:00:00.000Z', false],
    ['2026-10-18T05:00:00.000Z', false],
  ];

  for (const [iso, expected] of cases) {
    assert.equal(isMarketOpen(new Date(iso)), expected, iso);
  }
  assert.equal(getIstTradingDate(openTime), '2026-10-15');
});

test('market demo provider preserves real clock until overridden and cycles on reopening', () => {
  const provider = createMarketStateProvider({
    demoEnabled: true,
    clock: () => new Date('2026-10-15T03:44:59.000Z'),
  });

  assert.equal(provider.isMarketOpen(), false);
  assert.equal(provider.getActivationKey(), 'session:2026-10-15');
  assert.equal(provider.getOrderMarketAction('MARKET'), 'REJECT_MARKET');
  assert.equal(provider.getOrderMarketAction('LIMIT'), 'QUEUE_LIMIT');
  assert.equal(provider.setDemoMarketState('OPEN').state, 'OPEN');
  assert.equal(provider.isMarketOpen(), true);
  assert.equal(provider.getOrderMarketAction('MARKET'), 'PROCESS');
  assert.equal(provider.getOrderMarketAction('LIMIT'), 'PROCESS');
  assert.equal(provider.getActivationKey(), 'demo:1');
  provider.setDemoMarketState('CLOSED');
  provider.setDemoMarketState('OPEN');
  assert.equal(provider.getActivationKey(), 'demo:2');
});

test('market demo requires opt-in and supports production demonstration', () => {
  assert.doesNotThrow(
    () => createMarketStateProvider({ demoEnabled: true }),
  );
  assert.doesNotThrow(
    () => createMarketDemoRouter({ enabled: true }),
  );
  assert.throws(
    () => createMarketDemoRouter({ enabled: false }),
    /requires MARKET_DEMO_MODE=true/,
  );
  assert.throws(
    () => createMarketStateProvider({ demoEnabled: false }).setDemoMarketState('OPEN'),
    /demo mode is disabled/,
  );

  const startupCheck = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "import('./market/marketClock.mjs').then(({ MARKET_DEMO_MODE_ENABLED }) => console.log(MARKET_DEMO_MODE_ENABLED))"],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        MARKET_DEMO_MODE: 'true',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(startupCheck.status, 0, startupCheck.stderr);
  assert.match(startupCheck.stdout, /true/);
});

test('demo endpoint requires the configured operator and switches state for that operator', async (t) => {
  const marketProvider = createMarketStateProvider({
    demoEnabled: true,
    clock: () => new Date('2026-10-15T03:44:59.000Z'),
  });
  let activations = 0;
  const scheduler = createMarketScheduler({
    marketState: marketProvider,
    clock: () => new Date('2026-10-15T03:44:59.000Z'),
    activate: async () => { activations++; },
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', createMarketDemoRouter({
    enabled: true,
    operatorId: 'operator-1',
    marketProvider,
    getScheduler: () => scheduler,
  }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await scheduler.stop();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthenticatedGet = await fetch(baseUrl);
  assert.equal(unauthenticatedGet.status, 401);
  const unauthenticatedPost = await fetch(baseUrl, requestOptions(null, {
    method: 'POST',
    body: JSON.stringify({ state: 'OPEN' }),
  }));
  assert.equal(unauthenticatedPost.status, 401);

  const unauthorizedGet = await fetch(baseUrl, requestOptions('user-2'));
  assert.equal(unauthorizedGet.status, 403);
  const unauthorizedPost = await fetch(baseUrl, requestOptions('user-2', {
    method: 'POST',
    body: JSON.stringify({ state: 'OPEN' }),
  }));
  assert.equal(unauthorizedPost.status, 403);
  assert.equal(marketProvider.getMarketStatus().state, 'CLOSED');

  const initial = await fetch(baseUrl, requestOptions('operator-1')).then((response) => response.json());
  assert.equal(initial.data.state, 'CLOSED');

  const closed = await fetch(baseUrl, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'CLOSED' }),
  }));
  assert.equal(closed.status, 200);
  assert.equal(activations, 0);

  const opened = await fetch(baseUrl, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'OPEN' }),
  })).then((response) => response.json());
  assert.equal(opened.activation, 'completed');
  assert.equal(activations, 1);

  await fetch(baseUrl, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'CLOSED' }),
  }));
  const reopened = await fetch(baseUrl, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'OPEN' }),
  })).then((response) => response.json());
  assert.equal(reopened.activation, 'completed');
  assert.equal(activations, 2);

  const invalid = await fetch(baseUrl, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'HALTED' }),
  }));
  assert.equal(invalid.status, 400);
});

test('demo endpoint fails closed when no operator ID is configured', async (t) => {
  const app = express();
  app.use(cookieParser());
  app.use('/', createMarketDemoRouter({
    enabled: true,
    operatorId: '',
    marketProvider: { getMarketStatus: () => ({ state: 'CLOSED' }) },
  }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}`, requestOptions('operator-1'));
  assert.equal(response.status, 403);
});

test('demo endpoint reports activation failures without claiming success', async (t) => {
  const marketProvider = createMarketStateProvider({
    demoEnabled: true,
    clock: () => new Date('2026-10-15T03:44:59.000Z'),
  });
  const scheduler = createMarketScheduler({
    marketState: marketProvider,
    clock: () => new Date('2026-10-15T03:44:59.000Z'),
    activate: async () => { throw new Error('database unavailable'); },
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', createMarketDemoRouter({
    enabled: true,
    operatorId: 'operator-1',
    marketProvider,
    getScheduler: () => scheduler,
  }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await scheduler.stop();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}`, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'OPEN' }),
  }));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.data.state, 'OPEN');
  assert.equal(body.activation, 'failed');
});

test('CLOSED transition waits until the opening activation finishes', async (t) => {
  const marketProvider = createMarketStateProvider({
    demoEnabled: true,
    clock: () => new Date('2026-10-15T03:44:59.000Z'),
  });
  let startActivation;
  let finishActivation;
  const activationStarted = new Promise((resolve) => {
    startActivation = resolve;
  });
  const activationGate = new Promise((resolve) => {
    finishActivation = resolve;
  });
  const scheduler = createMarketScheduler({
    marketState: marketProvider,
    clock: () => new Date('2026-10-15T03:44:59.000Z'),
    activate: () => {
      startActivation();
      return activationGate;
    },
  });
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/', createMarketDemoRouter({
    enabled: true,
    operatorId: 'operator-1',
    marketProvider,
    getScheduler: () => scheduler,
  }));
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await scheduler.stop();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  const url = `http://127.0.0.1:${server.address().port}`;
  const openRequest = fetch(url, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'OPEN' }),
  }));
  await activationStarted;
  const closeRequest = fetch(url, requestOptions('operator-1', {
    method: 'POST',
    body: JSON.stringify({ state: 'CLOSED' }),
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(marketProvider.getMarketStatus().state, 'OPEN');

  finishActivation();
  assert.equal((await openRequest).status, 200);
  const closedResponse = await closeRequest;
  assert.equal(closedResponse.status, 200);
  assert.equal(marketProvider.getMarketStatus().state, 'CLOSED');
});

test('duplicate order submissions add only one book entry', async () => {
  const order = makeOrder();
  const engine = new MatchingEngine(makeDatabase(order));
  engine.initialized = true;

  await Promise.all([engine.processOrder(order), engine.processOrder(order)]);

  const book = engine.books.get(order.instrumentId);
  assert.equal(book.bids.length, 1);
  assert.equal(book.bids[0].id, order.id);
});

test('a cancelled order is not admitted to the book', async () => {
  const order = makeOrder({ side: 'SELL' });
  const database = makeDatabase(order);
  const engine = new MatchingEngine(database);
  engine.initialized = true;

  const result = await engine.cancelOrder(order.id, order.userId);
  await engine.processOrder(order);

  assert.equal(result.success, true);
  assert.equal(database.state.status, 'CANCELLED');
  assert.equal(engine.books.has(order.instrumentId), false);
});

test('cancellation waits for in-flight admission and removes the order', async () => {
  const order = makeOrder({ side: 'SELL' });
  let releaseStatusRead;
  let startedStatusRead;
  const statusReadStarted = new Promise((resolve) => {
    startedStatusRead = resolve;
  });
  const statusReadGate = new Promise((resolve) => {
    releaseStatusRead = resolve;
  });
  const database = makeDatabase(order, { statusReadGate });
  const originalExecute = database.execute.bind(database);
  database.execute = async (sql, params) => {
    if (sql.includes('SELECT status, quantity, filled_quantity')) startedStatusRead();
    return originalExecute(sql, params);
  };
  const engine = new MatchingEngine(database);
  engine.initialized = true;

  const admission = engine.processOrder(order);
  await statusReadStarted;
  const cancellation = engine.cancelOrder(order.id, order.userId);
  releaseStatusRead();
  await Promise.all([admission, cancellation]);

  assert.equal(database.state.status, 'CANCELLED');
  assert.equal(engine.books.get(order.instrumentId).asks.length, 0);
});

test('activation retry reruns matching for an order already on the book', async () => {
  const order = makeOrder();
  const engine = new MatchingEngine(makeDatabase(order));
  engine.initialized = true;
  let attempts = 0;
  engine._runMatchingLoop = async () => {
    attempts++;
    if (attempts === 1) throw new Error('temporary settlement failure');
  };

  await assert.rejects(engine.processOrder(order), /temporary settlement failure/);
  await engine.processPendingOrders();

  assert.equal(attempts, 2);
  assert.equal(engine.books.get(order.instrumentId).bids.length, 1);
});

test('settlement drops an order cancelled in the database before it can execute', async () => {
  const bid = makeOrder();
  const ask = makeOrder({
    id: 'order-2',
    userId: 'user-2',
    side: 'SELL',
  });
  const book = new OrderBook(bid.instrumentId, bid.symbol);
  book.addOrder({ ...bid, remainingQty: bid.quantity });
  book.addOrder({ ...ask, remainingQty: ask.quantity });
  let committed = false;
  const database = {
    async getConnection() {
      return {
        async beginTransaction() {},
        async commit() {
          committed = true;
        },
        async rollback() {},
        release() {},
        async execute(sql) {
          assert.match(sql, /FROM orders/);
          return [[
            { id: bid.id, status: 'CANCELLED', quantity: bid.quantity, filled_quantity: 0 },
            { id: ask.id, status: 'PENDING', quantity: ask.quantity, filled_quantity: 0 },
          ]];
        },
      };
    },
  };
  const engine = new MatchingEngine(database);

  await engine._settleTrade({
    book,
    bid: book.bids[0],
    ask: book.asks[0],
    tradeQty: 10,
    tradePrice: 1000,
    tradeValue: 10000,
  });

  assert.equal(committed, true);
  assert.equal(book.bids.length, 0);
  assert.equal(book.asks.length, 1);
});

test('scheduler retries failed activation and records success once per session', async () => {
  let attempts = 0;
  const scheduler = createMarketScheduler({
    activate: async () => {
      attempts++;
      if (attempts === 1) throw new Error('temporary activation failure');
    },
  });

  assert.equal(await scheduler.tick(openTime), false);
  assert.equal(await scheduler.tick(openTime), true);
  assert.equal(await scheduler.tick(openTime), true);
  assert.equal(attempts, 2);
  await scheduler.stop();
});

test('scheduler stop waits for activation already in flight', async () => {
  let finishActivation;
  let stopFinished = false;
  const scheduler = createMarketScheduler({
    activate: () => new Promise((resolve) => {
      finishActivation = resolve;
    }),
  });

  const tick = scheduler.tick(openTime);
  const stopping = scheduler.stop().then(() => {
    stopFinished = true;
  });
  await Promise.resolve();
  assert.equal(stopFinished, false);

  finishActivation();
  await Promise.all([tick, stopping]);
  assert.equal(stopFinished, true);
});

test('scheduler start polls and stop prevents future activations', async () => {
  let attempts = 0;
  const scheduler = createMarketScheduler({
    activate: async () => {
      attempts++;
      throw new Error('keep retrying until stopped');
    },
    pollIntervalMs: 5,
    clock: () => openTime,
  });

  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await scheduler.stop();
  const attemptsAtStop = attempts;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(attemptsAtStop > 0);
  assert.equal(attempts, attemptsAtStop);
});
