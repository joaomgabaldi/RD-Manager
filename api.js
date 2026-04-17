export const API_BASE = 'https://api.real-debrid.com/rest/1.0';
export const OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
export const TIMEOUT_DEFAULT_MS = 10_000;

export function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

export async function getValidToken() {
  const data = await browser.storage.local.get(['rd_access_token', 'rd_refresh_token', 'rd_oauth_client_id', 'rd_oauth_client_secret', 'rd_token_expires_at']);
  if (!data.rd_access_token) return null;

  if (Date.now() > data.rd_token_expires_at - 60000) {
    try {
      const res = await fetch(`${OAUTH_BASE}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: data.rd_oauth_client_id,
          client_secret: data.rd_oauth_client_secret,
          code: data.rd_refresh_token,
          grant_type: 'http://oauth.net/grant_type/device/1.0'
        }).toString()
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 400) {
          await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token', 'rd_token_expires_at']);
        }
        return null;
      }
      const tokenData = await res.json();
      const newExpiry = Date.now() + (tokenData.expires_in * 1000);
      await browser.storage.local.set({
        rd_access_token: tokenData.access_token,
        rd_refresh_token: tokenData.refresh_token,
        rd_token_expires_at: newExpiry
      });
      return tokenData.access_token;
    } catch (_) {
      return null;
    }
  }
  return data.rd_access_token;
}

export async function apiGet(path, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } }, timeoutMs);
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token']);
      throw new Error('Unauthenticated');
    }
    if (res.status === 404) return null;
    throw new Error(`API error (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export async function apiPost(path, body, isForm = false, timeoutMs = null) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');
  const headers = { Authorization: `Bearer ${token}` };
  let fetchBody;

  if (isForm) fetchBody = body;
  else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    fetchBody = new URLSearchParams(body).toString();
  }

  const fetchFn = timeoutMs
    ? fetchWithTimeout(`${API_BASE}${path}`, { method: 'POST', headers, body: fetchBody }, timeoutMs)
    : fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: fetchBody });

  const res = await fetchFn;
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token']);
      throw new Error('Unauthenticated');
    }
    throw new Error(`API error (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function apiDelete(path, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }, timeoutMs);
  if (!res.ok && res.status !== 204) {
    if (res.status === 401 || res.status === 403) {
      await browser.storage.local.remove(['rd_access_token', 'rd_refresh_token']);
      throw new Error('Unauthenticated');
    }
    throw new Error(`API error (${res.status})`);
  }
  return null;
}

export async function trackId(id) {
  const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
  const tracked = new Set(rd_tracked_ids || []);
  tracked.add(String(id));
  await browser.storage.local.set({ rd_tracked_ids: [...tracked] });
}
