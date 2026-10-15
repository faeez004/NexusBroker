import { useEffect, useState } from 'react';
import { apiFetch } from '../hooks/useApi';

const DEMO_CONTROLS_ENABLED = import.meta.env.DEV
  && import.meta.env.VITE_MARKET_DEMO_MODE === 'true';

export default function MarketDemoControl() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!DEMO_CONTROLS_ENABLED) return;
    let cancelled = false;

    apiFetch('/debug/market-demo')
      .then(response => {
        if (!cancelled) setStatus(response.data);
      })
      .catch(error => {
        if (!cancelled) setMessage(error.message);
      });

    return () => { cancelled = true; };
  }, []);

  if (!DEMO_CONTROLS_ENABLED) return null;

  const switchState = async state => {
    setBusy(true);
    setMessage('');
    try {
      const response = await apiFetch('/debug/market-demo', {
        method: 'POST',
        body: JSON.stringify({ state }),
      });
      setStatus(response.data);
      setMessage(response.activation === 'completed'
        ? 'Queued LIMIT orders activated.'
        : '');
    } catch (error) {
      setMessage(error.message);
      try {
        const response = await apiFetch('/debug/market-demo');
        setStatus(response.data);
      } catch (statusError) {
        setMessage(`${error.message} (${statusError.message})`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={S.wrap}>
      <span style={{ ...S.state, color: status?.state === 'OPEN' ? '#26a69a' : '#ef5350' }}>
        Demo market: {status?.state || '...'}
      </span>
      <button disabled={busy || !status || status.state === 'OPEN'} onClick={() => switchState('OPEN')} style={S.button}>
        OPEN
      </button>
      <button disabled={busy || !status || status.state === 'CLOSED'} onClick={() => switchState('CLOSED')} style={S.button}>
        CLOSED
      </button>
      {message && <span role="status" style={S.message}>{message}</span>}
    </div>
  );
}

const S = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
    border: '1px solid #2a2e39',
    borderRadius: 4,
    padding: '4px 6px',
  },
  state: { fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' },
  button: {
    background: '#1e222d',
    border: '1px solid #2a2e39',
    borderRadius: 3,
    color: '#e0e3eb',
    cursor: 'pointer',
    fontSize: 10,
    padding: '4px 6px',
  },
  message: { color: '#f0ad4e', fontSize: 10, maxWidth: 220 },
};
