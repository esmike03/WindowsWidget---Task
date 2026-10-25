'use strict';

/* ═══════════════════════════════════════════════════════════════════════
   ChatGPT through "Sign in with ChatGPT" — no Codex needed.

   OpenAI lets open-source, locally run apps use a person's ChatGPT plan for
   Responses API requests (developers.openai.com/siwc/token-sharing-open-source).
   The flow, per those docs:
     1. Sign in: OAuth Authorization Code + PKCE in the user's browser with a
        loopback callback on 127.0.0.1. The first sign-in registers this app
        (client_id=dynamic_agent_client) and returns an issued client_id.
     2. Validate the ID token (JWKS signature, issuer, audience, expiry, nonce)
        and check the `chatgpt.tokens.use.direct` scope was granted.
     3. Call POST https://api.openai.com/v1/responses with the access token,
        always `store: false` and `stream: true`. Refresh the token (1 h
        lifetime) with the rotating refresh token.
   Credentials are encrypted with Windows DPAPI via Electron's safeStorage.
   ═══════════════════════════════════════════════════════════════════════ */

const { safeStorage } = require('electron');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { openInLastBrowser } = require('./browser');
const { FileTools, TOOLS } = require('./filetools');
const assistant = require('./assistant');

const AUTH = 'https://auth.openai.com';
const AUTHORIZE_URL = `${AUTH}/api/accounts/authorize`;
const TOKEN_URL = `${AUTH}/api/accounts/oauth/token`;
const API = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const CALLBACK_PATH = '/auth/callback';
const PORTS = [1455, 1456, 1457, 1458, 1459, 1460];
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const MAX_TOOL_ROUNDS = 10;
const MAX_HISTORY = 20;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const USAGE_URL = 'https://chatgpt.com/settings';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

class DirectError extends Error {
  constructor(message, extra = {}) {
    super(message);
    Object.assign(this, extra);
  }
}

class ChatGptDirect {
  /**
   * @param {object} o
   * @param {string} o.dir                 where the encrypted credentials live
   * @param {{ get: () => object }} o.settings
   * @param {() => string} o.folder        folder the file tools may read
   */
  constructor({ dir, settings, folder }) {
    this.file = path.join(dir, 'chatgpt-account.bin');
    this.settings = settings;
    this.files = new FileTools(folder);
    this.state = this.load();
    this.refreshing = null;
    this.signInAbort = null;
    this.controller = null;
    this.history = [];
    this.modelCache = null;
  }

  /* ── credential storage ───────────────────────────────────────────── */

  load() {
    try {
      const raw = fs.readFileSync(this.file);
      const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8');
      const state = JSON.parse(text);
      if (state && typeof state === 'object') return state;
    } catch (_) {
      /* first run or unreadable */
    }
    return { hostId: `urn:uuid:${crypto.randomUUID()}` };
  }

  save() {
    const text = JSON.stringify(this.state);
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf8');
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** Forget tokens but keep the host id and issued client id for next time. */
  clearTokens() {
    delete this.state.tokens;
    this.modelCache = null;
    this.save();
  }

  status() {
    const t = this.state.tokens;
    const planUsage = !!t && String(t.scope || '').split(' ').includes(PLAN_SCOPE);
    return {
      signedIn: !!t,
      planUsage,
      email: this.state.account?.email || null,
      name: this.state.account?.name || null,
    };
  }

  /* ── sign in ──────────────────────────────────────────────────────── */

  /** Starts the loopback listener on the first free port of PORTS. */
  listen() {
    return new Promise((resolve, reject) => {
      const tryPort = (i) => {
        if (i >= PORTS.length) return reject(new DirectError('No free local port for the sign-in callback (1455–1460).'));
        const server = http.createServer();
        server.once('error', () => tryPort(i + 1));
        server.listen(PORTS[i], '127.0.0.1', () => resolve({ server, port: PORTS[i] }));
      };
      tryPort(0);
    });
  }

  async signIn() {
    if (this.signInAbort) throw new DirectError('A sign-in is already in progress.');
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const stateParam = b64url(crypto.randomBytes(24));
    const nonce = b64url(crypto.randomBytes(24));
    const { server, port } = await this.listen();
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

    const known = this.state.clientId;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: known || 'dynamic_agent_client',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: API,
      state: stateParam,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ext_agent_host_id: this.state.hostId,
    });
    if (!known) params.set('agent_name_hint', 'Sidenote');
    if (known && this.state.idToken) params.set('id_token_hint', this.state.idToken);
    if (this.state.needsConsent) params.set('prompt', 'consent');

    let callback;
    try {
      callback = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new DirectError('Sign-in timed out.')), SIGN_IN_TIMEOUT_MS);
        this.signInAbort = () => {
          clearTimeout(timer);
          reject(new DirectError('Sign-in cancelled.'));
        };
        server.on('request', (req, res) => {
          const url = new URL(req.url, redirectUri);
          if (url.pathname !== CALLBACK_PATH) {
            res.writeHead(404).end();
            return;
          }
          const q = Object.fromEntries(url.searchParams);
          const ok = !q.error && q.state === stateParam && q.code;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><meta charset="utf-8"><title>Sidenote</title><body style="font:16px system-ui;padding:48px;text-align:center;color:#222">` +
              (ok ? '<h2>Sidenote is connected to ChatGPT</h2><p>You can close this tab.</p>' : '<h2>Sign-in did not finish</h2><p>Go back to Sidenote and try again.</p>') +
              '</body>'
          );
          clearTimeout(timer);
          resolve(q);
        });
        openInLastBrowser(`${AUTHORIZE_URL}?${params}`);
      });
    } finally {
      this.signInAbort = null;
      server.close();
    }

    if (callback.state !== stateParam) throw new DirectError('Sign-in failed a security check (state mismatch). Try again.');
    if (callback.error) {
      if (callback.error === 'access_denied') {
        this.state.needsConsent = true;
        this.save();
        throw new DirectError('Sign-in was declined, so Sidenote can\'t use your ChatGPT plan.');
      }
      throw new DirectError(`Sign-in failed: ${callback.error_description || callback.error}`);
    }

    const clientId = callback.client_id || known;
    if (!clientId) throw new DirectError('OpenAI did not return a client id for Sidenote.');

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callback.code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: API,
    });
    const claims = await this.verifyIdToken(tokens.id_token, clientId, nonce);

    const scope = String(tokens.scope || callback.scope || '');
    this.state = {
      ...this.state,
      clientId,
      idToken: tokens.id_token,
      account: { sub: claims.sub, email: claims.email || null, name: claims.name || null },
      tokens: this.tokenRecord(tokens, scope),
      needsConsent: !scope.split(' ').includes(PLAN_SCOPE),
    };
    this.modelCache = null;
    this.save();
    return this.status();
  }

  cancelSignIn() {
    this.signInAbort?.();
  }

  tokenRecord(t, scope) {
    return {
      access: t.access_token,
      refresh: t.refresh_token || this.state.tokens?.refresh || null,
      scope: scope || t.scope || this.state.tokens?.scope || '',
      expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    };
  }

  async tokenRequest(form) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new DirectError(body.error_description || body.error || `Token request failed (${res.status}).`, {
        code: body.error,
        status: res.status,
      });
    }
    return body;
  }

  /** ID token checks from the docs: JWKS signature, iss, aud, exp, nonce. */
  async verifyIdToken(idToken, clientId, nonce) {
    const [h, p, s] = String(idToken || '').split('.');
    if (!h || !p || !s) throw new DirectError('OpenAI returned an invalid ID token.');
    const header = JSON.parse(fromB64url(h).toString('utf8'));
    const claims = JSON.parse(fromB64url(p).toString('utf8'));

    const config = await (await fetch(`${AUTH}/.well-known/openid-configuration`)).json();
    const jwks = await (await fetch(config.jwks_uri)).json();
    const jwk = (jwks.keys || []).find((k) => k.kid === header.kid) || (jwks.keys || [])[0];
    if (!jwk) throw new DirectError('Could not load OpenAI\'s signing keys.');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${h}.${p}`);
    const sig = fromB64url(s);
    let valid = false;
    if (header.alg === 'RS256') valid = crypto.verify('RSA-SHA256', data, key, sig);
    else if (header.alg === 'ES256') valid = crypto.verify('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    else throw new DirectError(`Unsupported ID token algorithm ${header.alg}.`);
    if (!valid) throw new DirectError('The ID token signature did not verify.');

    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== (config.issuer || AUTH)) throw new DirectError('The ID token came from an unexpected issuer.');
    if (!aud.includes(clientId)) throw new DirectError('The ID token was issued for a different app.');
    if (!claims.exp || claims.exp < now - 60) throw new DirectError('The ID token has expired.');
    if (claims.nonce !== nonce) throw new DirectError('Sign-in failed a security check (nonce mismatch).');
    return claims;
  }

  /** A valid access token, refreshed when it's within two minutes of expiry. */
  async accessToken() {
    const t = this.state.tokens;
    if (!t) throw new DirectError('Not signed in to ChatGPT.', { needsSignIn: true });
    if (t.expiresAt - Date.now() > 120_000) return t.access;
    if (!t.refresh) {
      this.clearTokens();
      throw new DirectError('Your ChatGPT sign-in expired. Sign in again.', { needsSignIn: true });
    }
    // One refresh at a time: the refresh token rotates.
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const next = await this.tokenRequest({
            grant_type: 'refresh_token',
            client_id: this.state.clientId,
            refresh_token: t.refresh,
            resource: API,
          });
          this.state.tokens = this.tokenRecord(next, next.scope);
          this.save();
        } catch (err) {
          const terminal = ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'];
          if (terminal.includes(err.code)) {
            this.clearTokens();
            throw new DirectError('Your ChatGPT sign-in has ended. Sign in again.', { needsSignIn: true });
          }
          throw err; // network trouble: keep credentials
        } finally {
          this.refreshing = null;
        }
      })();
    }
    await this.refreshing;
    return this.state.tokens.access;
  }

  async signOut() {
    this.cancel();
    const refresh = this.state.tokens?.refresh;
    let revoked = !refresh;
    if (refresh) {
      try {
        const config = await (await fetch(`${AUTH}/.well-known/openid-configuration`)).json();
        const res = await fetch(config.revocation_endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: refresh, token_type_hint: 'refresh_token', client_id: this.state.clientId }).toString(),
        });
        revoked = res.ok;
      } catch (_) {
        revoked = false;
      }
    }
    this.history = [];
    this.clearTokens();
    return { ok: true, revoked };
  }

  /* ── models ───────────────────────────────────────────────────────── */

  async models() {
    if (this.modelCache && Date.now() - this.modelCache.at < 10 * 60_000) return this.modelCache.value;
    const res = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    const body = await res.json().catch(() => ({}));
    const list = (body.models || body.data || [])
      .filter((m) => !m.visibility || m.visibility === 'list')
      .map((m) => ({
        id: m.slug || m.id,
        name: m.display_name || m.slug || m.id,
        description: m.description || '',
        efforts: (m.supported_reasoning_levels || []).map((l) => l.effort || l).filter((e) => EFFORTS.includes(e)),
        defaultEffort: m.default_reasoning_level || null,
      }))
      .filter((m) => m.id);
    const value = { models: list, efforts: EFFORTS, configModel: list[0]?.id || null, configEffort: null };
    if (res.ok) this.modelCache = { at: Date.now(), value };
    return value;
  }

  /* ── asking ───────────────────────────────────────────────────────── */

  newChat() {
    this.history = [];
  }

  cancel() {
    this.controller?.abort();
  }

  /** One streamed Responses call; resolves with the completed response. */
  async respond(body, signal) {
    const res = await fetch(`${API}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...body, store: false, stream: true }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed = {};
      try {
        parsed = JSON.parse(text);
      } catch (_) {
        /* plain text */
      }
      const err = parsed.error || {};
      throw new DirectError(err.message || parsed.detail || text.slice(0, 300) || `Request failed (${res.status}).`, {
        status: res.status,
        code: err.code || null,
        param: err.param || null,
      });
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let completed = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (!data || data === '[DONE]') continue;
        let ev;
        try {
          ev = JSON.parse(data);
        } catch (_) {
          continue;
        }
        if (ev.type === 'response.completed') completed = ev.response;
        else if (ev.type === 'response.failed' || ev.type === 'response.incomplete') {
          const e = ev.response?.error || {};
          throw new DirectError(e.message || 'ChatGPT could not finish the answer.', { code: e.code || null });
        } else if (ev.type === 'error') {
          const e = ev.error || ev;
          throw new DirectError(e.message || 'ChatGPT returned an error.', { code: e.code || null });
        }
      }
    }
    if (!completed) throw new DirectError('The answer stream ended early.');
    return completed;
  }

  /**
   * Answers one question. Sidenote's items go in `instructions`; file tools
   * are offered for the chosen folder. Returns { ok, text } like Codex.ask.
   */
  async ask({ prompt, image, data, manage, onStatus }) {
    if (this.controller) return { ok: false, error: 'ChatGPT is still working on the last question.' };
    const s = this.settings.get();
    const controller = new AbortController();
    this.controller = controller;

    const filesNote = `You can look at files in the user's chosen folder (${this.files.root()}) with the list_files, find_files and read_file tools. They are read-only; you cannot change files.`;
    const instructions = manage
      ? assistant.context(data, filesNote)
      : `You are the assistant inside Sidenote, a desktop widget. ${filesNote} Answer briefly and plainly.`;

    const userContent = [{ type: 'input_text', text: prompt }];
    if (image) userContent.push({ type: 'input_image', image_url: `data:image/png;base64,${image}` });
    const input = [...this.history, { role: 'user', content: userContent }];

    const body = { model: s.directModel || undefined, instructions, tools: TOOLS, parallel_tool_calls: true };
    if (EFFORTS.includes(s.directEffort)) body.reasoning = { effort: s.directEffort };
    if (manage) {
      body.text = { format: { type: 'json_schema', name: 'sidenote_reply', strict: true, schema: assistant.SCHEMA } };
    }

    try {
      onStatus?.(this.history.length ? 'Continuing the chat…' : 'Asking ChatGPT…');
      let answer = '';
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        if (!body.model) {
          const m = await this.models().catch(() => null);
          body.model = m?.models?.[0]?.id;
          if (!body.model) throw new DirectError('No ChatGPT model is available for this account.');
        }
        const response = await this.respond({ ...body, input }, controller.signal);
        const calls = [];
        answer = '';
        for (const item of response.output || []) {
          if (item.type === 'function_call') {
            calls.push(item);
            // Re-sent without its server id: nothing is stored server-side.
            input.push({ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments });
          } else if (item.type === 'message') {
            answer += (item.content || []).filter((c) => c.type === 'output_text').map((c) => c.text).join('');
          }
        }
        if (!calls.length) break;
        if (round === MAX_TOOL_ROUNDS) throw new DirectError('ChatGPT kept looking through files without finishing. Try a narrower question.');
        for (const call of calls) {
          let args = {};
          try {
            args = JSON.parse(call.arguments || '{}');
          } catch (_) {
            /* bad JSON: the tool reports it */
          }
          const result = await this.files.run(call.name, args, onStatus);
          input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result).slice(0, 120_000) });
        }
        onStatus?.('Thinking…');
      }

      const reply = manage ? assistant.parseAnswer(answer).reply : answer.trim();
      this.history.push({ role: 'user', content: prompt }, { role: 'assistant', content: reply || answer });
      this.history = this.history.slice(-MAX_HISTORY);
      return { ok: true, text: answer.trim() };
    } catch (err) {
      if (controller.signal.aborted) return { ok: false, error: 'Stopped.', stopped: true };
      return { ok: false, ...this.explain(err) };
    } finally {
      this.controller = null;
    }
  }

  /** Error → message for the Ask bar, following OpenAI's recovery guide. */
  explain(err) {
    const code = err.code;
    if (err.needsSignIn || code === 'subscription_sharing_invalid_user' || err.status === 401) {
      return { error: err.needsSignIn ? err.message : 'ChatGPT didn\'t accept the sign-in. Sign in again from Settings → ChatGPT.', needsSignIn: true };
    }
    if (code === 'subscription_sharing_usage_limit_exceeded' || err.status === 429) {
      return { error: `You've reached the share of your ChatGPT plan that Sidenote may use for now. See ChatGPT → Settings → Usage (${USAGE_URL}) to check or raise it.` };
    }
    if (code === 'subscription_sharing_user_not_eligible') {
      return { error: 'Your ChatGPT plan or workspace can\'t be used by other apps. Use the Codex connection instead.' };
    }
    if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || err.status === 503) {
      return { error: 'ChatGPT couldn\'t check your plan usage right now. Try again in a minute.' };
    }
    if (code === 'subscription_sharing_unsupported_capability') {
      return { error: `ChatGPT doesn't support "${err.param || 'that option'}" for this connection. Try another model or thinking level.` };
    }
    if (err.name === 'TypeError' && /fetch/i.test(err.message)) {
      return { error: 'Couldn\'t reach ChatGPT. Check your internet connection.' };
    }
    return { error: err.message || 'ChatGPT returned an error.' };
  }

  destroy() {
    this.cancel();
    this.cancelSignIn();
  }
}

module.exports = { ChatGptDirect };
