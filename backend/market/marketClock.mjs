import 'dotenv/config';

/** Regular simulated NSE cash session in IST. No holidays or special sessions. */
export const MARKET_TIMEZONE = 'Asia/Kolkata';

export const MARKET_SESSION = Object.freeze({
  timezone: MARKET_TIMEZONE,
  weekdays: Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']),
  open: Object.freeze({ hour: 9, minute: 15, second: 0 }),
  close: Object.freeze({ hour: 15, minute: 30, second: 0 }),
});

const IST_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_TIMEZONE,
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
  hourCycle: 'h23',
});

const IST_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: MARKET_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function toSeconds({ hour, minute, second }) {
  return hour * 3600 + minute * 60 + second;
}

const OPEN_SECONDS = toSeconds(MARKET_SESSION.open);
const CLOSE_SECONDS = toSeconds(MARKET_SESSION.close);
const WEEKDAYS = new Set(MARKET_SESSION.weekdays);

function isRegularMarketOpen(now) {
  const { weekday, hour, minute, second } = getIstWallClock(now);
  if (!WEEKDAYS.has(weekday)) return false;

  const t = toSeconds({ hour, minute, second });
  return t >= OPEN_SECONDS && t < CLOSE_SECONDS;
}

export function createMarketStateProvider({
  demoEnabled = false,
  clock = () => new Date(),
} = {}) {
  let demoOverride = null;
  let activationCycle = 0;

  function isMarketOpen(now = clock()) {
    if (demoEnabled && demoOverride !== null) return demoOverride === 'OPEN';
    return isRegularMarketOpen(now);
  }

  function getMarketState(now = clock()) {
    return isMarketOpen(now) ? 'OPEN' : 'CLOSED';
  }

  function getMarketStatus(now = clock()) {
    return {
      demoModeEnabled: demoEnabled,
      demoOverride,
      state: getMarketState(now),
      activationCycle,
    };
  }

  function getOrderMarketAction(orderType, now = clock()) {
    if (orderType !== 'MARKET' && orderType !== 'LIMIT') {
      throw new TypeError('Order type must be MARKET or LIMIT.');
    }
    if (isMarketOpen(now)) return 'PROCESS';
    return orderType === 'MARKET' ? 'REJECT_MARKET' : 'QUEUE_LIMIT';
  }

  function setDemoMarketState(state) {
    if (!demoEnabled) {
      throw new Error('Market demo mode is disabled.');
    }
    if (state !== 'OPEN' && state !== 'CLOSED') {
      throw new TypeError('Market state must be OPEN or CLOSED.');
    }

    const previousState = getMarketState();
    demoOverride = state;
    if (state === 'OPEN' && previousState !== 'OPEN') activationCycle++;
    return getMarketStatus();
  }

  function getActivationKey(now = clock()) {
    if (demoEnabled && demoOverride !== null) {
      return `demo:${activationCycle}`;
    }
    return `session:${IST_DATE_FORMATTER.format(now)}`;
  }

  return {
    demoEnabled,
    getActivationKey,
    getOrderMarketAction,
    getMarketState,
    getMarketStatus,
    isMarketOpen,
    setDemoMarketState,
  };
}

const demoModeValue = process.env.MARKET_DEMO_MODE;
if (demoModeValue !== undefined && !['true', 'false'].includes(demoModeValue.toLowerCase())) {
  throw new Error('MARKET_DEMO_MODE must be set to true or false when provided.');
}

export const MARKET_DEMO_MODE_ENABLED = demoModeValue?.toLowerCase() === 'true';
const marketStateProvider = createMarketStateProvider({
  demoEnabled: MARKET_DEMO_MODE_ENABLED,
});

function partsMap(date) {
  const map = {};
  for (const part of IST_PARTS_FORMATTER.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return map;
}

/** Wall-clock components in Asia/Kolkata, independent of the host timezone. */
export function getIstWallClock(now = new Date()) {
  const parts = partsMap(now);
  return {
    weekday: parts.weekday,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * True when `now` falls on a weekday in [09:15:00, 15:30:00) IST.
 * Pass a Date to test without waiting for live market hours.
 */
export function isMarketOpen(now = new Date()) {
  return marketStateProvider.isMarketOpen(now);
}

export function getMarketState(now = new Date()) {
  return marketStateProvider.getMarketState(now);
}

export function getMarketStatus(now = new Date()) {
  return marketStateProvider.getMarketStatus(now);
}

export function setDemoMarketState(state) {
  return marketStateProvider.setDemoMarketState(state);
}

export function getMarketActivationKey(now = new Date()) {
  return marketStateProvider.getActivationKey(now);
}

export function getOrderMarketAction(orderType, now = new Date()) {
  return marketStateProvider.getOrderMarketAction(orderType, now);
}

/** Calendar date in Asia/Kolkata as YYYY-MM-DD, used as a trading-session id. */
export function getIstTradingDate(now = new Date()) {
  return IST_DATE_FORMATTER.format(now);
}
