/* ============================================
   Real-Debrid Manager — Chrome Extension Logic
   ============================================ */

const API_BASE = 'https://api.real-debrid.com/rest/1.0'; // NOTE: must match API_BASE in background.js

// ---- State ----
let apiKey = '';
let currentTab = 'all';
let currentTypeFilter = null; // independent type overlay: 'torrent', 'web', or null
let searchQuery = '';
let ageFilterDays = null; // null = off, 1/7/30 = older than N days
let allDownloads = [];
let notifications = []; // local notifications from chrome.storage
let autoRefreshInterval = null;
const AUTO_REFRESH_MS = 5000;
let currentFiltered = []; // Vai guardar a lista final (após buscas/filtros)
let visibleCount = 50;    // Quantos itens vamos desenhar na tela por vez

// ---- DOM element map for download items ----
const dlElementMap = new Map(); // id string → <li> element

// ---- Cached storage values ----
let cachedNotificationsEnabled = true;  // default on

// ---- DOM refs ----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await loadCachedStorageValues();
  bindEvents();
  if (apiKey) {
    // Load cached data first for instant display
    await loadCachedData();
    // Load local notifications from storage
    await loadLocalNotifications();
    // Fetch fresh downloads and user info in background
    refreshInBackground();
    fetchUserInfo();
  } else {
    showState('no-api');
  }
});

// Explicitly stop the auto-refresh interval when the popup is closed.
// The popup context is destroyed on close anyway, so this is a no-op today —
// but it prevents a real leak if the UI is ever promoted to a side panel
// or persistent window, where the page survives across "closes".
window.addEventListener('pagehide', () => {
  stopAutoRefresh();
});

// ---- Cached storage sync ----
async function loadCachedStorageValues() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['rd_notifications_enabled'], (data) => {
      cachedNotificationsEnabled = data.rd_notifications_enabled !== false;
      resolve();
    });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if ('rd_notifications_enabled' in changes) {
    cachedNotificationsEnabled = changes.rd_notifications_enabled.newValue !== false;
  }
  if ('rd_local_notifications' in changes) {
    loadLocalNotifications();
  }
});

// ---- Cache Management ----
async function loadCachedData() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['rd_cached_downloads', 'rd_cached_user', 'rd_cleared_ids'], (data) => {
      if (data.rd_cached_downloads && data.rd_cached_downloads.length > 0) {
        allDownloads = data.rd_cached_downloads;
        renderDownloads();
      }
      if (data.rd_cached_user) {
        showUserBar(data.rd_cached_user);
      }
      if (!data.rd_cached_downloads || data.rd_cached_downloads.length === 0) {
        showState('loading');
      }
      resolve();
    });
  });
}


function cacheData(downloads) {
  chrome.storage.local.set({
    rd_cached_downloads: downloads,
  });
}

function refreshInBackground() {
  const btn = $('#btn-refresh');
  if (btn.classList.contains('syncing')) return;
  
  btn.classList.add('syncing');
  
  // Passamos "true" para avisar que é um sync silencioso
  fetchAll(true).finally(() => {
    btn.classList.remove('syncing');
    btn.classList.add('synced');
    
    setTimeout(() => {
      btn.classList.remove('synced');
    }, 1500);
  });
}

function startAutoRefresh() {
  if (autoRefreshInterval) return;
  autoRefreshInterval = setInterval(() => {
    if (allDownloads.some(d => !isCompleted(d))) {
      refreshInBackground();
    } else {
      stopAutoRefresh();
    }
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
    autoRefreshInterval = null;
  }
}

// ---- Settings ----
async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['rd_api_key', 'rd_theme', 'rd_hover_lift', 'rd_accent_color', 'rd_max_height'], (data) => {
      apiKey = data.rd_api_key || '';
      const theme = data.rd_theme || 'dark';
      document.documentElement.setAttribute('data-theme', theme);
      const hoverLift = data.rd_hover_lift !== false ? 'on' : 'off';
      document.documentElement.setAttribute('data-hover-lift', hoverLift);
      if (data.rd_accent_color) applyAccentColor(data.rd_accent_color);
      applyMaxHeight(data.rd_max_height || 400);
      resolve();
    });
  });
}

function applyMaxHeight(px) {
  document.body.style.maxHeight = px + 'px';
}

function saveApiKey(key) {
  apiKey = key;
  chrome.storage.local.set({ rd_api_key: key });
}

function saveTheme(theme) {
  chrome.storage.local.set({ rd_theme: theme });
}

async function trackId(id) {
  const { rd_tracked_ids } = await chrome.storage.local.get('rd_tracked_ids');
  const tracked = new Set(rd_tracked_ids || []);
  tracked.add(String(id));
  await chrome.storage.local.set({ rd_tracked_ids: [...tracked] });
}

// ---- Accent color customisation ----
function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function darkenHex(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const clamp = v => Math.max(0, Math.min(255, Math.round(v * (1 - amount))));
  return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function lightenHex(hex, amount) {
  const [r, g, b] = hexToRgb(hex);
  const clamp = v => Math.max(0, Math.min(255, Math.round(v + (255 - v) * amount)));
  return `#${[clamp(r), clamp(g), clamp(b)].map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

function applyAccentColor(hex) {
  if (!hex) return;
  const [r, g, b] = hexToRgb(hex);
  const lum = luminance(r, g, b);
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

  const hover = isDark ? lightenHex(hex, 0.15) : darkenHex(hex, 0.15);
  const dimAlpha = isDark ? 0.13 : 0.12;
  const textColor = lum > 0.4 ? '#101114' : '#ffffff';

  const root = document.documentElement;
  root.style.setProperty('--accent', hex);
  root.style.setProperty('--accent-hover', hover);
  root.style.setProperty('--accent-dim', `rgba(${r}, ${g}, ${b}, ${dimAlpha})`);
  root.style.setProperty('--accent-scroll', `rgba(${r}, ${g}, ${b}, 0.45)`);
  root.style.setProperty('--accent-scroll-hover', `rgba(${r}, ${g}, ${b}, 0.60)`);
  root.style.setProperty('--accent-text', textColor);
  root.style.setProperty('--border-focus', hex);
}

function clearAccentColor() {
  const root = document.documentElement;
  ['--accent', '--accent-hover', '--accent-dim', '--accent-scroll', '--accent-scroll-hover', '--accent-text', '--border-focus'].forEach(p => root.style.removeProperty(p));
}

// ---- Events ----
let deleteHoldTimer = null;
let deleteAllHoldTimer = null;

function bindEvents() {
  // Theme toggle
  $('#btn-theme').addEventListener('click', () => {
    const html = document.documentElement;
    const current = html.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    saveTheme(next);
    chrome.storage.local.get('rd_accent_color', (data) => {
      if (data.rd_accent_color) applyAccentColor(data.rd_accent_color);
    });
  });

  // Logo icon opens dashboard
  $('.logo-icon').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://real-debrid.com/torrents', active: true });
  });

  // Ko-fi support link
  $('#btn-kofi').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://ko-fi.com/toolsrf', active: true });
  });

  // Settings (API key)
  $('#btn-settings').addEventListener('click', showApiKeyModal);
  $('#btn-setup-api').addEventListener('click', showApiKeyModal);

  // Notifications
  $('#btn-notifications').addEventListener('click', showNotificationsModal);

  // Add Torrent
  $('#btn-add-torrent').addEventListener('click', showTorrentModal);

  // Add Web Link
  $('#btn-add-webdl').addEventListener('click', showWebLinkModal);

  // Refresh
  $('#btn-refresh').addEventListener('click', () => {
    const btn = $('#btn-refresh');
    // Don't trigger if already syncing
    if (btn.classList.contains('syncing')) return;
    refreshInBackground();
  });

  // Type cycle button — independent overlay on status tabs
  const cycleBtn = $('#tab-type-cycle');
  const cycleStates = [
    { type: 'torrent', label: 'TOR ↻' },
    { type: 'web',      label: 'WEB ↻' },
  ];
  let cycleIndex = -1; // -1 = inactive

  cycleBtn.addEventListener('click', () => {
    cycleIndex = (cycleIndex + 1) % (cycleStates.length + 1);

    // Reset back to "Type" after the last state
    if (cycleIndex === cycleStates.length) {
      cycleIndex = -1;
      cycleBtn.textContent = 'Type';
      cycleBtn.dataset.cycleState = 'none';
      delete cycleBtn.dataset.cycleType;
      cycleBtn.classList.remove('active');
      currentTypeFilter = null;
	  visibleCount = 50;
      renderDownloads();
      return;
    }

    const state = cycleStates[cycleIndex];
    cycleBtn.classList.add('active');
    cycleBtn.dataset.cycleState = 'active';
    cycleBtn.dataset.cycleType = state.type;
    cycleBtn.textContent = state.label;
    currentTypeFilter = state.type;
	visibleCount = 50;
    renderDownloads();
  });

 // Tabs (excluding the cycle button and delete-all, handled separately)
  $$('.tab:not(#tab-type-cycle):not(#btn-delete-all)').forEach((tab) => {
    tab.addEventListener('click', () => {
      // Don't reset the type filter when switching status tabs
      $$('.tab:not(#tab-type-cycle):not(#btn-delete-all)').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      currentTab = tab.dataset.tab;

      visibleCount = 50;
      renderDownloads();
    });
  });

  // Delete All (hold 2s)
  const deleteAllBtn = $('#btn-delete-all');
  deleteAllBtn.addEventListener('mousedown', () => {
    if (!apiKey || allDownloads.length === 0) return;
    deleteAllBtn.classList.remove('no-transition');
    deleteAllBtn.classList.add('holding');
    deleteAllHoldTimer = setTimeout(() => {
      deleteAllBtn.classList.add('no-transition');
      deleteAllBtn.classList.remove('holding');
      deleteAllVisible();
    }, 1500);
  });
  const cancelDeleteAll = () => {
    deleteAllBtn.classList.add('no-transition');
    deleteAllBtn.classList.remove('holding');
    if (deleteAllHoldTimer) {
      clearTimeout(deleteAllHoldTimer);
      deleteAllHoldTimer = null;
    }
  };
  deleteAllBtn.addEventListener('mouseup', cancelDeleteAll);
  deleteAllBtn.addEventListener('mouseleave', cancelDeleteAll);

// Search input
  $('#search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase().trim();
    visibleCount = 50; // Reseta o Infinite Scroll a cada nova letra digitada!
    renderDownloads();
  });

  // Age filter dropdown
  const ageBtn = $('#btn-age-filter');
  const ageMenu = $('#age-filter-menu');

  ageBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !ageMenu.classList.contains('hidden');
    ageMenu.classList.toggle('hidden');
    ageBtn.classList.toggle('open', !isOpen);
  });

  document.addEventListener('click', () => {
    ageMenu.classList.add('hidden');
    ageBtn.classList.remove('open');
  });

  ageMenu.addEventListener('click', (e) => e.stopPropagation());

  $$('.age-filter-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const days = opt.dataset.age ? parseInt(opt.dataset.age) : null;
      ageFilterDays = days;
      updateAgeFilterUI();
      ageMenu.classList.add('hidden');
      ageBtn.classList.remove('open');
	  visibleCount = 50;
      renderDownloads();
    });
  });

  // Modal close
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', (e) => {
    if (e.target === $('#modal-overlay')) closeModal();
  });

// Download list event delegation
  $('#download-list').addEventListener('click', handleListClick);
  // APAGUE ESTAS 3 LINHAS ABAIXO:
  // $('#download-list').addEventListener('mousedown', handleDeleteHoldStart);
  // $('#download-list').addEventListener('mouseup', handleDeleteHoldEnd);
  // $('#download-list').addEventListener('mouseleave', handleDeleteHoldEnd, true);
  // Infinite Scroll - Escuta a rolagem da lista
  $('#downloads-container').addEventListener('scroll', (e) => {
    const el = e.target;
    // Se a distância para o final for menor que 100px...
    if (el.scrollHeight - el.scrollTop <= el.clientHeight + 100) {
      // E ainda tivermos itens escondidos no Array filtrado...
      if (visibleCount < currentFiltered.length) {
        visibleCount += 50; // Libera mais 50
        renderDownloads();  // Pede para desenhar
      }
    }
  });
}

function handleListClick(e) {
  // Handle download button in header
  const dlBtn = e.target.closest('.dl-download-btn');
  if (dlBtn) {
    downloadFile(dlBtn.dataset.type, dlBtn.dataset.id);
    return;
  }

// Handle delete button - click to delete
  const deleteBtn = e.target.closest('.dl-delete-btn');
  if (deleteBtn) {
    deleteDownload(deleteBtn.dataset.type, deleteBtn.dataset.id);
    return;
  }

  // Clicking anywhere on a file row triggers the download
  const fileItem = e.target.closest('.dl-file-item:not(.dl-file-info)');
  if (fileItem) {
    const btn = fileItem.querySelector('.dl-file-download');
    if (btn) {
      downloadFile(btn.dataset.type, btn.dataset.id);
    }
    return;
  }

  // Collapse/expand only when clicking outside the file list
  const item = e.target.closest('.dl-item');
  if (item && !e.target.closest('.dl-expanded-content')) {
    const isExpanding = !item.classList.contains('expanded');
    item.classList.toggle('expanded');

    // Lazy-load torrent file info from RD when expanding a completed torrent with no files or links
    if (isExpanding) {
      const dlId = item.dataset.id;
      const dl = allDownloads.find(d => String(d.id) === dlId);
      if (dl && dl._type === 'torrent' && isCompleted(dl)
        && ((dl.files || []).length === 0 || (dl.links || []).length === 0)) {
        fetchTorrentFiles(dl, item);
      }
    }
  }
}

// Parse RD /torrents/info response into our internal files/links format
function parseTorrentInfo(info) {
  const selectedFiles = (info.files || []).filter(f => f.selected === 1);
  return {
    links: info.links || [],
    files: selectedFiles.map((f, idx) => ({
      id: idx,
      name: f.path ? f.path.replace(/^\//, '') : `File ${idx + 1}`,
      short_name: f.path ? f.path.split('/').pop() : `File ${idx + 1}`,
      size: f.bytes || 0,
    })),
  };
}

// Lazy-fetch torrent file details when expanding (fallback if preload missed it)
async function fetchTorrentFiles(dl, itemEl) {
  try {
    const info = await apiGet(`/torrents/info/${dl.id}`);
    if (!info) return;

    const parsed = parseTorrentInfo(info);
    dl.links = parsed.links;
    dl.files = parsed.files;

    // Update the expanded content in the DOM
    const existingExpanded = itemEl.querySelector('.dl-expanded-content');
    const newExpanded = renderExpandedContent(dl);
    if (existingExpanded) {
      existingExpanded.replaceWith(newExpanded);
    }
    itemEl.dataset.fileCount = String(dl.files.length);

    cacheData(allDownloads);
  } catch (err) {
    console.error('Failed to fetch torrent files:', err);
  }
}

// Preload file info for all completed torrents that don't have files or links yet
// Preload file info ONLY for torrents that are currently visible on the screen
async function preloadTorrentFiles() {
  // Pega os IDs apenas dos itens que a interface montou na tela agora
  const visibleIds = new Set(currentFiltered.slice(0, visibleCount).map(d => String(d.id)));

  const needsInfo = allDownloads.filter(
    dl => visibleIds.has(String(dl.id)) && // A mágica está aqui!
          dl._type === 'torrent' && 
          isCompleted(dl) && 
          ((dl.files || []).length === 0 || (dl.links || []).length === 0)
  );
  
  if (needsInfo.length === 0) return;

  let changed = false;

  for (const dl of needsInfo) {
    try {
      const info = await apiGet(`/torrents/info/${dl.id}`);
      if (info) {
        const parsed = parseTorrentInfo(info);
        dl.links = parsed.links;
        dl.files = parsed.files;
        changed = true;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    } catch (err) {
      console.warn(`Failed to preload info for ${dl.id}:`, err);
      if (err.message && err.message.includes('429')) {
        console.warn('Real-Debrid rate limit hit. Pausing background preload.');
        break; 
      }
    }
  }

  if (changed) {
    cacheData(allDownloads);
    renderDownloads();
  }
}

async function deleteDownload(type, id) {
  // 1. Encontra o elemento na interface e aplica um estado visual de "carregando"
  const itemElement = dlElementMap.get(String(id)) || document.querySelector(`.dl-delete-btn[data-id="${id}"]`)?.closest('.dl-item');
  if (itemElement) {
    itemElement.style.opacity = '0.5'; // Deixa meio transparente
    itemElement.style.pointerEvents = 'none'; // Previne que o usuário clique duas vezes
  }

  // 2. Faz a requisição para a API primeiro
  try {
    if (type === 'torrent') {
      toast('Deleting...', 'success');
      await apiDelete(`/torrents/delete/${id}`);
    } else if (type === 'web') {
      // Web downloads são locais, apenas removemos do storage
      const { rd_local_downloads } = await chrome.storage.local.get('rd_local_downloads');
      if (rd_local_downloads) {
        const updated = rd_local_downloads.filter(d => String(d.id) !== String(id));
        await chrome.storage.local.set({ rd_local_downloads: updated });
      }
    }

    // 3. SUCESSO! A API confirmou. Agora sim animamos a saída e removemos do DOM
    if (itemElement) {
      itemElement.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
      itemElement.style.opacity = '0';
      itemElement.style.transform = 'translateX(-10px)';
      setTimeout(() => itemElement.remove(), 150);
    }
    dlElementMap.delete(String(id));
    
    // 4. Atualiza os dados locais e o cache
    allDownloads = allDownloads.filter(dl => String(dl.id) !== String(id));
    cacheData(allDownloads);

    // Verifica se a lista ficou vazia
    if (allDownloads.length === 0) {
      showState('empty');
    }

    toast('Removed', 'success');

  } catch (err) {
    // ERRO: A API falhou. Nós revertemos a interface para o estado normal.
    console.error('Delete failed:', err);
    toast('Delete failed', 'error');
    
    if (itemElement) {
      itemElement.style.opacity = '1'; // Tira a transparência
      itemElement.style.pointerEvents = 'auto'; // Devolve o clique
    }
  }
}

async function deleteAllVisible() {
  let targets = allDownloads;
  switch (currentTab) {
    case 'downloading': targets = targets.filter(d => !isCompleted(d)); break;
    case 'completed':   targets = targets.filter(d => isCompleted(d)); break;
    case 'search':
      targets = searchQuery
        ? targets.filter(d => (d.name || '').toLowerCase().includes(searchQuery))
        : targets;
      targets = filterByAge(targets, ageFilterDays);
      break;
  }
  // Apply type overlay
  if (currentTypeFilter) {
    targets = targets.filter(d => d._type === currentTypeFilter);
  }

  if (targets.length === 0) return;

  // Optimistic: animate all visible items out
  document.querySelectorAll('.dl-item').forEach(el => {
    el.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    el.style.opacity = '0';
    el.style.transform = 'translateX(-10px)';
  });
  setTimeout(() => {
    const ids = new Set(targets.map(d => String(d.id)));
    allDownloads = allDownloads.filter(d => !ids.has(String(d.id)));
    cacheData(allDownloads);
    renderDownloads();
  }, 150);

  toast('Deleting...', 'success');

  let failed = 0;
  // Separate torrents (API delete) from web items (local delete)
  const webTargets = targets.filter(dl => dl._type === 'web');
  const torrentTargets = targets.filter(dl => dl._type === 'torrent');

  // Remove local web downloads
  if (webTargets.length > 0) {
    const webIds = new Set(webTargets.map(d => String(d.id)));
    const { rd_local_downloads } = await chrome.storage.local.get('rd_local_downloads');
    if (rd_local_downloads) {
      const updated = rd_local_downloads.filter(d => !webIds.has(String(d.id)));
      await chrome.storage.local.set({ rd_local_downloads: updated });
    }
  }

  // Delegate torrent deletions to background worker (survives popup close)
  if (torrentTargets.length > 0) {
    chrome.runtime.sendMessage({
      action: 'delete-torrents',
      ids: torrentTargets.map(dl => dl.id),
    });
  }
}

async function downloadFile(type, id) {
  toast('Downloading...', 'success');
  try {
    const dl = allDownloads.find(d => String(d.id) === String(id));

    if (type === 'web' && dl?._rd_download) {
      triggerDownload(dl._rd_download);
      return;
    }

    if (type === 'torrent') {
      let links = dl?.links || [];
      if (links.length === 0) {
        const info = await apiGet(`/torrents/info/${id}`);
        links = info?.links || [];
      }

      if (links.length > 0) {
        const unrestricted = await apiPost('/unrestrict/link', { link: links[0] }, false, TIMEOUT_DOWNLOAD_MS);
        if (unrestricted?.download) {
          triggerDownload(unrestricted.download);
        } else {
          toast('Failed to get download link', 'error');
        }
      } else {
        toast('No download links available', 'error');
      }
      return;
    }

    toast('Unknown download type', 'error');
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Download request timed out' : 'Failed to download';
    toast(msg, 'error');
  }
}

function triggerDownload(url) {
  if (!String(url).startsWith('https://')) {
    toast('Invalid download link', 'error');
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---- API Helpers ----

// Timeout durations
const TIMEOUT_DEFAULT_MS  = 10_000; // list fetches, user info, completion checks
const TIMEOUT_VALIDATE_MS = 10_000; // API key validation
const TIMEOUT_DOWNLOAD_MS = 10_000; // download link requests
// No timeout for add-download operations — Real-Debrid can take 30s+

function fetchWithTimeout(url, options = {}, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function apiGet(path, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  }, timeoutMs);
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`API error (${res.status})`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

async function apiPost(path, body, isForm = false, timeoutMs = null) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  let fetchBody;

  if (isForm) {
    fetchBody = body; // FormData
  } else {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    fetchBody = new URLSearchParams(body).toString();
  }

  // No timeout for add-download operations (timeoutMs === null)
  const fetchFn = timeoutMs
    ? fetchWithTimeout(`${API_BASE}${path}`, { method: 'POST', headers, body: fetchBody }, timeoutMs)
    : fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: fetchBody });

  const res = await fetchFn;
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (res.status === 204) return null;
  return res.json();
}

async function apiDelete(path, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  }, timeoutMs);
  if (!res.ok && res.status !== 204) throw new Error(`API error (${res.status})`);
  return null;
}

// ---- Fetch all downloads ----
// ---- Fetch all downloads ----
// ---- Fetch all downloads ----
async function fetchAll(isBackgroundSync = false) {
  if (!apiKey) return showState('no-api');

  if (allDownloads.length === 0) {
    showState('loading');
  }

  try {
    let torrentsRes = [];
    try {
      let page = 1;
      const limit = 100;
      let hasMore = true;
      
      while (hasMore) {
        const res = await apiGet(`/torrents?limit=${limit}&page=${page}`);
        
        if (Array.isArray(res) && res.length > 0) {
          torrentsRes.push(...res);
          // SEGUNDO SEGREDO: Se for sync de background, paramos na página 1!
          if (res.length < limit || isBackgroundSync) {
            hasMore = false;
          } else {
            page++;
          }
        } else {
          hasMore = false; 
        }
      }
    } catch (err) {
      console.warn('Failed to fetch torrents:', err);
    }

    if (isBackgroundSync && allDownloads.length > 0) {
      // MERGE MODE: Atualiza os status dos itens existentes sem apagar o histórico antigo
      const freshData = new Map();
      torrentsRes.forEach(t => freshData.set(String(t.id), normalizeTorrent(t)));

      allDownloads = allDownloads.map(dl => {
        if (freshData.has(String(dl.id))) {
          const updated = freshData.get(String(dl.id));
          updated.files = dl.files; // Preserva arquivos que já tínhamos cacheado
          updated.links = dl.links;
          freshData.delete(String(dl.id));
          return updated;
        }
        return dl;
      });

      // Adiciona novos torrents (se houver) no topo da lista
      const newItems = Array.from(freshData.values());
      allDownloads = [...newItems, ...allDownloads];
    } else {
      // FULL LOAD: Quando você abre a extensão, ele varre tudo
      allDownloads = [];
      if (Array.isArray(torrentsRes)) {
        torrentsRes.forEach((t) => allDownloads.push(normalizeTorrent(t)));
      }
    }

    // Mescla os downloads locais da web (links desrestritos)
    const { rd_local_downloads } = await chrome.storage.local.get('rd_local_downloads');
    if (rd_local_downloads && rd_local_downloads.length > 0) {
      const expiryCutoff = Date.now() - 7 * 86400000;
      const valid = rd_local_downloads.filter(d => new Date(d.created_at).getTime() > expiryCutoff);
      if (valid.length !== rd_local_downloads.length) {
        chrome.storage.local.set({ rd_local_downloads: valid });
      }
      // Remove da lista atual e insere de volta para evitar itens duplicados no merge
      allDownloads = allDownloads.filter(d => d._type !== 'web');
      valid.forEach(d => allDownloads.push(d));
    }
	
	// Ordenação real e definitiva pela data de adição no Real-Debrid
    allDownloads.sort((a, b) => {
      const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
      const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
      return dateB - dateA; // Descendente: do mais novo para o mais velho
    });

    // Restaura as infos de arquivos que já puxamos antes
    const { rd_cached_downloads } = await chrome.storage.local.get('rd_cached_downloads');
    if (rd_cached_downloads) {
      const cachedById = new Map();
      rd_cached_downloads.forEach(d => {
        if (d.files && d.files.length > 0) cachedById.set(String(d.id), d);
      });
      allDownloads.forEach(dl => {
        if (dl._type === 'torrent' && (dl.files || []).length === 0) {
          const cached = cachedById.get(String(dl.id));
          if (cached) {
            dl.files = cached.files;
            dl.links = cached.links || dl.links;
          }
        }
      });
    }

    cacheData(allDownloads);

    // Se não for o background atualizando silenciosamente, resetamos o scroll infinito
    if (!isBackgroundSync) {
      visibleCount = 50;
    }
    
    renderDownloads();
    preloadTorrentFiles();

    await updateBellFromDownloads(allDownloads);

    if (allDownloads.some(d => !isCompleted(d))) {
      startAutoRefresh();
    } else {
      stopAutoRefresh();
    }
  } catch (err) {
    console.error('Failed to fetch downloads', err);
    if (allDownloads.length === 0) showState('empty');
    toast('Failed to fetch downloads', 'error');
  }
}

// ---- Normalize Real-Debrid torrent to internal format ----
function normalizeTorrent(t) {
  return {
    id: t.id,
    name: t.filename || 'Unnamed Torrent',
    size: t.bytes || 0,
    progress: (t.progress || 0) / 100,
    download_state: mapRdStatus(t.status),
    download_speed: t.speed || 0,
    seeds: t.seeders,
    created_at: normalizeRdTimestamp(t.added),
    completed_at: normalizeRdTimestamp(t.ended),
    links: t.links || [],
    _type: 'torrent',
    _rd_id: t.id,
    _rd_status: t.status,
    files: [],
  };
}

// RD timestamps are UTC but may lack a Z suffix and use space instead of T.
// Normalize to a proper ISO 8601 string so Date parsing is consistent.
function normalizeRdTimestamp(ts) {
  if (!ts) return null;
  // Try parsing as-is first
  let d = new Date(ts);
  if (!isNaN(d)) return d.toISOString();
  // Force UTC by replacing space with T and appending Z
  let s = ts.trim().replace(' ', 'T');
  if (!s.endsWith('Z')) s += 'Z';
  d = new Date(s);
  if (!isNaN(d)) return d.toISOString();
  // Last resort: return null so formatTimeAgo skips it
  return null;
}

// Save unrestricted links as local web download entries
async function saveLocalDownloads(unrestrictResults) {
  const { rd_local_downloads } = await chrome.storage.local.get('rd_local_downloads');
  const existing = rd_local_downloads || [];

  const newEntries = unrestrictResults.map(d => ({
    id: d.id || `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: d.filename || 'Unnamed Download',
    size: d.filesize || 0,
    progress: 1,
    download_state: 'completed',
    created_at: new Date().toISOString(),
    _type: 'web',
    _rd_download: d.download,
    _rd_link: d.link,
    _rd_host: d.host,
    files: d.download ? [{
      id: 0,
      name: d.filename || 'Download',
      size: d.filesize || 0,
      short_name: d.filename || 'Download',
    }] : [],
  }));

  const merged = [...newEntries, ...existing].slice(0, 99);
  await chrome.storage.local.set({ rd_local_downloads: merged });

  // Track IDs so notifications fire for these downloads
  for (const e of newEntries) {
    await trackId(String(e.id));
  }
}

function mapRdStatus(status) {
  const s = (status || '').toLowerCase();
  const map = {
    'magnet_error': 'error',
    'magnet_conversion': 'processing',
    'waiting_files_selection': 'waiting_selection',
    'queued': 'queued',
    'downloading': 'downloading',
    'downloaded': 'completed',
    'error': 'error',
    'virus': 'error',
    'compressing': 'processing',
    'uploading': 'uploading',
    'dead': 'error',
  };
  return map[s] || s || 'unknown';
}

// ---- Fetch user info (on open and after API key save) ----
async function fetchUserInfo() {
  if (!apiKey) return;
  try {
    const res = await apiGet('/user');
    if (res) {
      showUserBar(res);
      chrome.storage.local.set({ rd_cached_user: res });
    }
  } catch (err) {
    console.error('Failed to fetch user info');
  }
}

// ---- Render ----
function showState(state) {
  $('#loading').classList.toggle('hidden', state !== 'loading');
  $('#empty').classList.toggle('hidden', state !== 'empty');
  $('#no-api').classList.toggle('hidden', state !== 'no-api');
  $('#download-list').innerHTML = '';
  dlElementMap.clear();
}

function showUserBar(data) {
  const planType = capitalize(data.type || 'free');
  const daysRemaining = calculateDaysRemaining(data.expiration);

  const tile = $('#header-plan-tile');
  if (tile) {
    $('#header-plan-name').textContent = planType;
    $('#header-plan-expiry').textContent = daysRemaining;
    tile.style.display = 'flex';
  }
}

function calculateDaysRemaining(expiresAt) {
  if (!expiresAt) return '— days left';

  // Compare calendar dates only — ignore time & timezone from API
  const [y, m, d] = expiresAt.slice(0, 10).split('-').map(Number);
  const now = new Date();
  const diffDays = Math.round(
    (Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000
  );

  return `${diffDays} day${diffDays === 1 ? '' : 's'} left`;
}

function filterByAge(downloads, days) {
  if (!days) return downloads;
  const cutoff = Date.now() - days * 86400000;
  return downloads.filter(d => new Date(d.created_at || 0).getTime() < cutoff);
}

function updateAgeFilterUI() {
  const btn = $('#btn-age-filter');
  const label = $('#age-filter-label');
  const clearOpt = $('.age-filter-clear');

  $$('.age-filter-option:not(.age-filter-clear)').forEach(opt => {
    opt.classList.toggle('selected', ageFilterDays === parseInt(opt.dataset.age));
  });

  if (ageFilterDays) {
    const labels = { 1: '> 1 day', 7: '> 1 week', 30: '> 1 month' };
    label.textContent = labels[ageFilterDays];
    btn.classList.add('active');
    clearOpt.classList.remove('hidden');
  } else {
    label.textContent = 'Older than...';
    btn.classList.remove('active');
    clearOpt.classList.add('hidden');
  }
}

function renderDownloads() {
  const list = $('#download-list');

  // Pulse the Active tab label when there are active downloads
  const activeTab = $('[data-tab="downloading"]');
  activeTab.classList.toggle('has-active-downloads', allDownloads.some(d => !isCompleted(d)));

// 1. Usamos a variável global que criamos
  currentFiltered = allDownloads;

  // 2. Aplicamos os filtros de ABA
  switch (currentTab) {
    case 'downloading':
      currentFiltered = currentFiltered.filter((d) => !isCompleted(d));
      break;
    case 'completed':
      currentFiltered = currentFiltered.filter((d) => isCompleted(d));
      break;
    // Se for 'all', não fazemos nada, mantemos todos
  }

  // 3. Aplicamos o filtro de BUSCA GLOBAL e IDADE por cima da aba atual
  if (searchQuery) {
    currentFiltered = currentFiltered.filter((d) => {
      const name = (d.name || '').toLowerCase();
      return name.includes(searchQuery);
    });
  }
  currentFiltered = filterByAge(currentFiltered, ageFilterDays);
  updateAgeFilterUI();

  // Type overlay filter (independent of status)
  if (currentTypeFilter) {
    currentFiltered = currentFiltered.filter((d) => d._type === currentTypeFilter);
  }

  // Update search count badge
  const searchCountEl = $('#search-count');
  if (searchCountEl) {
    if (searchQuery || ageFilterDays) {
      searchCountEl.textContent = `${currentFiltered.length} results`;
      searchCountEl.classList.remove('hidden');
    } else {
      searchCountEl.textContent = '';
      searchCountEl.classList.add('hidden');
    }
  }

  if (currentFiltered.length === 0) {
    showState('empty');
    list.innerHTML = '';
    dlElementMap.clear();
    return;
  }

  // Clear states
  $('#loading').classList.add('hidden');
  $('#empty').classList.add('hidden');
  $('#no-api').classList.add('hidden');

  // 3. A MÁGICA: Cortamos a lista para renderizar apenas a quantidade visível!
  const toRender = currentFiltered.slice(0, visibleCount);

  // Pegamos os IDs dessa "fatia"
  const filteredIds = new Set(toRender.map(d => String(d.id)));

  // Removemos da tela e do mapa de elementos tudo o que NÃO estiver nessa fatia
  for (const [id, el] of dlElementMap) {
    if (!filteredIds.has(id)) {
      el.remove();
      dlElementMap.delete(id);
    }
  }

  // 4. Atualizamos os itens existentes ou inserimos novos na ordem correta da fatia
  toRender.forEach((dl, index) => {
    const id = String(dl.id);
    let li = dlElementMap.get(id);

    if (li) {
      // Only update the dynamic parts (meta + progress) — never touch the header or
      // expanded content, so scroll position and expanded state are fully preserved
      const newMeta = renderItemMeta(dl);
      const metaEl = li.querySelector('.dl-meta');
      if (metaEl) metaEl.replaceWith(newMeta.metaEl);

      // Update progress bar width in-place so CSS transitions animate smoothly
      const progressEl = li.querySelector('.dl-progress-wrap');
      if (newMeta.progressPct != null) {
        if (progressEl) {
          // Update existing progress bar fill width directly
          const fill = progressEl.querySelector('.dl-progress-fill');
          if (fill) fill.style.width = newMeta.progressPct + '%';
        } else {
          // Progress wrap didn't exist yet (e.g. item just became active) — insert it
          const expandedContent = li.querySelector('.dl-expanded-content');
          if (expandedContent && newMeta.progressEl) li.insertBefore(newMeta.progressEl, expandedContent);
        }
      } else if (progressEl) {
        // Download completed — remove progress bar
        progressEl.remove();
      }

      // Inject download button into header when a download becomes completed & downloadable
      const completed = isCompleted(dl);
      const existingDlBtn = li.querySelector('.dl-download-btn');
      if (completed && canDownload(dl) && !existingDlBtn) {
        const header = li.querySelector('.dl-item-header');
        const delBtn = li.querySelector('.dl-delete-btn');
        if (header && delBtn) {
          const dlBtn = document.createElement('button');
          dlBtn.className = 'dl-download-btn';
          dlBtn.dataset.type = dl._type;
          dlBtn.dataset.id = String(dl.id);
          dlBtn.title = 'Download';
          const dlBtnIcon = makeDownloadSvg();
          dlBtnIcon.style.cssText = 'position:relative;z-index:1;';
          dlBtn.appendChild(dlBtnIcon);
          header.insertBefore(dlBtn, delBtn);
        }
      }

      // Update expanded content if the file list has changed (e.g. download just completed)
      const currentFileCount = (dl.files || []).length;
      const knownFileCount = parseInt(li.dataset.fileCount ?? '-1', 10);
      if (currentFileCount !== knownFileCount) {
        const existingExpanded = li.querySelector('.dl-expanded-content');
        const newExpanded = renderExpandedContent(dl);
        if (existingExpanded) {
          // Preserve the expanded/collapsed visual state
          if (li.classList.contains('expanded')) newExpanded.style.display = '';
          existingExpanded.replaceWith(newExpanded);
        } else {
          li.appendChild(newExpanded);
        }
        li.dataset.fileCount = String(currentFileCount);
      }
    } else {
      // New item — create and insert at correct position
      li = document.createElement('li');
      li.className = 'dl-item';
      li.dataset.id = id;
      li.dataset.fileCount = String((dl.files || []).length);
      li.innerHTML = renderItem(dl);
      dlElementMap.set(id, li);
    }

    // Ensure correct DOM order
    const currentAtIndex = list.children[index];
    if (currentAtIndex !== li) {
      list.insertBefore(li, currentAtIndex || null);
    }
  });
}

function renderItemMeta(dl) {
  const status = getStatus(dl);
  const statusClass = getStatusClass(status);
  const progress = dl.progress != null ? Math.round(dl.progress * 100) : (isCompleted(dl) ? 100 : 0);
  const size = dl.size ? formatBytes(dl.size) : '—';
  const completed = isCompleted(dl);

  // Build meta element using createElement — no innerHTML, no escaping needed
  const metaEl = document.createElement('div');
  metaEl.className = 'dl-meta';
  metaEl.title = dl.name || 'Unnamed Download';

  const statusSpan = document.createElement('span');
  statusSpan.className = 'dl-status';

  const dot = document.createElement('span');
  dot.className = `dl-status-dot ${statusClass}`;
  statusSpan.appendChild(dot);
  statusSpan.appendChild(document.createTextNode(capitalize(status)));
  metaEl.appendChild(statusSpan);

  const infoSpan = document.createElement('span');

  if (completed) {
    const files = dl.files || [];
    const fileCount = files.length;
    const metaParts = [size];

    // Extract extension of the largest file
    if (fileCount > 0) {
      const largest = files.reduce((a, b) => (b.size || 0) > (a.size || 0) ? b : a, files[0]);
      const name = largest.short_name || largest.name || '';
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        metaParts.push(name.slice(dotIdx + 1).toUpperCase());
      }
      metaParts.push(`${fileCount} file${fileCount !== 1 ? 's' : ''}`);
    }

    const addedTime = dl.created_at ? formatTimeAgo(dl.created_at) : null;
    if (addedTime) metaParts.push(`added ${addedTime}`);
    infoSpan.textContent = metaParts.join(' • ');
  } else {
    const speed = dl.download_speed ? `${formatBytes(dl.download_speed)}/s` : '';
    const seeds = dl.seeds != null ? `${dl.seeds} Seeds` : '';
    const eta = (dl.eta && dl.eta < 864000) ? `${formatETA(dl.eta)} ETA` : (dl.eta ? 'No ETA' : '');
    infoSpan.textContent = [size, seeds, speed, eta].filter(Boolean).join(' • ');
  }

  metaEl.appendChild(infoSpan);

  // Build progress element
  let progressEl = null;
  if (!completed) {
    progressEl = document.createElement('div');
    progressEl.className = 'dl-progress-wrap';
    const bar = document.createElement('div');
    bar.className = 'dl-progress-bar';
    const fill = document.createElement('div');
    fill.className = 'dl-progress-fill';
    fill.style.width = progress + '%';
    bar.appendChild(fill);
    progressEl.appendChild(bar);
  }

  return {
    metaEl,
    progressEl: progressEl || null,
    progressPct: completed ? null : progress,
  };
}

function renderExpandedContent(dl) {
  const type = dl._type;
  const size = dl.size ? formatBytes(dl.size) : '—';
  const files = dl.files || [];
  const links = dl.links || [];

  function makeDownloadBtn(dataType, dataId) {
    const btn = document.createElement('button');
    btn.className = 'dl-file-download';
    btn.dataset.type = dataType;
    btn.dataset.id = String(dataId);
    btn.dataset.fileId = '0'; // always first link
    btn.title = 'Download';
    btn.appendChild(makeDownloadSvg());
    return btn;
  }

  const expandedContent = document.createElement('div');
  expandedContent.className = 'dl-expanded-content';

  if (type === 'torrent' && isCompleted(dl) && links.length > 0) {
    // Read-only file info rows (download is handled by header button)
    if (files.length > 0) {
      const ul = document.createElement('ul');
      ul.className = 'dl-files-list';

      files.forEach((f, idx) => {
        const li = document.createElement('li');
        li.className = 'dl-file-item dl-file-info';
        li.title = fileBaseName(f.name || f.short_name || `File ${idx + 1}`);
        li.style.cursor = 'default';
        const fnameEl = document.createElement('span');
        fnameEl.className = 'dl-file-name';
        fnameEl.textContent = f.short_name || f.name || `File ${idx + 1}`;
        fnameEl.style.opacity = '0.7';
        const fsize = document.createElement('span');
        fsize.className = 'dl-file-size';
        fsize.textContent = f.size ? formatBytes(f.size) : '—';
        fsize.style.opacity = '0.7';
        li.appendChild(fnameEl);
        li.appendChild(fsize);
        ul.appendChild(li);
      });

      expandedContent.appendChild(ul);
    } else {
      const noFiles = document.createElement('div');
      noFiles.className = 'dl-no-files';
      noFiles.textContent = 'No file info available';
      expandedContent.appendChild(noFiles);
    }
  } else if (type === 'web' && dl._rd_download) {
    // Web download info (download is handled by header button)
    const ul = document.createElement('ul');
    ul.className = 'dl-files-list';
    const li = document.createElement('li');
    li.className = 'dl-file-item dl-file-info';
    li.style.cursor = 'default';
    const fnameEl = document.createElement('span');
    fnameEl.className = 'dl-file-name';
    fnameEl.textContent = dl.name || 'Download';
    fnameEl.style.opacity = '0.7';
    const fsize = document.createElement('span');
    fsize.className = 'dl-file-size';
    fsize.textContent = size;
    fsize.style.opacity = '0.7';
    li.appendChild(fnameEl);
    li.appendChild(fsize);
    ul.appendChild(li);
    expandedContent.appendChild(ul);
  } else {
    const noFiles = document.createElement('div');
    noFiles.className = 'dl-no-files';
    noFiles.textContent = 'Files available once download completes';
    expandedContent.appendChild(noFiles);
  }

  return expandedContent;
}

function renderItem(dl) {
  const name = dl.name || 'Unnamed Download';
  const type = dl._type;
  const completed = isCompleted(dl);
  const size = dl.size ? formatBytes(dl.size) : '—';
  const files = dl.files || [];
  const deleteType = type;

  // ---- Header ----
  const header = document.createElement('div');
  header.className = 'dl-item-header';
  header.title = name;

  const typeBadge = document.createElement('span');
  typeBadge.className = `dl-type-badge ${type}`;
  typeBadge.textContent = type === 'web' ? 'WEB' : type.slice(0, 3).toUpperCase();
  header.appendChild(typeBadge);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'dl-name';
  nameSpan.textContent = name;
  header.appendChild(nameSpan);

  // Download button — only shown for completed, downloadable items
  if (completed && canDownload(dl)) {
    const dlBtn = document.createElement('button');
    dlBtn.className = 'dl-download-btn';
    dlBtn.dataset.type = type;
    dlBtn.dataset.id = String(dl.id);
    dlBtn.title = 'Download';
    const dlBtnIcon = makeDownloadSvg();
    dlBtnIcon.style.cssText = 'position:relative;z-index:1;';
    dlBtn.appendChild(dlBtnIcon);
    header.appendChild(dlBtn);
  }

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'dl-delete-btn';
  deleteBtn.dataset.type = deleteType;
  deleteBtn.dataset.id = String(dl.id);
  deleteBtn.title = 'Delete';
  const deleteBtnIcon = makeTrashSvg();
  deleteBtnIcon.style.cssText = 'position:relative;z-index:1;';
  deleteBtn.appendChild(deleteBtnIcon);
  header.appendChild(deleteBtn);

  // ---- Meta + progress (reuse renderItemMeta) ----
  const { metaEl, progressEl } = renderItemMeta(dl);

  // ---- Expanded file list ----
  const expandedContent = renderExpandedContent(dl);

  // ---- Assemble into a fragment ----
  const frag = document.createDocumentFragment();
  frag.appendChild(header);
  frag.appendChild(metaEl);
  if (progressEl) frag.appendChild(progressEl);
  frag.appendChild(expandedContent);

  // Serialise to HTML string — renderDownloads sets li.innerHTML once on creation
  const wrapper = document.createElement('div');
  wrapper.appendChild(frag);
  return wrapper.innerHTML;
}

function isCompleted(dl) {
  const s = (dl.download_state || '').toLowerCase();
  if (s === 'processing' || s === 'waiting_selection' || s.includes('queue')) return false;
  return s === 'completed'
    || (dl.progress != null && dl.progress >= 1);
}

// isReady means the file is actually available for download
function isReady(dl) {
  const s = (dl.download_state || '').toLowerCase();
  return s === 'completed';
}

// canDownload — true when we have enough info to trigger a download
function canDownload(dl) {
  if (dl._type === 'web' && dl._rd_download) return true;
  if (dl._type === 'torrent' && (dl.links || []).length > 0) return true;
  return false;
}

function getStatus(dl) {
  const s = dl.download_state || '';
  if (!s) return dl.progress >= 1 ? 'completed' : 'unknown';
  return s.toLowerCase().replace(/_/g, ' ');
}

function getStatusClass(status) {
  if (status.includes('complet')) return 'completed';
  if (status.includes('download') || status.includes('uploading')) return 'downloading';
  if (status.includes('process') || status.includes('compress')) return 'downloading';
  if (status.includes('waiting')) return 'queued';
  if (status.includes('error') || status.includes('dead') || status.includes('virus')) return 'error';
  if (status.includes('queue')) return 'queued';
  return 'downloading';
}

// ---- Modals ----
function openModal(title, bodyHtml) {
  // Remove any leftover dynamic buttons from previous modal opens
  document.querySelectorAll('.notifications-mark-all').forEach(el => el.remove());
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHtml;
  $('#modal-overlay').classList.remove('hidden');
  initFixedTooltips();
}

// Variant that accepts a pre-built DOM node instead of an HTML string,
// avoiding any innerHTML serialise/parse round-trip for user-controlled content.
function openModalWithNode(title, bodyNode) {
  document.querySelectorAll('.notifications-mark-all').forEach(el => el.remove());
  $('#modal-title').textContent = title;
  $('#modal-body').replaceChildren(bodyNode);
  $('#modal-overlay').classList.remove('hidden');
  initFixedTooltips();
}

// ---- Fixed-position tooltips (immune to overflow clipping) ----
function initFixedTooltips() {
  document.querySelectorAll('.info-icon').forEach(icon => {
    const tip = icon.querySelector('.info-tooltip');
    if (!tip) return;

    icon.addEventListener('mouseenter', () => {
      const modal = document.querySelector('#modal');
      const iconRect = icon.getBoundingClientRect();
      const modalRect = modal ? modal.getBoundingClientRect() : document.body.getBoundingClientRect();

      // Make visible off-screen first so we can measure width
      tip.style.position = 'fixed';
      tip.style.visibility = 'hidden';
      tip.classList.add('visible');
      const tipWidth = tip.offsetWidth;
      tip.style.visibility = '';

      tip.style.left = `${modalRect.left + (modalRect.width - tipWidth) / 2}px`;
      tip.style.top = `${iconRect.bottom + 6}px`;
    });

    icon.addEventListener('mouseleave', () => {
      tip.classList.remove('visible');
      tip.style.position = '';
      tip.style.left = '';
      tip.style.top = '';
    });
  });
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
}

// API Key Modal
function showApiKeyModal() {
  chrome.storage.local.get(['rd_context_menu', 'rd_notifications_enabled', 'rd_hover_lift', 'rd_accent_color', 'rd_cached_user', 'rd_max_height'], (data) => {
    const contextMenuEnabled = data.rd_context_menu !== false; // default on
    const notificationsEnabled = data.rd_notifications_enabled !== false; // default on
    const hoverLiftEnabled = data.rd_hover_lift !== false; // default on
    const customAccent = data.rd_accent_color || '';
    const cachedUser = data.rd_cached_user;
    const userPoints = cachedUser?.points != null ? cachedUser.points.toLocaleString() : '—';
    const username = cachedUser?.username || cachedUser?.email || '—';
    const currentMaxHeight = data.rd_max_height || 400;

    openModal('Settings', `
      <div class="form-group">
        <div class="toggle-row">
          <div>
            <div class="form-label" style="margin-bottom:2px;">Right-click context menu</div>
            <div class="form-hint">Show "Send to Real-Debrid Lite" when right-clicking links or selected text (e.g. plain text links).</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-context-menu" ${contextMenuEnabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="form-group">
        <div class="toggle-row">
          <div>
            <div style="display:flex;align-items:center;gap:5px;margin-bottom:2px;">
              <div class="form-label" style="margin-bottom:0;">Download notifications</div>
              <span class="info-icon">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                <span class="info-tooltip">When turned off, Real-Debrid Lite won't send any background requests — it stays completely idle unless you open or send a link to it.</span>
              </span>
            </div>
            <div class="form-hint">Notify me when downloads are ready (incl. cached files). Notifications are updated every 60s in the background.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-notifications" ${notificationsEnabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="form-group">
        <div class="toggle-row">
          <div>
            <div class="form-label" style="margin-bottom:2px;">Hover lift effect</div>
            <div class="form-hint">Adds a subtle lift and shadow to download tiles and action buttons on hover. Disable for a flatter, minimal look.</div>
          </div>
          <label class="toggle-switch">
            <input type="checkbox" id="toggle-hover-lift" ${hoverLiftEnabled ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>
      <div class="form-group">
        <div class="settings-split-row">
          <div class="settings-split-col">
            <label class="form-label" style="margin-bottom:6px;">
              <span style="display:inline-flex;align-items:center;gap:5px;">Max height <span class="slider-value-inline" id="max-height-value">${currentMaxHeight}px</span>
                <span class="info-icon">
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                  <span class="info-tooltip">Scales window height as your list grows.</span>
                </span>
              </span>
            </label>
            <input type="range" id="input-max-height" class="settings-slider" min="400" max="600" step="10" value="${currentMaxHeight}">
          </div>
          <div class="settings-split-col settings-split-right">
            <label class="form-label" style="margin-bottom:6px;">Accent color</label>
            <div class="accent-picker-row">
              <button id="btn-reset-accent" class="accent-reset-btn">Reset</button>
              <input type="color" id="input-accent-color" class="accent-color-input small" value="${customAccent || (document.documentElement.getAttribute('data-theme') === 'dark' ? '#52c47e' : '#1a9c4a')}">
            </div>
          </div>
        </div>
      </div>
      <div class="settings-account-section">
        <div class="form-group" style="margin-bottom:10px;">
          <label class="form-label">API Token <span class="form-label-normal">(from <a href="https://real-debrid.com/apitoken" target="_blank" class="form-label-link">Real-Debrid</a>)</span></label>
          <div class="api-key-row">
            <input type="password" class="form-input" id="input-api-key" value="${escapeHtml(apiKey)}" placeholder="Paste your Real-Debrid API token" spellcheck="false">
            <button class="api-key-save" id="save-api-key" disabled title="Edit token to save">Save</button>
          </div>
        </div>
        <div class="settings-account-footer">
          <div class="settings-account-left">
            <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span class="settings-account-name">${escapeHtml(username)}</span>
          </div>
          <span class="settings-account-points">${escapeHtml(userPoints)} Fidelity Points</span>
        </div>
      </div>
    `);

    $('#toggle-context-menu').addEventListener('change', (e) => {
      chrome.storage.local.set({ rd_context_menu: e.target.checked });
    });

    $('#toggle-notifications').addEventListener('change', (e) => {
      chrome.storage.local.set({ rd_notifications_enabled: e.target.checked });
      if (!e.target.checked) {
        notifications = [];
        updateNotificationBadge();
      }
    });

    $('#toggle-hover-lift').addEventListener('change', (e) => {
      chrome.storage.local.set({ rd_hover_lift: e.target.checked });
      document.documentElement.setAttribute('data-hover-lift', e.target.checked ? 'on' : 'off');
    });

    // Max height slider — live preview on drag, save on release
    const maxHeightSlider = $('#input-max-height');
    const maxHeightLabel = $('#max-height-value');
    maxHeightSlider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value);
      maxHeightLabel.textContent = val + 'px';
      applyMaxHeight(val);
    });
    maxHeightSlider.addEventListener('change', (e) => {
      chrome.storage.local.set({ rd_max_height: parseInt(e.target.value) });
    });

    $('#input-accent-color').addEventListener('input', (e) => {
      applyAccentColor(e.target.value);
    });

    $('#input-accent-color').addEventListener('change', (e) => {
      chrome.storage.local.set({ rd_accent_color: e.target.value });
    });

    $('#btn-reset-accent').addEventListener('click', () => {
      chrome.storage.local.remove('rd_accent_color');
      clearAccentColor();
      const defaultColor = document.documentElement.getAttribute('data-theme') === 'dark' ? '#52c47e' : '#1a9c4a';
      $('#input-accent-color').value = defaultColor;
    });

    const apiKeyInput = $('#input-api-key');
    const saveBtn = $('#save-api-key');
    const savedKey = apiKey;

    apiKeyInput.addEventListener('input', () => {
      const changed = apiKeyInput.value.trim() !== savedKey;
      saveBtn.disabled = !changed;
      saveBtn.title = changed ? '' : 'Edit token to save';
    });

    saveBtn.addEventListener('click', async () => {
      const key = apiKeyInput.value.trim();
      if (!key) return toast('Please enter a valid key', 'error');

      saveBtn.disabled = true;
      saveBtn.classList.add('loading');
      saveBtn.textContent = '...';

      try {
        const res = await fetchWithTimeout(`${API_BASE}/user`, {
          headers: { Authorization: `Bearer ${key}` },
        }, TIMEOUT_VALIDATE_MS);
        if (!res.ok) throw new Error(`API error (${res.status})`);
        const data = await res.json();

        if (!data?.id) throw new Error('Invalid response');

        saveApiKey(key);
        saveBtn.textContent = '✓';
        toast('API token saved!', 'success');
        showUserBar(data);
        chrome.storage.local.set({ rd_cached_user: data });

        // Update account footer in the modal live
        const nameEl = document.querySelector('.settings-account-name');
        const pointsEl = document.querySelector('.settings-account-points');
        if (nameEl) nameEl.textContent = data.username || data.email || '—';
        if (pointsEl) pointsEl.textContent = (data.points != null ? data.points.toLocaleString() : '—') + ' Fidelity Points';

        fetchAll();
        fetchUserInfo();
      } catch (err) {
        const msg = err.name === 'AbortError' ? 'Validation timed out — try again' : 'Invalid API token';
        toast(msg, 'error');
        saveBtn.disabled = false;
        saveBtn.classList.remove('loading');
        saveBtn.textContent = 'Save';
      }
    });

    apiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !saveBtn.disabled) saveBtn.click();
    });

    // If no API key is set, scroll to and focus the token field
    if (!apiKey) {
      setTimeout(() => {
        apiKeyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        apiKeyInput.focus();
      }, 100);
    }
  });
}

// Torrent Modal (magnet or file)
function showTorrentModal() {
  if (!apiKey) return showApiKeyModal();

  openModal('Add Torrent', `
    <div class="form-group">
      <div class="form-label-row">
        <div class="form-label-left">
          <label class="form-label">Magnet Link</label>
          <span class="info-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span class="info-tooltip">Paste a magnet link or upload a .torrent file. Right-click any magnet or .torrent link to add instantly.</span>
          </span>
        </div>
      </div>
      <textarea class="form-input" id="input-magnet" placeholder="magnet:?xt=urn:btih:..." rows="5" spellcheck="false"></textarea>
    </div>
    <div class="form-divider">
      <span>or</span>
    </div>
    <div class="form-group">
      <input type="file" id="input-torrent-file" accept=".torrent" style="display:none">
      <button class="form-file-btn" id="btn-select-torrent">
        <svg class="icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><polyline points="14 2 14 8 20 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Select .torrent File
      </button>
      <div class="form-file-name" id="selected-file-name"></div>
    </div>
    <button class="form-submit" id="submit-torrent">Add Torrent <span class="btn-spinner"></span></button>
  `);

  const magnetInput = $('#input-magnet');
  const fileInput = $('#input-torrent-file');
  const fileBtn = $('#btn-select-torrent');
  const fileName = $('#selected-file-name');
  const submitBtn = $('#submit-torrent');

  fileBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      fileName.textContent = fileInput.files[0].name;
      magnetInput.value = '';
      magnetInput.disabled = true;
    } else {
      fileName.textContent = '';
      magnetInput.disabled = false;
    }
  });

  magnetInput.addEventListener('input', () => {
    if (magnetInput.value.trim()) {
      fileInput.value = '';
      fileName.textContent = '';
    }
  });

  submitBtn.addEventListener('click', async () => {
    const magnet = magnetInput.value.trim();
    const file = fileInput.files[0];

    if (!magnet && !file) {
      return toast('Enter a magnet link or select a file', 'error');
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.innerHTML = 'Adding...<span class="btn-spinner"></span>';

    try {
      let torrentId = null;
      if (file) {
        // RD uses PUT with raw binary body for .torrent files
        const res = await fetch(`${API_BASE}/torrents/addTorrent`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: file
        });
        if (!res.ok) throw new Error(`API error (${res.status})`);
        const data = await res.json();
        torrentId = data.id;
        if (torrentId) {
          await apiPost(`/torrents/selectFiles/${torrentId}`, { files: 'all' });
        }
      } else {
        if (!magnet.startsWith('magnet:')) {
          toast('Invalid magnet link', 'error');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add Torrent';
          return;
        }
        const data = await apiPost('/torrents/addMagnet', { magnet: magnet });
        torrentId = data?.id;
        if (torrentId) {
          await apiPost(`/torrents/selectFiles/${torrentId}`, { files: 'all' });
        }
      }

      if (torrentId) await trackId(String(torrentId));
      toast('Torrent added!', 'success');
      closeModal();
      fetchAll();
      chrome.runtime.sendMessage('rd-check-now');
    } catch (err) {
      console.error('Failed to add torrent');
      toast('Failed to add torrent', 'error');
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      submitBtn.innerHTML = 'Add Torrent<span class="btn-spinner"></span>';
    }
  });

  setTimeout(() => magnetInput.focus(), 100);
}

// Unrestrict Link Modal
function showWebLinkModal() {
  if (!apiKey) return showApiKeyModal();

  openModal('Unrestrict Link', `
    <div class="form-group">
      <div class="form-label-row">
        <div class="form-label-left">
          <label class="form-label">URL</label>
          <span class="info-icon">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            <span class="info-tooltip">Paste hoster links to unrestrict them into direct downloads. Right-click any link or selected text to unrestrict instantly.</span>
          </span>
        </div>
        <div class="form-label-icons">
          <a href="https://real-debrid.com/compare" target="_blank" class="hosters-link" title="View supported hosters">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
            Supported hosters
          </a>
        </div>
      </div>
      <textarea class="form-input" id="input-weblink" placeholder="https://1fichier.com/...&#10;https://rapidgator.net/...&#10;https://uptobox.com/..." rows="5" spellcheck="false"></textarea>
    </div>
    <button class="form-submit" id="submit-weblink">Unrestrict <span class="btn-spinner"></span></button>
  `);

  const urlInput = $('#input-weblink');
  const submitBtn = $('#submit-weblink');

  submitBtn.addEventListener('click', async () => {
    const urls = urlInput.value
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.startsWith('http://') || l.startsWith('https://'));

    if (urls.length === 0) {
      return toast('Enter at least one valid URL', 'error');
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.innerHTML = `Unrestricting...<span class="btn-spinner"></span>`;

    try {
      const results = await Promise.allSettled(urls.map(url => {
        return apiPost('/unrestrict/link', { link: url });
      }));

      const succeeded = [];
      let failed = 0;
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) {
          succeeded.push(r.value);
        } else {
          failed++;
        }
      });

      // Save successful unrestrictions locally
      if (succeeded.length > 0) {
        await saveLocalDownloads(succeeded);
      }

      if (failed === 0) {
        toast(urls.length > 1 ? `${succeeded.length} links unrestricted!` : 'Link unrestricted!', 'success');
        closeModal();
        fetchAll();
      } else if (succeeded.length === 0) {
        toast('All links failed — hosters may not be supported', 'error');
        submitBtn.disabled = false;
        submitBtn.classList.remove('loading');
        submitBtn.innerHTML = 'Unrestrict<span class="btn-spinner"></span>';
      } else {
        toast(`${succeeded.length} unrestricted, ${failed} failed`, 'error');
        closeModal();
        fetchAll();
      }
    } catch (err) {
      console.error('Failed to unrestrict link');
      toast('Failed to unrestrict link', 'error');
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      submitBtn.innerHTML = 'Unrestrict<span class="btn-spinner"></span>';
    }
  });

  setTimeout(() => urlInput.focus(), 100);
}

// ---- Toast ----
function toast(msg, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ---- Utils ----
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatETA(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h${m}m`;
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date)) return null;
  const diffDays = Math.floor(Math.abs(Date.now() - date.getTime()) / 86400000);

  if (diffDays === 0) return 'recently';
  if (diffDays === 1) return '1d ago';
  return `${diffDays}d ago`;
}

function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- SVG helper (avoids innerHTML for icon markup) ----
function makeSvg(paths, { viewBox = '0 0 24 24', width = '14', height = '14' } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of paths) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

function makeTrashSvg() {
  return makeSvg([
    ['polyline', { points: '3 6 5 6 21 6' }],
    ['path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }],
    ['path', { d: 'M10 11v6' }],
    ['path', { d: 'M14 11v6' }],
    ['path', { d: 'M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2' }],
  ]);
}

function makeDownloadSvg() {
  return makeSvg([
    ['path', { d: 'M12 3v10' }],
    ['polyline', { points: '8 9 12 14 16 9' }],
    ['path', { d: 'M3 17v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2' }],
  ]);
}

function fileBaseName(str) {
  if (!str) return str;
  const idx = str.lastIndexOf('/');
  return idx >= 0 ? str.slice(idx + 1) : str;
}

// ---- Notifications ----
// When the popup is open, fetchAll drives notification detection directly using
// the data it already has — no extra API calls needed. The background worker
// is the fallback when the popup is closed.
async function updateBellFromDownloads(downloads) {
  if (!cachedNotificationsEnabled) return;

  const { rd_tracked_ids } = await chrome.storage.local.get('rd_tracked_ids');
  const trackedIds = new Set(rd_tracked_ids || []);
  if (trackedIds.size === 0) {
    await loadLocalNotifications();
    return;
  }

  const justCompleted = downloads.filter(dl => isReady(dl) && trackedIds.has(String(dl.id)));
  if (justCompleted.length === 0) {
    await loadLocalNotifications();
    return;
  }

  // Remove completed items from tracked set
  justCompleted.forEach(dl => trackedIds.delete(String(dl.id)));
  await chrome.storage.local.set({ rd_tracked_ids: [...trackedIds] });

  // Write to local notifications so the bell updates
  const { rd_local_notifications } = await chrome.storage.local.get('rd_local_notifications');
  const existing = rd_local_notifications || [];
  const merged = [
    ...justCompleted.map(dl => ({
      id: `${dl.id}-${Date.now()}`,
      title: 'Download Available',
      message: dl.name || 'A download has finished',
      type: dl._type,
      created_at: new Date().toISOString(),
      read: false,
    })),
    ...existing,
  ].slice(0, 99);
  await chrome.storage.local.set({ rd_local_notifications: merged });
  await loadLocalNotifications();
}

async function loadLocalNotifications() {
  if (!cachedNotificationsEnabled) {
    notifications = [];
    updateNotificationBadge();
    return;
  }
  const { rd_local_notifications } = await chrome.storage.local.get('rd_local_notifications');
  notifications = (rd_local_notifications || []).filter(n => !n.read);
  updateNotificationBadge();
}

function showNotificationsModal() {
  const hasNotifications = notifications.length > 0;

  // Build modal body entirely via DOM — no innerHTML with user-controlled strings
  const bodyEl = document.createElement('div');

  if (hasNotifications) {
    const listEl = document.createElement('div');
    listEl.className = 'notifications-list';
    listEl.id = 'notifications-list';

    notifications.forEach(n => {
      const item = document.createElement('div');
      item.className = 'notification-item unread';
      item.dataset.id = n.id;

      const titleEl = document.createElement('span');
      titleEl.className = 'notification-title';
      titleEl.textContent = n.title || 'Download Available';

      const timeEl = document.createElement('span');
      timeEl.className = 'notification-time';
      timeEl.textContent = formatTimeAgo(n.created_at);

      const headerEl = document.createElement('div');
      headerEl.className = 'notification-header';
      headerEl.appendChild(titleEl);
      headerEl.appendChild(timeEl);

      const msgEl = document.createElement('div');
      msgEl.className = 'notification-message';
      msgEl.textContent = n.message || '';

      item.appendChild(headerEl);
      item.appendChild(msgEl);

      item.addEventListener('click', async () => {
        item.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
        item.style.opacity = '0';
        item.style.transform = 'translateX(-10px)';
        await clearNotification(item.dataset.id);
        setTimeout(() => {
          item.remove();
          if (notifications.length === 0) {
            const list = $('#notifications-list');
            if (list) {
              const emptyEl = document.createElement('div');
              emptyEl.className = 'notifications-empty';
              emptyEl.textContent = 'No notifications';
              list.replaceChildren(emptyEl);
            }
            $('#btn-mark-all-read')?.remove();
          }
        }, 150);
      });

      listEl.appendChild(item);
    });

    bodyEl.appendChild(listEl);
  } else {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'notifications-empty';
    emptyEl.textContent = 'No notifications';
    bodyEl.appendChild(emptyEl);
  }

  openModalWithNode('Notifications', bodyEl);

  if (hasNotifications) {
    const modalHeader = $('.modal-header');
    const markAllBtn = document.createElement('button');
    markAllBtn.className = 'notifications-mark-all';
    markAllBtn.id = 'btn-mark-all-read';
    markAllBtn.textContent = 'Clear all';
    modalHeader.insertBefore(markAllBtn, $('#modal-close'));

    markAllBtn.addEventListener('click', async () => {
      await clearAllNotifications();
      closeModal();
    });
  }
}

async function updateNotificationBadge() {
  const badge = $('#notification-badge');
  const count = notifications.length;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
    chrome.action.setBadgeText({ text: count > 99 ? '99+' : String(count) });
    const { rd_accent_color } = await chrome.storage.local.get('rd_accent_color');
    chrome.action.setBadgeBackgroundColor({ color: rd_accent_color || '#1a9c4a' });
  } else {
    badge.classList.add('hidden');
    chrome.action.setBadgeText({ text: '' });
  }
}

async function clearNotification(id) {
  const { rd_local_notifications } = await chrome.storage.local.get('rd_local_notifications');
  const updated = (rd_local_notifications || []).map(n =>
    n.id === id ? { ...n, read: true } : n
  );
  await chrome.storage.local.set({ rd_local_notifications: updated });
  notifications = notifications.filter(n => n.id !== id);
  updateNotificationBadge();
}

async function clearAllNotifications() {
  const { rd_local_notifications } = await chrome.storage.local.get('rd_local_notifications');
  const updated = (rd_local_notifications || []).map(n => ({ ...n, read: true }));
  await chrome.storage.local.set({ rd_local_notifications: updated });
  notifications = [];
  updateNotificationBadge();
  toast('All notifications cleared', 'success');
}
