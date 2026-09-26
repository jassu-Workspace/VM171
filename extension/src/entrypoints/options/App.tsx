/**
 * Options page — Cycle 2.4 (client half)
 * ---------------------------------------------------------------------------
 * This is where an operator completes pairing. The server prints a one-time
 * pairing code to its console on boot; pasting it here exchanges it for a
 * signed token which is kept in chrome.storage.local.
 *
 * Design constraints that came out of the security work, not the UI work:
 *
 *   - The pairing code and the token are BOTH `type="password"`, and neither is
 *     ever logged, echoed into the URL, or rendered in plain text. There is no
 *     "show" toggle, deliberately: a credential that can be shoulder-surfed off
 *     a settings page is a credential that leaks.
 *   - The server address is loopback-only and the field says so. Silently
 *     accepting an arbitrary host would ship browsing data off-box.
 *   - Pairing status is shown explicitly. "Unpaired" is reported as its own
 *     state rather than as "offline", because those send an operator debugging
 *     completely different things.
 *   - "Test connection" performs a real authenticated GET /health, so the page
 *     never claims a success it has not observed.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  getAgentConfig,
  setAgentConfig,
  clearAgentConfig,
  authHeadersFor,
  DEFAULT_SERVER_URL,
} from '../../utils/config';
import {
  validatePairingCode,
  validateServerUrlField,
} from '../../utils/optionsValidation';

type Status = 'checking' | 'unpaired' | 'paired' | 'error';

export default function App() {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('checking');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // On load: reflect whatever is already stored, and probe the server.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const config = await getAgentConfig();
      if (cancelled) return;

      if (!config.valid) {
        setStatus('unpaired');
        return;
      }

      setServerUrl(config.serverUrl);
      try {
        const res = await fetch(`${config.serverUrl}/health`, {
          headers: authHeadersFor(config),
        });
        if (cancelled) return;
        setStatus(res.ok ? 'paired' : 'error');
        if (!res.ok) setMessage(`Server responded ${res.status}. The token may have expired.`);
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const onPair = useCallback(async () => {
    const urlCheck = validateServerUrlField(serverUrl);
    setUrlError(urlCheck.ok ? null : (urlCheck.message ?? null));
    if (!urlCheck.ok) return;

    const codeCheck = validatePairingCode(code);
    setCodeError(codeCheck.ok ? null : (codeCheck.message ?? null));
    if (!codeCheck.ok) return;

    setBusy(true);
    setMessage(null);

    try {
      const res = await fetch(`${serverUrl}/api/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });

      if (res.status === 403) {
        setStatus('error');
        setMessage(
          'The server refused this page’s origin. Add this extension’s origin to ALLOWED_ORIGINS on the server.'
        );
        return;
      }

      if (!res.ok) {
        setStatus('error');
        setMessage(
          res.status === 401
            ? 'That pairing code was not accepted. Check it matches the server console.'
            : `Pairing failed: server responded ${res.status}.`
        );
        return;
      }

      const body = (await res.json()) as { token?: string };
      if (!body.token) {
        setStatus('error');
        setMessage('The server returned no token.');
        return;
      }

      const saved = await setAgentConfig({ serverUrl: serverUrl.trim(), token: body.token });
      if (!saved) {
        setStatus('error');
        setMessage('The token was issued but could not be saved to extension storage.');
        return;
      }

      setCode('');
      setStatus('paired');
      setMessage('Paired. The token is stored in this browser profile only.');
    } catch {
      setStatus('error');
      setMessage('Could not reach the server. Is it running?');
    } finally {
      setBusy(false);
    }
  }, [serverUrl, code]);

  const onTest = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    const config = await getAgentConfig();

    if (!config.valid) {
      setStatus('unpaired');
      setMessage('Not paired yet.');
      setBusy(false);
      return;
    }

    try {
      const res = await fetch(`${config.serverUrl}/health`, {
        headers: authHeadersFor(config),
      });
      if (res.ok) {
        setStatus('paired');
        setMessage('Connected.');
      } else if (res.status === 401) {
        setStatus('unpaired');
        setMessage('The stored token was rejected. Pair again.');
      } else {
        setStatus('error');
        setMessage(`Server responded ${res.status}.`);
      }
    } catch {
      setStatus('error');
      setMessage('Could not reach the server. Is it running?');
    } finally {
      setBusy(false);
    }
  }, []);

  const onUnpair = useCallback(async () => {
    await clearAgentConfig();
    setCode('');
    setStatus('unpaired');
    setMessage('Cleared. The extension will not contact the server until paired again.');
  }, []);

  return (
    <div className="wrap">
      <h1>Zero-Trust AI Agent</h1>
      <p className="sub">Pair this extension with your local server.</p>

      <div className="banner warn">
        <strong>No credential is bundled with this extension.</strong> The server prints a
        one-time pairing code in its console on startup. Paste it below to receive a
        short-lived token, which is stored in this browser profile only.
      </div>

      <div className="card">
        <h2>Status</h2>
        <div className="status">
          <span
            className={`dot ${
              status === 'paired' ? 'ok' : status === 'error' ? 'bad' : status === 'unpaired' ? 'warn' : ''
            }`}
          />
          <span>
            {status === 'paired'
              ? 'Paired'
              : status === 'unpaired'
                ? 'Not paired'
                : status === 'error'
                  ? 'Problem'
                  : 'Checking…'}
          </span>
        </div>
        {message && <p className={status === 'paired' ? 'ok' : 'err'}>{message}</p>}
      </div>

      <div className="card">
        <h2>Pair</h2>

        <label htmlFor="serverUrl">Server address</label>
        <input
          id="serverUrl"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          placeholder={DEFAULT_SERVER_URL}
          spellCheck={false}
        />
        <p className="hint">
          Loopback only — <code>127.0.0.1</code> or <code>localhost</code>. This agent drives a
          local server; pointing it elsewhere would send page text and screenshots off this
          machine.
        </p>
        {urlError && <p className="err">{urlError}</p>}

        <label htmlFor="pairingCode">Pairing code (from the server console)</label>
        <input
          id="pairingCode"
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <p className="hint">
          The server prints a code like <code>aB3-_xYz…</code> on startup. It is masked and is
          never logged.
        </p>
        {codeError && <p className="err">{codeError}</p>}

        <div className="row">
          <button onClick={onPair} disabled={busy}>
            {busy ? 'Working…' : 'Pair'}
          </button>
          <button className="ghost" onClick={onTest} disabled={busy}>
            Test connection
          </button>
          <button className="ghost" onClick={onUnpair} disabled={busy}>
            Unpair
          </button>
        </div>
      </div>

      <div className="card">
        <h2>What pairing changes</h2>
        <p className="hint">
          Before pairing, the extension holds no server credential and sends nothing. After
          pairing it presents a signed, expiring token on each request. Tokens last 15 minutes
          and are issued only to a request whose origin the server has allow-listed.
        </p>
      </div>
    </div>
  );
}
