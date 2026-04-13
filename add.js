const API_BASE = 'https://api.real-debrid.com/rest/1.0';
const OAUTH_BASE = 'https://api.real-debrid.com/oauth/v2';
const TIMEOUT_DEFAULT_MS = 10_000;

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  }
  children.forEach(c => {
    if (c === null || c === undefined) return;
    e.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  });
  return e;
}

const $ = (sel) => document.querySelector(sel);

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

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function toast(msg, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const tEl = document.createElement('div');
  tEl.className = `toast ${type}`;
  tEl.textContent = msg;
  document.body.appendChild(tEl);
  setTimeout(() => tEl.remove(), 2500);
}

function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT_DEFAULT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function getValidToken() {
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
      if (!res.ok) return null;
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

async function apiGet(path) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');
  const res = await fetchWithTimeout(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (res.status === 204) return null;
  return res.json();
}

async function apiPost(path, body) {
  const token = await getValidToken();
  if (!token) throw new Error('Unauthenticated');
  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  if (!res.ok) throw new Error(`API error (${res.status})`);
  if (res.status === 204) return null;
  return res.json();
}

async function trackId(id) {
  const { rd_tracked_ids } = await browser.storage.local.get('rd_tracked_ids');
  const tracked = new Set(rd_tracked_ids || []);
  tracked.add(String(id));
  await browser.storage.local.set({ rd_tracked_ids: [...tracked] });
}

document.addEventListener('DOMContentLoaded', async () => {
  const { rd_theme } = await browser.storage.local.get('rd_theme');
  document.documentElement.setAttribute('data-theme', rd_theme || 'dark');

  const token = await getValidToken();
  if (!token) {
    $('#content').replaceChildren(el('div', {className: 'state-message'}, 'Por favor, autentique-se na extensão principal primeiro.'));
    return;
  }
  renderAddForm();
});

function renderAddForm() {
  const infoIconSvg = makeSvg([['circle',{cx:'12',cy:'12',r:'10'}],['line',{x1:'12',y1:'16',x2:'12',y2:'12'}],['line',{x1:'12',y1:'8',x2:'12.01',y2:'8'}]]);
  const btnSvg = makeSvg([['path',{d:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'}],['polyline',{points:'14 2 14 8 20 8'}]]);
  const uploadSvg = makeSvg([['path',{d:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'}],['polyline',{points:'17 8 12 3 7 8'}],['line',{x1:'12',y1:'3',x2:'12',y2:'15'}]]);

  const form = el('div', {},
    el('div', {className: 'form-group'},
      el('div', {className: 'form-label-row'},
        el('div', {className: 'form-label-left'},
          el('label', {className: 'form-label'}, 'Link Magnet'),
          el('span', {className: 'info-icon'}, infoIconSvg.cloneNode(true), el('span', {className: 'info-tooltip'}, 'Cole um link magnet ou arraste um arquivo .torrent abaixo.'))
        )
      ),
      el('textarea', {className: 'form-input', id: 'input-magnet', placeholder: 'magnet:?xt=urn:btih:...', rows: '5', spellcheck: 'false'})
    ),
    el('div', {className: 'form-divider'}, el('span', {}, 'ou')),
    el('div', {className: 'form-group'},
      el('div', {className: 'form-file-btn', id: 'dropzone-torrent', style: 'flex-direction: column; padding: 20px 10px; cursor: default; gap: 8px; border-style: dashed;'},
        uploadSvg.cloneNode(true),
        el('span', {}, 'Arraste e solte um arquivo .torrent aqui')
      ),
      el('div', {className: 'form-file-name', id: 'selected-file-name'})
    ),
    el('button', {className: 'form-submit', id: 'submit-torrent'}, 'Adicionar Torrent ', el('span', {className: 'btn-spinner'}))
  );

  $('#content').replaceChildren(form);

  const magnetInput = $('#input-magnet');
  const dropzone = $('#dropzone-torrent');
  const fileName = $('#selected-file-name');
  const submitBtn = $('#submit-torrent');
  let selectedFile = null;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, preventDefaults, false);
  });

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, () => {
      dropzone.style.borderColor = 'var(--accent)';
      dropzone.style.background = 'var(--accent-dim)';
      dropzone.style.color = 'var(--accent)';
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, () => {
      dropzone.style.borderColor = '';
      dropzone.style.background = '';
      dropzone.style.color = '';
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.torrent')) {
        selectedFile = file;
        fileName.textContent = file.name;
        magnetInput.value = '';
        magnetInput.disabled = true;
      } else {
        toast('Por favor, arraste um arquivo .torrent válido.', 'error');
      }
    }
  });

  magnetInput.addEventListener('input', () => {
    if (magnetInput.value.trim()) {
      selectedFile = null;
      fileName.textContent = '';
    } else {
       magnetInput.disabled = false;
    }
  });

  submitBtn.addEventListener('click', async () => {
    const magnet = magnetInput.value.trim();
    const file = selectedFile;

    if (!magnet && !file) return toast('Insira um link magnet ou arraste um arquivo', 'error');

    submitBtn.disabled = true;
    submitBtn.classList.add('loading');
    submitBtn.replaceChildren('Adicionando...', el('span', {className: 'btn-spinner'}));

    try {
      let torrentId = null;
      if (file) {
        const token = await getValidToken();
        const res = await fetch(`${API_BASE}/torrents/addTorrent`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}` },
          body: file
        });
        if (!res.ok) throw new Error(`API error`);
        const data = await res.json();
        torrentId = data.id;
      } else {
        const data = await apiPost('/torrents/addMagnet', { magnet: magnet });
        torrentId = data?.id;
      }

      if (torrentId) {
        await trackId(String(torrentId));
        toast('Adicionado! Verificando arquivos...', 'success');
        await handleFileSelection(torrentId);
      }
    } catch (err) {
      toast('Falha ao adicionar torrent', 'error');
      submitBtn.disabled = false;
      submitBtn.classList.remove('loading');
      submitBtn.replaceChildren('Adicionar Torrent', el('span', {className: 'btn-spinner'}));
    }
  });

  setTimeout(() => magnetInput.focus(), 100);
}

async function handleFileSelection(torrentId) {
  $('#content').replaceChildren(el('div', {className: 'state-message', style: 'padding: 40px 0;'},
    el('div', {className: 'spinner'}),
    el('span', {style: 'margin-top: 10px; display: block;'}, 'Aguardando conversão...')
  ));

  let info;
  let attempts = 0;
  while (attempts < 60) {
    try {
      info = await apiGet(`/torrents/info/${torrentId}`);
      if (info && info.status !== 'magnet_conversion') break;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 1000));
    attempts++;
  }

  if (!info || info.status === 'error' || info.status === 'dead') {
    toast('Erro ao processar torrent. Fechando...', 'error');
    setTimeout(() => window.close(), 2500);
    return;
  }

  if (info.status !== 'waiting_files_selection') {
    toast('Adicionado com sucesso!', 'success');
    browser.runtime.sendMessage('rd-check-now');
    setTimeout(() => window.close(), 1500);
    return;
  }

  if (!info.files || info.files.length === 0) {
    toast('Nenhum arquivo encontrado.', 'error');
    setTimeout(() => window.close(), 2500);
    return;
  }

  const fileList = el('ul', {className: 'dl-files-list', style: 'max-height: 250px; overflow-y: auto; overflow-x: hidden; margin: 10px 0; background: var(--bg-hover, rgba(0,0,0,0.1)); border-radius: 6px; padding: 5px; list-style: none;'});
  const checkboxes = [];

  info.files.forEach(f => {
    // MODIFICADO AQUI: checked: 'checked' adicionado por padrão
    const cb = el('input', {type: 'checkbox', value: String(f.id), checked: 'checked', style: 'margin-right: 10px; cursor: pointer; flex-shrink: 0;'});
    const li = el('li', {className: 'dl-file-item', style: 'display: flex; align-items: center; padding: 8px 5px; cursor: pointer; border-bottom: 1px solid var(--border-color, #333);'},
      cb,
      el('span', {className: 'dl-file-name', style: 'flex: 1; word-break: break-all; font-size: 13px;'}, f.path.replace(/^\//, '')),
      el('span', {className: 'dl-file-size', style: 'white-space: nowrap; margin-left: 10px; color: var(--text-muted, #888); font-size: 12px;'}, formatBytes(f.bytes))
    );
    li.addEventListener('click', (e) => {
      if (e.target !== cb) cb.checked = !cb.checked;
    });
    fileList.appendChild(li);
    checkboxes.push(cb);
  });

  if (fileList.lastChild) fileList.lastChild.style.borderBottom = 'none';

  const selectAllBtn = el('button', {className: 'action-btn ghost', style: 'margin-bottom: 10px; width: 100%; justify-content: center;'}, 'Selecionar Tudo / Inverter');
  selectAllBtn.addEventListener('click', () => {
    const allChecked = checkboxes.every(c => c.checked);
    checkboxes.forEach(c => c.checked = !allChecked);
  });

  const confirmBtn = el('button', {className: 'form-submit', style: 'width: 100%; margin-top: 10px;'}, 'Iniciar Download');

  confirmBtn.addEventListener('click', async () => {
    const selected = checkboxes.filter(c => c.checked).map(c => c.value);
    if (selected.length === 0) return toast('Selecione pelo menos um arquivo', 'error');

    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Iniciando...';
    try {
      await apiPost(`/torrents/selectFiles/${torrentId}`, { files: selected.join(',') });
      toast('Arquivos selecionados! Fechando...', 'success');
      browser.runtime.sendMessage('rd-check-now');
      setTimeout(() => window.close(), 1500);
    } catch (err) {
      toast('Falha ao iniciar o download', 'error');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Iniciar Download';
    }
  });

  $('#content').replaceChildren(el('div', {},
    el('div', {style: 'font-weight: 600; margin-bottom: 10px;'}, 'Selecione os arquivos para baixar:'),
    selectAllBtn,
    fileList,
    confirmBtn
  ));
}
