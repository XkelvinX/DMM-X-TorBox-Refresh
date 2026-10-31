// ==UserScript==
// @name         DMM X TorBox Auto Refresh
// @namespace    kelvin.torbox.webdav
// @version      2.6.0
// @homepageURL  https://github.com/XkelvinX/DMM-X-TorBox-Refresh
// @updateURL    https://raw.githubusercontent.com/XkelvinX/DMM-X-TorBox-Refresh/main/DMMTorBox-Refresh.user.js
// @downloadURL  https://raw.githubusercontent.com/XkelvinX/DMM-X-TorBox-Refresh/main/DMMTorBox-Refresh.user.js
// @description  Envia NZBs limpos do DMM direto ao TorBox, acompanha torrents e Usenet e atualiza o WebDAV quando ficam disponíveis.
// @match        https://torbox.app/*
// @match        https://www.torbox.app/*
// @match        https://debridmediamanager.com/*
// @match        https://www.debridmediamanager.com/*
// @run-at       document-end
// @inject-into  content
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @connect      api.torbox.app
// @connect      webdav.torbox.app
// ==/UserScript==

/*
 * Fluxo: NZB enviado pelo DMM (interceptação direta) ou em torbox.app; torrent pelo DMM.
 * Não sobrescreve fetch/XHR da página: GM com privilégios roda isolado no wBlock atual.
 * No DMM, sincroniza automaticamente a API key do TorBox (localStorage['tb:apiKey']) se ainda
 * não configurada, intercepta o clique em <a href="blob:..." download="*.nzb"> gerado pelo
 * botão NZB, lê o XML limpo sincronicamente antes do revokeObjectURL e envia direto ao TorBox
 * com feedback visual no próprio botão NZB da linha; se falhar ou não houver API key, faz o
 * download normal do .nzb no iOS como fallback.
 * Faz consultas enquanto a aba está visível; retoma ao voltar ao Safari.
 * Ao ocultar, conclui somente o ciclo já iniciado e o refresh dos itens prontos.
 * Sem novos ciclos/retries ocultos; tolerância de conclusão limitada a 60 s.
 * O iOS pode suspender a execução. Não é um serviço de background.
 * Primeira configuração: um refresh para sincronizar os arquivos já prontos.
 * Depois: novos arquivos disponíveis, inclusive os concluídos fora desta aba.
 * O refresh do servidor não força a varredura da biblioteca do Infuse.
 *
 * 2.6.0:
 *   - Renomeado para DMM X TorBox Auto Refresh.
 *   - Sincronização automática da API key do TorBox já salva no DMM (localStorage['tb:apiKey']).
 *   - Feedback visual direto no botão NZB da linha no DMM (enviando, ✓ TorBox ou alerta).
 * 2.5.1:
 *   - Proteção contra concorrência entre ciclo de polling e envio de NZB (nzbInFlight
 *     + janela de aceleração pós-envio), checagem de revisão após upload e validação
 *     de codepoints XML.
 * 2.5.0:
 *   - Interceptação direta de arquivos .nzb limpos no DMM (aba Usenet e /anonymize-nzb)
 *     com envio imediato para POST /v1/api/usenet/createusenetdownload e fallback local.
 * 2.4.0:
 *   - Refresh manual marca como sincronizados os itens prontos da última listagem.
 *   - cached_at fora da identidade (um único refresh extra após atualizar).
 *   - Espera aleatória antes das travas entre abas; diagnóstico informa finalUrl.
 *   - Estados centralizados, ciclo dividido em funções e painel no padrão visual do DMM 4.0.1.
 *   - Detecta explicitamente o código PLAN_RESTRICTED_FEATURE (plano gratuito do TorBox).
 *
 * DMM revalidado em 25/10/2026: v4.0.1 (commit eb67f35b, UsenetResults/nzbDownload/nzbSanitize).
 * Endpoints preservados; círculo independente no celular e acima do nativo visível.
 * HTTP 429 da API pausa torrents e Usenet entre abas do userscript.
 * Contador: arquivos conhecidos; + indica arquivos ainda não enumerados.
 * Fontes da implementação original, auditadas em 21/09/2026:
 * DMM main d803050b8b17c21bdf05821ca4ea384e12a2da64
 *   src/services/torbox.ts; torbox.postman_collection.json
 * wBlock 3.1.0 e main 66426f4913f97b5d26986f16b6b9bbb1d2f261d7
 *   wBlock Scripts (iOS)/Resources/userscript-injector.js
 * https://support.torbox.app/en/articles/14662867-torbox-webdav
 */
(() => {
  'use strict';
  if (window.top !== window.self) return;
  // Fonte única: @version do cabeçalho. O literal só é usado se GM_info não existir.
  const SCRIPT_VERSION = (typeof GM_info === 'object' && GM_info?.script?.version) || '2.6.0';
  const SCRIPT_TITLE = 'DMM X TorBox Auto Refresh';
  const API = 'https://api.torbox.app/v1/api';
  const DAV = 'https://webdav.torbox.app/refresh';
  const USENET_CREATE = `${API}/usenet/createusenetdownload`;
  const KEY = 'torbox_api_key'; // Mantém a chave se editar o userscript antigo.
  const DMM_KEY = 'tb:apiKey';
  const STATE = 'tb_webdav_v2_state';
  const PAUSE = 'tb_webdav_v2_paused';
  // Repositório público: nenhuma chave no código. A chave salva pelas versões
  // anteriores continua no armazenamento do wBlock e segue sendo usada.
  const KINDS = ['torrents', 'usenet'];
  const POLL = 15000;
  const ACTIVE_POLL = 3000;
  const ACTIVE_WINDOW = 60000;
  const CACHE_LIMIT = 4 * 1024 * 1024;
  const PAGE_SIZE = 1000;
  const COOLDOWN = 10000;
  const LOCK = 'tb_webdav_refresh_lease_v1';
  const OWNER = crypto.randomUUID();
  const POLL_LEASE_MS = 45000;
  const FINISH_WINDOW = 60000;
  const STATE_LIMIT = 900000;
  const IS_DMM = /^(www\.)?debridmediamanager\.com$/.test(window.location.hostname);
  const ANCHOR_SELECTOR = 'button[aria-label="Refresh library"]';
  const NZB_BTN_PREFIX = 'Download clean NZB for ';

  // ---------------------------------------------------------------- Estados
  const S = Object.freeze({
    CONFIG: 'Configurar', PAUSED: 'Pausado', CHECKING: 'Verificando',
    UPDATING: 'Atualizando', SENDING_NZB: 'Enviando NZB', WAITING: 'Aguardando',
    OTHER_TAB: 'Outra aba', AUTH: 'Verificar acesso', RETRY: 'Tentando novamente',
    PARTIAL: 'Consulta parcial', API_DOWN: 'API indisponível', ATTENTION: 'Atenção',
    PENDING: 'Pendente', OK: 'OK', MONITORING: 'Monitorando'
  });
  // icon: símbolo fixo; problem: cor de alerta; clock/busy: estados transitórios;
  // keepSuccess: não cancela o "OK" temporário. Estados desconhecidos (relatórios
  // de versões antigas) são exibidos sem efeito colateral.
  const STATUS_INFO = Object.freeze({
    [S.CONFIG]: { icon: 'settings' },
    [S.PAUSED]: { icon: 'pause' },
    [S.AUTH]: { problem: 'error' },
    [S.RETRY]: { problem: 'warning' },
    [S.PARTIAL]: { problem: 'warning' },
    [S.API_DOWN]: { problem: 'warning' },
    [S.ATTENTION]: { problem: 'warning' },
    [S.WAITING]: { clock: true },
    [S.OTHER_TAB]: { clock: true },
    [S.UPDATING]: { busy: true },
    [S.SENDING_NZB]: { busy: true },
    [S.CHECKING]: { busy: true, keepSuccess: true },
    [S.PENDING]: { keepSuccess: true },
    [S.OK]: { keepSuccess: true },
    [S.MONITORING]: { keepSuccess: true }
  });

  // ------------------------------------------------------- Estado em memória
  const identityCache = { torrents: new Map(), usenet: new Map() };
  const activityCache = { torrents: new Map(), usenet: new Map() };
  const cacheBytes = { torrents: 0, usenet: 0 };
  const listRetry = { torrents: 0, usenet: 0 };
  const listFailures = { torrents: 0, usenet: 0 };
  const emptyPending = () => ({ files: 0, downloads: 0, unknown: 0, active: 0 });
  const pendingByKind = { torrents: emptyPending(), usenet: emptyPending() };
  const diagnostics = [];
  let pollTicket = null;
  let pollInvalidated = false;
  let pollHeartbeat = null;
  let finishEligible = false;
  let finishUntil = 0;
  let scopeKey = '';
  let scopeName = '';
  let lastUiAt = 0;
  let anchor = null;
  let anchorObserver = null;
  let layoutFrame = 0;
  let timer = null;
  let running = false;
  let blockedAuth = false;
  let failures = 0;
  let retryAt = 0;
  let manualPending = false;
  let manualVersion = 0;
  let wakePending = false;
  let revision = 0;
  let button;
  let labelNode;
  let panel, panelDetail, panelPause, panelDiag, panelDiagText, panelCopy;
  let successUntil = 0;
  let successTimer = null;
  let pendingCount = 0;
  let pendingDownloads = 0;
  let unknownCount = 0;
  let activeCount = 0;
  let nzbInFlight = 0;
  let nzbBoostUntil = 0;
  const nzbButtonByFile = new Map();
  let lastNzbButton = null;
  // Última listagem válida desta aba: usada pelo refresh manual.
  let lastReady = {};
  let lastCounts = {};
  let status = S.CONFIG;
  let detail = 'Toque para configurar a API key do TorBox.';

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const jitter = () => sleep(50 + Math.random() * 250);
  const canFinishHidden = () => running && finishEligible && finishUntil > Date.now();
  const read = (name, fallback) => GM_getValue(name, fallback);
  const keyNow = () => String(read(KEY, '') || '').trim();
  const paused = () => read(PAUSE, false) === true;
  const visible = () => document.visibilityState !== 'hidden';
  const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');

  // ----------------------------------------------------------- Posicionamento
  function placement() {
    const base = { left: IS_DMM ? '16px' : '10px', right: 'auto', top: 'auto',
      bottom: IS_DMM ? '4px'
        : 'calc(110px + env(safe-area-inset-bottom, 0px))' };
    if (IS_DMM) {
      // No celular, o DMM oculta o indicador nativo. A posição base é independente.
      const target = document.querySelector(ANCHOR_SELECTOR)?.closest('.fixed');
      if (target !== anchor) {
        anchorObserver?.disconnect();
        anchor = target || null;
        if (anchor) anchorObserver?.observe(anchor);
      }
      if (anchor && anchor.getClientRects().length) {
        if (anchor.style.getPropertyValue('bottom') !== '4px' ||
            anchor.style.getPropertyPriority('bottom') !== 'important')
          anchor.style.setProperty('bottom', '4px', 'important');
        const css = getComputedStyle(anchor);
        const bottom = parseFloat(css.bottom);
        if (css.position === 'fixed' && Number.isFinite(bottom)) {
          base.left = css.left;
          base.bottom = `${Math.round(bottom + anchor.getBoundingClientRect().height + 8)}px`;
        }
      }
    }
    return base;
  }
  function updatePlacement() {
    if (!button) return;
    // Evita reescrever estilos e invalidar layout sem alteração real.
    for (const [property, value] of Object.entries(placement())) {
      if (button.style[property] !== value) button.style[property] = value;
    }
    placePanel();
  }

  function queuePlacement() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0;
      updatePlacement();
    });
  }
  function watchPlacement() {
    if (typeof ResizeObserver === 'function') {
      anchorObserver = new ResizeObserver(queuePlacement);
      if (anchor) anchorObserver.observe(anchor);
      const sizeObserver = new ResizeObserver(queuePlacement);
      sizeObserver.observe(button);
    }
    if (IS_DMM) {
      // Detecta a montagem/troca do balão em rotas SPA, ignorando as demais
      // atualizações do DMM e as mutações do nosso próprio indicador.
      const containsAnchor = node => node.nodeType === 1 && node !== button && node !== panel &&
        (node.matches?.(ANCHOR_SELECTOR) || node.querySelector?.(ANCHOR_SELECTOR));
      new MutationObserver(records => {
        if (anchor && !anchor.isConnected || records.some(record =>
          [...record.addedNodes, ...record.removedNodes].some(containsAnchor))) queuePlacement();
      }).observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('resize', queuePlacement);
    window.addEventListener('pageshow', queuePlacement);
    window.visualViewport?.addEventListener('resize', queuePlacement);
    updatePlacement();
  }

  // -------------------------------------------------------------- Interface
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // Traços próprios no estilo Lucide usado pelo DMM. Sem dependência externa.
  const ICONS = {
    cloud: ['M7 18a5 5 0 1 1 1-9.9A6 6 0 0 1 20 10a4 4 0 0 1-1 8H7'],
    clock: ['M12 8v4l3 2'],
    pause: ['M9 7v10', 'M15 7v10'],
    settings: ['M12 5v14', 'M5 12h14'],
    alert: ['M12 8v4', 'M12 16h.01'],
    close: ['M18 6 6 18', 'm6 6 12 12']
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    for (const [k, v] of Object.entries({viewBox:'0 0 24 24', width:'16', height:'16',
      fill:'none', stroke:'currentColor', 'stroke-width':'1.7',
      'stroke-linecap':'round', 'stroke-linejoin':'round', 'aria-hidden':'true'}))
      svg.setAttribute(k, v);
    if (name === 'clock' || name === 'alert') {
      const circle = document.createElementNS(SVG_NS, 'circle');
      for (const [k,v] of Object.entries({cx:'12',cy:'12',r:'9'})) circle.setAttribute(k,v);
      svg.appendChild(circle);
    }
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }
  function renderControl() {
    if (!button) return;
    const info = STATUS_INFO[status] || {};
    let mode = 'idle', symbol = 'cloud', text = '';
    if (info.icon) symbol = info.icon;
    else if (info.problem) { mode = info.problem; symbol = 'alert'; }
    else if (pendingCount > 0 || unknownCount > 0) {
      mode = 'pending'; text = pendingCount ? `${pendingCount}${unknownCount ? '+' : ''}` : '?';
    } else if (Date.now() < successUntil) { mode = 'success'; text = 'OK'; }
    else if (info.clock) symbol = 'clock';
    else if (info.busy) mode = 'busy';
    const label = text || `icon:${symbol}`;
    if (labelNode.dataset.label !== label) {
      labelNode.replaceChildren(text ? document.createTextNode(text) : icon(symbol));
      labelNode.dataset.label = label;
    }
    button.dataset.state = mode;
    button.dataset.digits = text.length > 3 ? 'many' : 'normal';
    button.setAttribute('aria-label', `${SCRIPT_TITLE}: ${detail} Abrir controles.`);
    // Sem title: evita também o balão nativo de tooltip.
    renderPanel();
  }
  function show(label, explanation = label) {
    status = label;
    detail = explanation;
    lastUiAt = Date.now();
    const info = STATUS_INFO[label];
    if (label === S.OK && !pendingCount && !unknownCount) {
      successUntil = Date.now() + 6000;
      clearTimeout(successTimer);
      successTimer = setTimeout(renderControl, 6000);
    } else if (pendingCount > 0 || unknownCount > 0 || (info && !info.keepSuccess)) {
      successUntil = 0;
      clearTimeout(successTimer);
    }
    renderControl();
  }
  function notify(text) {
    // Mensagens disponíveis ao toque, sem toast ou balão sobre a página.
    detail = text;
    renderControl();
  }

  // ------------------------------------------------------------------ Painel
  const panelOpen = () => !!panel && !panel.hidden;
  function action(text, handler, close = true, variant = '') {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tbwd-action${variant ? ` tbwd-action-${variant}` : ''}`;
    b.textContent = text;
    b.addEventListener('click', event => {
      event.stopPropagation();
      if (close) closePanel();
      handler();
    });
    return b;
  }
  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'tbwd-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', `Controles do ${SCRIPT_TITLE}`);
    const header = document.createElement('div');
    header.className = 'tbwd-header';
    const title = document.createElement('h2');
    title.className = 'tbwd-title';
    title.textContent = `${SCRIPT_TITLE} ${SCRIPT_VERSION}`;
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'tbwd-close';
    closeBtn.setAttribute('aria-label', 'Fechar');
    closeBtn.appendChild(icon('close'));
    closeBtn.addEventListener('click', event => {
      event.stopPropagation();
      closePanel();
      button?.focus();
    });
    header.append(title, closeBtn);
    const body = document.createElement('div');
    body.className = 'tbwd-body';
    panelDetail = document.createElement('p');
    panelDetail.className = 'tbwd-detail';
    panelDetail.setAttribute('aria-live', 'polite');
    panelPause = action('', togglePause, false);
    const actions = document.createElement('div');
    actions.className = 'tbwd-actions';
    actions.append(
      action('Verificar e atualizar agora', requestManual, true, 'primary'),
      panelPause,
      action('Definir/trocar API key', configure),
      action('Ver diagnóstico', toggleDiagnostics, false),
      action('Apagar chave armazenada', forget, true, 'danger'));
    panelDiag = document.createElement('div');
    panelDiag.className = 'tbwd-diag';
    panelDiag.hidden = true;
    panelDiagText = document.createElement('pre');
    panelCopy = action('Copiar diagnóstico', copyDiagnostics, false);
    panelDiag.append(panelDiagText, panelCopy);
    body.append(panelDetail, actions, panelDiag);
    panel.append(header, body);
    document.body.appendChild(panel);
    document.addEventListener('pointerdown', event => {
      if (panelOpen() && !panel.contains(event.target) && !button.contains(event.target)) closePanel();
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && panelOpen()) { closePanel(); button.focus(); }
    });
  }
  function placePanel() {
    if (!panelOpen() || !button) return;
    // Posição pelo retângulo do botão: funciona com bottom em px ou calc().
    const rect = button.getBoundingClientRect();
    const height = document.documentElement.clientHeight || window.innerHeight;
    panel.style.left = `${Math.max(8, Math.round(rect.left))}px`;
    panel.style.bottom = `${Math.max(8, Math.round(height - rect.top + 8))}px`;
  }
  function renderPanel() {
    if (!panelOpen()) return;
    panelDetail.textContent = detail;
    panelPause.textContent = paused() ? 'Retomar acompanhamento' : 'Pausar acompanhamento';
    if (!panelDiag.hidden) panelDiagText.textContent = diagnosticsText();
  }
  function openPanel() {
    if (!panel) return;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    placePanel();
    renderPanel();
  }
  function closePanel() {
    if (!panel) return;
    panel.hidden = true;
    panelDiag.hidden = true;
    button?.setAttribute('aria-expanded', 'false');
  }
  function togglePanel() {
    if (panelOpen()) closePanel(); else openPanel();
  }
  function toggleDiagnostics() {
    panelDiag.hidden = !panelDiag.hidden;
    panelCopy.textContent = 'Copiar diagnóstico';
    renderPanel();
  }
  async function copyDiagnostics() {
    const text = diagnosticsText();
    try {
      await navigator.clipboard.writeText(text);
      panelCopy.textContent = 'Copiado';
    } catch {
      // Sem permissão de área de transferência: seleciona o texto para cópia manual.
      const range = document.createRange();
      range.selectNodeContents(panelDiagText);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      panelCopy.textContent = 'Texto selecionado';
    }
  }

  // ------------------------------------------------------------ Configuração
  const emptyState = () => ({ version: 2, ready: { torrents: [], usenet: [] }, lastRefresh: 0 });
  function stateNow() {
    const s = read(STATE, null);
    const valid = s?.version === 2 && KINDS.every(kind =>
      Array.isArray(s.ready?.[kind]) && s.ready[kind].every(v => typeof v === 'string'));
    if (!valid) return emptyState();
    const lastRefresh = Number.isFinite(s.lastRefresh) && s.lastRefresh >= 0
      && s.lastRefresh <= Date.now() ? s.lastRefresh : 0;
    return { version: 2, ready: s.ready, lastRefresh };
  }
  function pollDelay() {
    return activeCount > 0 || Date.now() < successUntil || Date.now() < nzbBoostUntil ? ACTIVE_POLL : POLL;
  }
  function schedule(delay = pollDelay()) {
    clearTimeout(timer);
    if (!visible() || paused() || blockedAuth || !keyNow()) return;
    if (running || nzbInFlight > 0) { if (delay === 0) wakePending = true; return; }
    timer = setTimeout(() => void cycle(), Math.max(delay, retryAt - Date.now(), manualPending ? 0 : apiPauseRemaining(), 0));
  }
  function changedSettings() {
    releasePolling(0, false);
    revision++;
    blockedAuth = false;
    failures = 0;
    retryAt = 0;
    manualPending = false;
    pendingCount = 0;
    pendingDownloads = 0; unknownCount = 0; activeCount = 0;
    nzbBoostUntil = 0;
    successUntil = 0;
    lastReady = {}; lastCounts = {};
    clearTimeout(successTimer);
    for (const kind of KINDS) {
      listRetry[kind] = 0; listFailures[kind] = 0;
      pendingByKind[kind] = emptyPending();
      identityCache[kind].clear(); activityCache[kind].clear(); cacheBytes[kind] = 0;
    }
    clearTimeout(timer);
    show(paused() ? S.PAUSED : keyNow() ? S.CHECKING : S.CONFIG,
      paused() ? 'Toque para retomar o acompanhamento.'
        : keyNow() ? 'Consultando as listas do TorBox.' : 'Toque para configurar a API key do TorBox.');
    schedule(0);
  }
  function readDmmTorBoxKey() {
    if (!IS_DMM) return '';
    try {
      const raw = window.localStorage?.getItem(DMM_KEY);
      if (!raw) return '';
      let parsed;
      try { parsed = JSON.parse(raw); } catch { parsed = raw; }
      if (parsed && typeof parsed === 'object' && 'value' in parsed) {
        if (Number.isFinite(parsed.expiry) && parsed.expiry < Date.now()) return '';
        parsed = parsed.value;
      }
      const candidate = typeof parsed === 'string' ? parsed.trim() : '';
      return /^[\x21-\x7e]+$/.test(candidate) ? candidate : '';
    } catch { return ''; }
  }
  function syncDmmApiKey(notifyChange = true) {
    if (keyNow()) return false;
    const dmmKey = readDmmTorBoxKey();
    if (!dmmKey) return false;
    GM_deleteValue(STATE);
    GM_setValue(KEY, dmmKey);
    if (notifyChange) changedSettings();
    return true;
  }
  function configure() {
    if (syncDmmApiKey(true)) return;
    const value = prompt('Cole sua API key do TorBox. Ela será salva pelo wBlock para este userscript. Não use a senha da sua conta.');
    if (value === null) return;
    const key = value.trim();
    if (!key || !/^[\x21-\x7e]+$/.test(key)) {
      show(S.ATTENTION, 'Chave inválida: cole apenas a API key, sem espaços.');
      return;
    }
    if (key !== keyNow()) {
      GM_deleteValue(STATE);
      GM_setValue(KEY, key);
    }
    changedSettings();
  }
  function forget() {
    if (!confirm('Apagar a chave armazenada? O acompanhamento fica parado até você definir uma nova chave.')) return;
    GM_deleteValue(KEY);
    GM_deleteValue(STATE);
    changedSettings();
  }
  function togglePause() {
    GM_setValue(PAUSE, !paused());
    changedSettings();
  }
  function requestManual() {
    if (!keyNow() && !syncDmmApiKey(true)) { configure(); return; }
    if (paused()) { notify('Retome o acompanhamento antes de atualizar.'); return; }
    if (blockedAuth) { configure(); return; }
    manualPending = true;
    manualVersion++;
    schedule(0);
  }
  function diagnosticsText() {
    return [
      `${SCRIPT_TITLE} ${SCRIPT_VERSION}`,
      `Estado: ${status}`,
      `Aba: ${visible() ? 'visível' : 'oculta'}; pausa: ${paused() ? 'sim' : 'não'}`,
      `Chave armazenada: ${keyNow() ? 'sim' : 'não'}`,
      ...diagnostics
    ].join('\n');
  }
  function showDiagnostics() {
    // Diagnóstico sem chave ou nomes de arquivos.
    openPanel();
    if (panelDiag?.hidden) toggleDiagnostics();
  }
  function recordResponse(url, res) {
    const operation = url === DAV ? 'WebDAV' : url === USENET_CREATE ? 'NZB->TorBox'
      : url.includes('/usenet/') ? 'Usenet' : 'Torrents';
    const text = String(res.responseText || '').trim();
    const format = /^[{[]/.test(text) ? 'JSON' : /<html\b/i.test(text) ? 'HTML' : 'outro';
    // finalUrl indica se o gerenciador expõe o destino após redirecionamentos.
    const final = url === DAV ? `; finalUrl ${res.finalUrl ? 'informado' : 'ausente'}` : '';
    diagnostics.push(`${operation}: HTTP ${res.status || 0}; formato ${format}${final}`);
    if (diagnostics.length > 8) diagnostics.shift();
  }
  function mount() {
    if (button || !document.body) return;
    button = document.createElement('button');
    button.type = 'button';
    const z = IS_DMM ? 40 : 2147483646;
    const style = document.createElement('style');
    style.textContent = `
      #tbwd-control {
        box-sizing:border-box; appearance:none; -webkit-appearance:none;
        position:fixed; margin:0; padding:0; width:36px; height:36px;
        min-width:36px; min-height:36px; max-width:36px; max-height:36px;
        border:1px solid #374151; border-radius:9999px; background:#1f2937;
        color:#9ca3af; display:grid; place-items:center; cursor:pointer;
        font-family:ui-sans-serif,system-ui,sans-serif;
        font-size:13px; font-weight:500; line-height:1; letter-spacing:normal;
        box-shadow:0 10px 15px -3px rgb(0 0 0 / .1), 0 4px 6px -4px rgb(0 0 0 / .1);
        z-index:${z}; transition:transform 75ms, background-color 150ms, color 150ms, border-color 150ms;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      #tbwd-control:active { transform:scale(.95); }
      #tbwd-control::before {
        content:''; position:absolute; inset:-4px; border-radius:9999px;
      }
      #tbwd-control .tbwd-label {
        display:grid; place-items:center; color:inherit; font:inherit;
        pointer-events:none; font-variant-numeric:tabular-nums;
      }
      #tbwd-control[data-state="pending"] { color:#f3f4f6; }
      #tbwd-control[data-state="busy"] { background:rgb(22 78 99 / .5); color:#22d3ee; border-color:rgb(6 182 212 / .4); }
      #tbwd-control[data-state="success"] { color:#4ade80; }
      #tbwd-control[data-state="warning"] { background:rgb(113 63 18 / .5); color:#facc15; border-color:rgb(234 179 8 / .4); }
      #tbwd-control[data-state="error"] { background:rgb(127 29 29 / .5); color:#f87171; border-color:rgb(239 68 68 / .4); }
      #tbwd-control[data-digits="many"] { font-size:10px; }
      #tbwd-control:focus-visible { outline:2px solid #22d3ee; outline-offset:4px; }
      @media(hover:hover) {
        #tbwd-control:hover { border-color:#6b7280; color:#e5e7eb; }
        #tbwd-control[data-state="busy"]:hover { background:rgb(21 94 117 / .5); color:#67e8f9; }
        #tbwd-control[data-state="warning"]:hover { background:rgb(133 77 14 / .5); }
        #tbwd-control[data-state="error"]:hover { background:rgb(153 27 27 / .5); }
      }
      @keyframes tbwd-slide-up {
        from { opacity:0; transform:translateY(8px); }
        to { opacity:1; transform:translateY(0); }
      }
      #tbwd-panel {
        box-sizing:border-box; position:fixed; margin:0; padding:0;
        width:min(288px, calc(100vw - 16px)); max-height:70vh; overflow:hidden;
        display:flex; flex-direction:column;
        border:1px solid #374151; border-radius:12px; background:#111827;
        color:#e5e7eb; font:13px/1.4 ui-sans-serif,system-ui,sans-serif;
        text-align:left; box-shadow:0 25px 50px -12px rgb(0 0 0 / .25); z-index:${z};
        animation:tbwd-slide-up 180ms cubic-bezier(.34,1.56,.64,1);
      }
      #tbwd-panel[hidden] { display:none; }
      #tbwd-panel .tbwd-header {
        display:flex; align-items:center; justify-content:space-between; gap:8px;
        padding:10px 12px; border-bottom:1px solid #374151;
      }
      #tbwd-panel .tbwd-title { font-size:14px; font-weight:700; color:#fff; margin:0; }
      #tbwd-panel .tbwd-close {
        box-sizing:border-box; appearance:none; -webkit-appearance:none;
        margin:0; padding:4px; border:0; border-radius:4px; background:transparent;
        color:#9ca3af; display:grid; place-items:center; cursor:pointer;
        transition:transform 75ms, color 150ms, background-color 150ms;
        -webkit-tap-highlight-color:transparent; touch-action:manipulation;
      }
      #tbwd-panel .tbwd-close:active { transform:scale(.98); }
      #tbwd-panel .tbwd-close:focus-visible { outline:2px solid #22d3ee; outline-offset:2px; }
      @media(hover:hover) { #tbwd-panel .tbwd-close:hover { color:#e5e7eb; background:#1f2937; } }
      #tbwd-panel .tbwd-body { padding:12px; overflow-y:auto; }
      #tbwd-panel .tbwd-detail {
        margin:0 0 10px; font-size:12px; color:#9ca3af; white-space:pre-wrap; overflow-wrap:anywhere;
      }
      #tbwd-panel .tbwd-actions { display:grid; gap:6px; }
      #tbwd-panel .tbwd-action {
        box-sizing:border-box; appearance:none; -webkit-appearance:none; width:100%;
        margin:0; padding:8px 10px; border:1px solid #374151; border-radius:6px;
        background:#1f2937; color:#e5e7eb; font:500 13px/1.3 ui-sans-serif,system-ui,sans-serif;
        text-align:left; cursor:pointer; touch-action:manipulation;
        transition:transform 75ms, background-color 150ms, border-color 150ms, color 150ms;
        -webkit-tap-highlight-color:transparent;
      }
      #tbwd-panel .tbwd-action:active { transform:scale(.98); }
      #tbwd-panel .tbwd-action-primary {
        border-color:rgb(6 182 212 / .5); background:rgb(22 78 99 / .5); color:#67e8f9; font-weight:600;
      }
      #tbwd-panel .tbwd-action-danger {
        border-color:rgb(239 68 68 / .4); background:rgb(127 29 29 / .3); color:#fca5a5;
      }
      #tbwd-panel .tbwd-action:focus-visible { outline:2px solid #22d3ee; outline-offset:2px; }
      @media(hover:hover) {
        #tbwd-panel .tbwd-action:hover { background:#374151; border-color:#4b5563; }
        #tbwd-panel .tbwd-action-primary:hover { background:rgb(21 94 117 / .5); border-color:#06b6d4; color:#a5f3fc; }
        #tbwd-panel .tbwd-action-danger:hover { background:rgb(153 27 27 / .5); border-color:#ef4444; color:#fecaca; }
      }
      #tbwd-panel .tbwd-diag[hidden] { display:none; }
      #tbwd-panel .tbwd-diag pre {
        margin:10px 0 6px; padding:8px; border:1px solid #374151; border-radius:6px;
        background:#030712; color:#d1d5db; white-space:pre-wrap; overflow-wrap:anywhere;
        font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
        user-select:text; -webkit-user-select:text;
      }
      button[data-tbwd-nzb="sending"] {
        border-color:rgb(6 182 212 / .6) !important; background:rgb(22 78 99 / .45) !important; color:#67e8f9 !important;
      }
      button[data-tbwd-nzb="sent"] {
        border-color:rgb(34 197 94 / .6) !important; background:rgb(20 83 45 / .45) !important; color:#86efac !important;
      }
      button[data-tbwd-nzb="error"] {
        border-color:rgb(234 179 8 / .6) !important; background:rgb(113 63 18 / .45) !important; color:#fde047 !important;
      }
      button[data-tbwd-nzb] .tbwd-nzb-badge {
        margin-left:3px; font-weight:700;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    button.id = 'tbwd-control';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    Object.assign(button.style, { position: 'fixed', ...placement() });
    labelNode = document.createElement('span');
    labelNode.className = 'tbwd-label';
    labelNode.setAttribute('aria-hidden', 'true');
    button.appendChild(labelNode);
    button.addEventListener('click', togglePanel);
    document.body.appendChild(button);
    buildPanel();
    show(status, detail);
    watchPlacement();
  }

  // -------------------------------------------------------------------- HTTP
  function error(message, auth = false, wait = 0) {
    return Object.assign(new Error(message), { auth, wait });
  }
  function retryDelay(headers = '', fallback = 60000) {
    const match = String(headers).match(/^retry-after:\s*(.+)$/im);
    if (!match) return fallback;
    const value = match[1].trim();
    const ms = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(ms) ? Math.max(1000, ms) : fallback;
  }
  function request(url, authorization, options = {}) {
    // URLs fixas: nenhuma chave é enviada ao DMM ou colocada na query string.
    return new Promise((resolve, reject) => {
      let handle;
      let settled = false;
      const watchdog = setTimeout(() => {
        settled = true;
        reject(error('Tempo limite de conexão.'));
        try { handle?.abort(); } catch { /* já encerrada */ }
      }, 35000);
      const finish = fn => value => {
        if (settled) return;
        settled = true; clearTimeout(watchdog); fn(value);
      };
      try {
        handle = GM_xmlhttpRequest({
          method: options.method || 'GET', url, timeout: 30000, anonymous: true,
          // "redirect" é extensão do Tampermonkey; gerenciadores que a ignoram
          // seguem o redirecionamento. Nesse caso valem finalUrl e validWebDAV.
          redirect: url === DAV ? 'follow' : 'error',
          headers: { Authorization: authorization, 'Cache-Control': 'no-cache', ...options.headers },
          ...(options.data !== undefined ? { data: options.data } : {}),
          onload: finish(res => { recordResponse(url, res); resolve(res); }),
          onerror: finish(() => reject(error('Falha de conexão.'))),
          ontimeout: finish(() => reject(error('Tempo limite de conexão.'))),
          onabort: finish(() => reject(error('Conexão interrompida.')))
        });
      } catch {
        clearTimeout(watchdog);
        reject(error('O wBlock não conseguiu iniciar a requisição.'));
      }
    });
  }

  // ------------------------------------------------ Interceptação NZB no DMM
  function safeDmmNzbName(title) {
    // Espelha safeNzbName() em src/utils/nzbName.ts do DMM 4.0.1 para associar
    // o botão NZB clicado na tabela Usenet ao <a download="*.nzb"> assíncrono.
    const cleaned = Array.from(String(title || ''), ch => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || '/\\?%*:|"<>'.includes(ch) ? '' : ch;
    }).join('').trim().slice(0, 200);
    return `${cleaned || 'download'}.nzb`.toLowerCase();
  }
  function markNzbButton(btn, state, badgeText = '') {
    if (!btn || !btn.isConnected) return;
    btn.dataset.tbwdNzb = state;
    const applyBadge = () => {
      if (!btn.isConnected || btn.dataset.tbwdNzb !== state) return;
      let badge = btn.querySelector('.tbwd-nzb-badge');
      if (!badgeText) {
        badge?.remove();
        return;
      }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'tbwd-nzb-badge';
        badge.setAttribute('aria-hidden', 'true');
        btn.appendChild(badge);
      }
      badge.textContent = badgeText;
    };
    applyBadge();
    setTimeout(applyBadge, 60);
  }
  function resolveNzbButton(filename) {
    const key = String(filename || '').trim().toLowerCase();
    const mapped = nzbButtonByFile.get(key);
    if (mapped) nzbButtonByFile.delete(key);
    if (mapped?.isConnected) return mapped;
    if (lastNzbButton?.isConnected) {
      const fallbackBtn = lastNzbButton;
      lastNzbButton = null;
      return fallbackBtn;
    }
    return null;
  }
  function triggerLocalNzbFallback(xml, filename) {
    // Dispara o download nativo do arquivo .nzb para o app Arquivos do iOS caso
    // o envio direto para a API do TorBox falhe ou não haja API key configurada.
    const blob = new Blob([xml], { type: 'application/x-nzb' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.dataset.tbwdFallback = '1';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  function readBlobXmlSync(blobUrl) {
    // No DMM (saveBlob em nzbDownload.ts), URL.revokeObjectURL(url) roda logo na
    // linha seguinte ao anchor.click(). XHR síncrono em blob: de mesma origem lê
    // o XML da memória instantaneamente antes do click() retornar ao código da página.
    const xhr = new XMLHttpRequest();
    xhr.open('GET', blobUrl, false);
    xhr.send();
    if (xhr.status !== 200 && xhr.status !== 0) throw error('Não foi possível ler o NZB local.');
    const xml = String(xhr.responseText || '');
    if (!xml.includes('<nzb') || !xml.includes('<file')) throw error('Conteúdo NZB inválido.');
    return xml;
  }
  function decodeXmlText(raw) {
    return String(raw || '').replace(
      /&(?:#(\d+)|#x([0-9a-fA-F]+)|(quot|apos|lt|gt|amp));/g,
      (full, dec, hex, named) => {
        if (dec !== undefined || hex !== undefined) {
          const code = dec !== undefined ? Number(dec) : parseInt(hex, 16);
          return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
            ? String.fromCodePoint(code) : full;
        }
        return { quot: '"', apos: "'", lt: '<', gt: '>', amp: '&' }[named] ?? full;
      }
    );
  }
  function extractNzbMeta(xml, type) {
    const re = new RegExp(`<meta\\b[^>]*\\btype\\s*=\\s*["']${type}["'][^>]*>([\\s\\S]*?)<\\/meta>`, 'i');
    const match = re.exec(xml);
    return match ? decodeXmlText(match[1]).trim() : '';
  }
  function buildNzbMultipart(xml, filename) {
    // String multipart/form-data pura: atravessa a ponte JSON (browser.runtime.sendMessage)
    // do wBlock no iOS sem depender de serialização nativa de FormData ou Blob.
    let boundary = `----TorBoxWebDAVNzb${crypto.randomUUID().replace(/-/g, '')}`;
    while (xml.includes(boundary)) boundary += crypto.randomUUID().slice(0, 8);
    const safeFile = filename.replace(/[\r\n"\\]/g, '_');
    const cleanName = safeFile.replace(/\.nzb$/i, '').trim();
    const password = extractNzbMeta(xml, 'password').replace(/\r?\n/g, ' ');
    const parts = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${safeFile}"`,
      'Content-Type: application/x-nzb',
      '',
      xml
    ];
    if (cleanName) {
      parts.push(
        `--${boundary}`,
        'Content-Disposition: form-data; name="name"',
        '',
        cleanName
      );
    }
    if (password) {
      parts.push(
        `--${boundary}`,
        'Content-Disposition: form-data; name="password"',
        '',
        password
      );
    }
    parts.push(`--${boundary}--`, '');
    return { boundary, body: parts.join('\r\n'), cleanName: cleanName || safeFile };
  }
  async function uploadNzbToTorBox(xml, filename, sourceBtn = null) {
    if (!keyNow()) syncDmmApiKey(false);
    const key = keyNow();
    if (!key) {
      markNzbButton(sourceBtn, 'error', '!');
      show(S.CONFIG, 'Configure a API key do TorBox para enviar NZBs direto. Baixando arquivo no iOS...');
      triggerLocalNzbFallback(xml, filename);
      return;
    }
    const rev = revision;
    const { boundary, body, cleanName } = buildNzbMultipart(xml, filename);
    nzbInFlight++;
    markNzbButton(sourceBtn, 'sending', '…');
    show(S.SENDING_NZB, `Enviando NZB limpo ao TorBox: ${cleanName}`);
    try {
      const res = await request(USENET_CREATE, `Bearer ${key}`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        data: body
      });
      checkCurrent(key, rev);
      try { checkHttp(res, 'TorBox Usenet'); }
      catch (e) {
        if (e.rateLimited) {
          await pollingName(key, rev);
          rememberApiPause(key, rev, e.wait);
        }
        throw e;
      }
      let payload;
      try { payload = JSON.parse(res.responseText); } catch { throw error('TorBox Usenet: resposta inválida.'); }
      if (payload?.success !== true) {
        const authKind = explicitAuthError(res);
        const detailMsg = String(payload?.detail || payload?.error || 'envio recusado pelo TorBox');
        throw error(`TorBox Usenet: ${detailMsg}`, authKind === 'AUTH' || authKind === 'PLAN_RESTRICTED_FEATURE');
      }
      nzbBoostUntil = Date.now() + ACTIVE_WINDOW;
      activeCount = Math.max(1, activeCount);
      markNzbButton(sourceBtn, 'sent', '✓ TorBox');
      show(S.OK, `NZB enviado ao TorBox: ${cleanName}. Acompanhando até ficar disponível no WebDAV.`);
    } catch (e) {
      markNzbButton(sourceBtn, 'error', '!');
      if (key === keyNow() && rev === revision) {
        if (e.auth) {
          blockedAuth = true;
          show(S.AUTH, `${e.message} Baixando NZB no iOS como fallback.`);
        } else {
          show(S.ATTENTION, `${e.message} Baixando NZB no iOS como fallback.`);
        }
      }
      triggerLocalNzbFallback(xml, filename);
    } finally {
      nzbInFlight = Math.max(0, nzbInFlight - 1);
      if (nzbInFlight === 0 && key === keyNow() && rev === revision) {
        schedule(wakePending || Date.now() < nzbBoostUntil ? 0 : pollDelay());
      }
    }
  }
  function interceptDmmNzbClick(event) {
    const nzbBtn = event.target?.closest?.(`button[aria-label^="${NZB_BTN_PREFIX}"]`);
    if (nzbBtn) {
      const label = String(nzbBtn.getAttribute('aria-label') || '');
      const title = label.slice(NZB_BTN_PREFIX.length);
      if (title) nzbButtonByFile.set(safeDmmNzbName(title), nzbBtn);
      lastNzbButton = nzbBtn;
      return;
    }
    const anchorEl = event.target?.closest?.('a[download][href^="blob:"]');
    if (!anchorEl || anchorEl.dataset.tbwdFallback === '1') return;
    const filename = String(anchorEl.getAttribute('download') || '').trim();
    if (!/\.nzb$/i.test(filename)) return;
    const sourceBtn = resolveNzbButton(filename);
    if (!keyNow()) syncDmmApiKey(false);
    // Se não há chave configurada, deixa o download nativo do iOS seguir direto
    // sem recriar o Blob, apenas avisando no painel.
    if (!keyNow()) {
      markNzbButton(sourceBtn, 'error', '!');
      show(S.CONFIG, 'Configure a API key do TorBox para enviar NZBs direto. Download local mantido.');
      return;
    }
    let xml;
    try {
      xml = readBlobXmlSync(anchorEl.href);
    } catch {
      // Se o navegador não permitir ler o Blob sincronicamente, mantém o download nativo.
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    void uploadNzbToTorBox(xml, filename, sourceBtn);
  }
  function explicitAuthError(res) {
    // Só códigos estruturados: texto de páginas de bloqueio não prova chave inválida.
    try {
      const body = JSON.parse(String(res.responseText || ''));
      const code = String(typeof body?.error === 'string' ? body.error
        : body?.error?.code || body?.code || '').toUpperCase();
      if (code === 'PLAN_RESTRICTED_FEATURE') return 'PLAN_RESTRICTED_FEATURE';
      return /^(?:BAD_TOKEN|INVALID_TOKEN|EXPIRED_TOKEN|INVALID_API_KEY|API_KEY_INVALID|AUTH_ERROR|AUTHENTICATION_ERROR|UNAUTHORIZED)$/.test(code) ? 'AUTH' : '';
    } catch { return ''; }
  }
  function checkHttp(res, name) {
    const authKind = res.status === 403 ? explicitAuthError(res) : '';
    if (authKind === 'PLAN_RESTRICTED_FEATURE')
      throw error(`${name}: conta no plano gratuito do TorBox (sem acesso à API).`, true);
    if (res.status === 401 || authKind === 'AUTH')
      throw error(`${name}: autenticação recusada (HTTP ${res.status}). Verifique a API key.`, true);
    if (res.status === 403)
      throw error(`${name}: acesso bloqueado (HTTP 403); a resposta não confirma uma chave inválida. Nova tentativa automática.`, false, retryDelay(res.responseHeaders));
    if (res.status === 429)
      throw Object.assign(error(`${name}: limite temporário de requisições.`, false,
        retryDelay(res.responseHeaders, 300000)), { rateLimited: true });
    if (res.status < 200 || res.status >= 300)
      throw error(`${name}: HTTP ${res.status || 'sem resposta'}.`);
  }
  function checkCurrent(key, rev) {
    if (key !== keyNow() || rev !== revision) throw error('Configuração alterada.');
  }
  function checkActive(key, rev) {
    checkCurrent(key, rev);
    if ((!visible() && !canFinishHidden()) || paused() || (pollInvalidated || (pollTicket && !ownsPolling())))
      throw Object.assign(error('Acompanhamento suspenso.'), { suspended: true });
  }

  // ----------------------------------------------------------- Listas TorBox
  async function list(kind, key, rev) {
    const all = new Map();
    for (let page = 0; page < 100; page++) {
      checkActive(key, rev);
      const wait = apiPauseRemaining(key);
      if (wait > 0) throw Object.assign(error('TorBox: aguardando o limite compartilhado da API.', false, wait), { rateLimited: true });
      const url = `${API}/${kind}/mylist?bypass_cache=true&offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}`;
      const res = await request(url, `Bearer ${key}`);
      checkCurrent(key, rev);
      try { checkHttp(res, 'TorBox'); }
      catch (e) {
        // Publica o 429 ao recebê-lo, antes de outra página ou aba iniciar consultas.
        if (e.rateLimited) rememberApiPause(key, rev, e.wait);
        throw e;
      }
      let body;
      try { body = JSON.parse(res.responseText); } catch { throw error('TorBox: resposta inválida.'); }
      if (body?.success !== true || !Array.isArray(body.data)) {
        const auth = /AUTH|INVALID_API_KEY|UNAUTHORIZED/i.test(String(body?.error || ''));
        throw error('TorBox: a API não confirmou uma lista válida.', auth);
      }
      let added = 0;
      for (const item of body.data) {
        if (item?.id === undefined || item.id === null) throw error('TorBox: item sem identificador.');
        if (!all.has(String(item.id))) added++;
        all.set(String(item.id), item);
      }
      if (body.data.length < PAGE_SIZE) return [...all.values()];
      if (!added) throw error('TorBox: paginação repetida; acompanhamento preservado.');
    }
    throw error('TorBox: lista grande demais para uma verificação completa.');
  }
  function ready(item) {
    // progress da API usa 0..1; 1 não garante processamento/finalização.
    // download_finished sozinho também não garante que os dados ainda existam.
    return item.download_finished === true && item.download_present === true
      && Array.isArray(item.files) && item.files.length > 0;
  }
  async function identity(item, kind, key, rev) {
    // Compara os campos exatos antes de ordenar/calcular SHA novamente.
    // 2.4.0: cached_at saiu do digest, pois pode mudar sem arquivo novo. A troca
    // de formato causa um único refresh extra na primeira verificação.
    const files = item.files.map(f => [String(f.id), f.size, f.name]);
    const values = [String(item.id), item.hash || '', item.created_at || '', files];
    const source = JSON.stringify(values);
    const cache = identityCache[kind];
    const previous = cache.get(String(item.id));
    if (previous?.source === source) return previous.digest;
    files.sort((a, b) => a[0].localeCompare(b[0]));
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(values)));
    checkCurrent(key, rev);
    const digest = toHex(bytes);
    if (previous) { cacheBytes[kind] -= previous.source.length * 2; cache.delete(String(item.id)); }
    if (source.length * 2 <= CACHE_LIMIT) {
      while (cache.size && (cacheBytes[kind] + source.length * 2 > CACHE_LIMIT || cache.size >= 2048)) {
        const first = cache.keys().next().value;
        cacheBytes[kind] -= cache.get(first).source.length * 2; cache.delete(first);
      }
      cache.set(String(item.id), { source, digest }); cacheBytes[kind] += source.length * 2;
    }
    return digest;
  }
  function summarizePending(items, kind) {
    const result = emptyPending();
    const liveIds = new Set(items.map(item => String(item.id)));
    for (const [id, value] of identityCache[kind]) {
      if (!liveIds.has(id)) { cacheBytes[kind] -= value.source.length * 2; identityCache[kind].delete(id); }
    }
    const pendingIds = new Set();
    for (const item of items) {
      const state = String(item.download_state || '').toLowerCase();
      if (ready(item) || /error|failed|cancel|expired|missingfiles/.test(state)) continue;
      result.downloads++;
      const count = Array.isArray(item.files) ? item.files.length : 0;
      result.files += count;
      if (!count) result.unknown++;
      const id = String(item.id); pendingIds.add(id);
      const signature = JSON.stringify([state, item.progress, item.downloaded, item.download_present, count]);
      let activity = activityCache[kind].get(id);
      if (!activity || activity.signature !== signature) {
        activity = { signature, changedAt: Date.now() }; activityCache[kind].set(id, activity);
      }
      // Pausados, sem sementes e filas ficam no ritmo normal. Estados ativos
      // sem evolução também desaceleram após um minuto; retomam se houver progresso.
      const stopped = /paused|stalled|queued|stopped|inactive/.test(state);
      const working = /downloading|metadl|checking|processing|repair|unpack|extract|verif|moving/.test(state);
      const finalizing = item.download_finished === true && item.download_present === true;
      if (!stopped && (working || finalizing) && Date.now() - activity.changedAt < ACTIVE_WINDOW) result.active++;
    }
    for (const id of activityCache[kind].keys()) if (!pendingIds.has(id)) activityCache[kind].delete(id);
    return result;
  }
  function updatePending(current, fileCounts) {
    pendingCount = 0; pendingDownloads = 0; unknownCount = 0; activeCount = 0;
    for (const kind of KINDS) {
      const stats = pendingByKind[kind];
      pendingCount += stats.files; pendingDownloads += stats.downloads; unknownCount += stats.unknown;
      if (Date.now() >= listRetry[kind]) activeCount += stats.active;
    }
    const saved = stateNow();
    for (const kind of Object.keys(current)) {
      const previous = new Set(saved.ready[kind]);
      for (const id of current[kind]) if (!previous.has(id)) {
        pendingCount += fileCounts[kind]?.get(id) || 0; pendingDownloads++;
      }
    }
  }
  function pendingDetail() {
    if (!pendingDownloads) return '';
    return ` ${pendingCount} arquivo(s) conhecido(s) em ${pendingDownloads} download(s) aguardando disponibilidade ou refresh.` +
      (unknownCount ? ` ${unknownCount} download(s) ainda sem lista de arquivos; ? indica total desconhecido e + indica contagem mínima.` : '');
  }

  // ------------------------------------------------------------------ WebDAV
  function validWebDAV(res) {
    const text = String(res.responseText || '').trim();
    const type = String(res.responseHeaders || '');
    if (/^content-type:\s*application\/(?:[\w.+-]+\+)?json\b/im.test(type) || /^[{[]/.test(text)) {
      let body;
      try { body = JSON.parse(text); } catch { throw error('WebDAV: JSON inválido.'); }
      if (body?.success === true && !body.error) return;
      throw error('WebDAV: resposta sem confirmação de sucesso.');
    }
    // Reconhece a estrutura do Explorer vista no Safari, não palavras em nomes de arquivos.
    const explorer = /<html\b/i.test(text) && /<a\b[^>]*\bhref\s*=/i.test(text)
      && /Welcome\s*,/i.test(text) && /Sort by Name/i.test(text) && /Sort by Size/i.test(text);
    const passwordForm = /<input\b[^>]*\btype\s*=\s*(?:["']password["']|password(?=\s|>))/i.test(text);
    if (explorer && !passwordForm) return;
    throw error('WebDAV: resposta não reconhecida; sincronização não confirmada.');
  }
  async function refresh(key, rev) {
    checkActive(key, rev);
    const res = await request(DAV, `Basic ${btoa(`torbox:${key}`)}`);
    checkCurrent(key, rev);
    checkHttp(res, 'WebDAV');
    if (res.finalUrl) {
      const final = new URL(res.finalUrl);
      if (final.origin !== 'https://webdav.torbox.app' ||
          !['/', '/refresh', '/refresh/'].includes(final.pathname))
        throw error('WebDAV: resposta redirecionada; refresh não confirmado.');
    }
    validWebDAV(res);
  }
  function hasNew(current, saved) {
    return Object.keys(current).some(kind => {
      const previous = new Set(saved.ready[kind]);
      return current[kind].some(id => !previous.has(id));
    });
  }
  function saveCurrent(current, lastRefresh, merge = false) {
    const saved = stateNow();
    const ready = { ...saved.ready };
    for (const kind of Object.keys(current)) {
      // merge: só acrescenta (refresh manual com listagem possivelmente antiga).
      ready[kind] = merge ? [...new Set([...saved.ready[kind], ...current[kind]])].sort() : current[kind];
    }
    const next = { version: 2, ready, lastRefresh: lastRefresh ?? saved.lastRefresh };
    const serialized = JSON.stringify(next);
    if (serialized.length > STATE_LIMIT) throw error('Biblioteca excede o limite de estado.');
    if (serialized !== JSON.stringify(saved)) GM_setValue(STATE, next);
  }
  function foreignLock() {
    const held = read(LOCK, null);
    return held?.owner !== OWNER && Number.isFinite(held?.until) && held.until > Date.now()
      && held.until <= Date.now() + 60000;
  }
  async function performRefresh(key, rev, current, force) {
    if (foreignLock()) {
      show(S.OTHER_TAB, 'Outra aba está atualizando o WebDAV.');
      return 'waiting';
    }
    // Coordenação cooperativa: GM não oferece uma operação atômica entre domínios.
    // A espera aleatória reduz a chance de duas abas gravarem a trava juntas.
    await jitter();
    checkActive(key, rev);
    if (foreignLock()) {
      show(S.OTHER_TAB, 'Outra aba está atualizando o WebDAV.');
      return 'waiting';
    }
    GM_setValue(LOCK, { owner: OWNER, until: Date.now() + 45000 });
    try {
      await sleep(350);
      checkActive(key, rev);
      const claim = read(LOCK, null);
      if (claim?.owner !== OWNER || claim.until <= Date.now()) return 'waiting';
      let saved = stateNow();
      if (!force && !hasNew(current, saved)) {
        saveCurrent(current);
        return 'unchanged';
      }
      if (Date.now() - saved.lastRefresh < COOLDOWN) {
        show(S.WAITING, 'Aguardando o intervalo de 10 segundos entre refreshes.');
        const remaining = COOLDOWN - (Date.now() - saved.lastRefresh);
        // Uma espera local permite concluir o lote pronto sem consultar a API de novo.
        if (!visible() && canFinishHidden() && remaining < finishUntil - Date.now()) {
          await sleep(remaining);
          checkActive(key, rev);
          if (read(LOCK, null)?.owner !== OWNER) return 'waiting';
          saved = stateNow();
          if (Date.now() - saved.lastRefresh < COOLDOWN) return 'waiting';
        } else return 'waiting';
      }
      checkActive(key, rev);
      show(S.UPDATING, 'Solicitando a atualização do WebDAV.');
      // Congela o conjunto ANTES da requisição: uma listagem que terminar
      // durante o refresh não pode ser marcada como já sincronizada.
      const confirmed = { ...current };
      await refresh(key, rev);
      checkActive(key, rev);
      if (read(LOCK, null)?.owner !== OWNER) return 'waiting';
      // No refresh manual, mescla: não descarta itens que outra aba confirmou depois.
      saveCurrent(confirmed, Date.now(), force);
      return 'updated';
    } finally {
      if (read(LOCK, null)?.owner === OWNER) GM_deleteValue(LOCK);
    }
  }

  // ------------------------------------------------- Coordenação entre abas
  async function pollingName(key, rev) {
    if (scopeKey === key && scopeName) return scopeName;
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    checkCurrent(key, rev);
    scopeKey = key;
    scopeName = `tb_webdav_poll_v1_${toHex(bytes)}`;
    return scopeName;
  }
  function apiPauseRemaining(key = keyNow()) {
    if (key !== scopeKey || !scopeName) return 0;
    const until = read(`${scopeName}_api_retry_at`, 0);
    return Number.isFinite(until) ? Math.max(0, until - Date.now()) : 0;
  }
  function rememberApiPause(key, rev, wait) {
    checkCurrent(key, rev);
    if (key !== scopeKey || !scopeName) return;
    const name = `${scopeName}_api_retry_at`;
    const previous = read(name, 0);
    const until = Date.now() + Math.max(1000, wait);
    // Mantém a maior espera conhecida. Nenhuma chave vai para o nome do registro.
    GM_setValue(name, Math.max(Number.isFinite(previous) ? previous : 0, until));
  }
  function ownsPolling(ticket = pollTicket) {
    if (!ticket) return false;
    const lease = read(ticket.name, null);
    return lease?.owner === ticket.token && lease.until > Date.now();
  }
  function readPollReport(name, includeStatus = true) {
    const report = read(`${name}_report`, null);
    if (!report || !Number.isFinite(report.at) || report.at > Date.now() ||
        Date.now() - report.at > 600000) return;
    // Preserva backoff e contagem quando outra aba assume as consultas.
    for (const kind of KINDS) {
      const wait = report.listRetry?.[kind];
      if (Number.isFinite(wait)) listRetry[kind] = wait;
      const count = report.listFailures?.[kind];
      if (Number.isInteger(count) && count >= 0) listFailures[kind] = count;
      const stats = report.pendingByKind?.[kind];
      if (stats && ['files','downloads','unknown','active'].every(k => Number.isFinite(stats[k]) && stats[k] >= 0))
        pendingByKind[kind] = { ...stats };
    }
    if (!includeStatus || (report.at < lastUiAt && status !== S.CHECKING)) return;
    if (!['pendingCount','pendingDownloads','unknownCount','activeCount','successUntil'].every(k => Number.isFinite(report[k]) && report[k] >= 0)) return;
    if (typeof report.status !== 'string' || typeof report.detail !== 'string') return;
    pendingCount = report.pendingCount; pendingDownloads = report.pendingDownloads;
    unknownCount = report.unknownCount; activeCount = report.activeCount;
    status = report.status; detail = report.detail; successUntil = report.successUntil;
    lastUiAt = report.at;
    clearTimeout(successTimer);
    if (successUntil > Date.now()) successTimer = setTimeout(renderControl, successUntil - Date.now());
    renderControl();
  }
  function heldLease(name) {
    const held = read(name, null);
    const now = Date.now();
    return !!held && (
      (Number.isFinite(held.until) && held.until > now && held.until <= now + POLL_LEASE_MS + 5000) ||
      (Number.isFinite(held.nextAt) && held.nextAt > now && held.nextAt <= now + 86400000));
  }
  async function acquirePolling(key, rev) {
    const name = await pollingName(key, rev);
    checkActive(key, rev);
    readPollReport(name);
    if (heldLease(name)) return false;
    // Mesma espera aleatória da trava do refresh: reduz disputas simultâneas.
    await jitter();
    checkActive(key, rev);
    if (heldLease(name)) return false;
    const ticket = { name, token: crypto.randomUUID(), rev };
    GM_setValue(name, { owner: ticket.token, until: Date.now() + POLL_LEASE_MS, nextAt: 0 });
    try {
      await sleep(350);
      checkActive(key, rev);
    } catch (e) {
      if (ownsPolling(ticket)) GM_setValue(name, { owner: ticket.token, until: 0, nextAt: 0 });
      throw e;
    }
    if (!ownsPolling(ticket)) return false;
    pollTicket = ticket;
    const renew = () => {
      if (pollTicket !== ticket || !ownsPolling(ticket)) return;
      if ((!visible() && !canFinishHidden()) || paused() || revision !== rev || key !== keyNow()) {
        releasePolling(0, false); return;
      }
      GM_setValue(name, { owner: ticket.token, until: Date.now() + POLL_LEASE_MS, nextAt: 0 });
      pollHeartbeat = setTimeout(renew, 10000);
    };
    pollHeartbeat = setTimeout(renew, 10000);
    return true;
  }
  function releasePolling(delay, publish) {
    const ticket = pollTicket;
    clearTimeout(pollHeartbeat); pollHeartbeat = null;
    if (!ticket) return;
    if (running) pollInvalidated = true;
    const owned = ownsPolling(ticket);
    pollTicket = null;
    if (!owned) return;
    if (publish && revision === ticket.rev) {
      GM_setValue(`${ticket.name}_report`, {
        at: Date.now(), status, detail, pendingCount, pendingDownloads,
        unknownCount, activeCount, successUntil,
        pendingByKind, listRetry, listFailures
      });
    }
    GM_setValue(ticket.name, {
      owner: ticket.token, until: 0, nextAt: Date.now() + Math.max(0, delay)
    });
  }

  // ----------------------------------------------------------- Ciclo principal
  async function runManual(key, rev) {
    // O pedido manual não depende da disponibilidade das APIs de listagem.
    finishEligible = true;
    const requestVersion = manualVersion;
    // Itens prontos na última listagem desta aba: o refresh também os cobre.
    const snapshot = { ...lastReady };
    const counts = { ...lastCounts };
    const result = await performRefresh(key, rev, snapshot, true);
    if (result !== 'updated') return 2000;
    manualPending = manualVersion !== requestVersion;
    wakePending = true;
    failures = 0; retryAt = 0;
    updatePending(snapshot, counts);
    show(pendingDownloads ? S.PENDING : S.OK,
      'Resposta válida recebida do WebDAV. Atualize a biblioteca no Infuse.' + pendingDetail());
    return POLL;
  }
  async function fetchKind(kind, key, rev) {
    try {
      checkActive(key, rev);
      if (Date.now() < listRetry[kind]) return { skipped: true };
      const items = await list(kind, key, rev);
      const available = items.filter(ready);
      const ids = await Promise.all(available.map(item => identity(item, kind, key, rev)));
      checkActive(key, rev);
      return { items, ids: [...ids].sort(), counts: new Map(ids.map((id, i) => [id, available[i].files.length])) };
    } catch (e) { return { error: e }; }
  }
  function absorbKind(ctx, kind, result, key, rev) {
    checkActive(key, rev);
    ctx.completed.add(kind);
    if (result.error) {
      const e = result.error;
      if (e.suspended || e.auth) throw e;
      listFailures[kind]++;
      listRetry[kind] = Date.now() + Math.max(e.wait || 0,
        Math.min(300000, POLL * 2 ** Math.min(listFailures[kind], 5)));
      ctx.unavailable.add(kind);
    } else if (result.skipped) ctx.unavailable.add(kind);
    else {
      ctx.current[kind] = result.ids; ctx.fileCounts[kind] = result.counts;
      lastReady[kind] = result.ids; lastCounts[kind] = result.counts;
      pendingByKind[kind] = summarizePending(result.items, kind);
      listFailures[kind] = 0; listRetry[kind] = 0;
    }
  }
  async function reconcile(ctx, key, rev) {
    checkActive(key, rev);
    updatePending(ctx.current, ctx.fileCounts);
    if (JSON.stringify(ctx.current).length > STATE_LIMIT) throw error('Biblioteca excede o limite de estado.');
    if (hasNew(ctx.current, stateNow())) {
      const outcome = await performRefresh(key, rev, ctx.current, false);
      if (outcome === 'waiting') { ctx.delay = 2000; return; }
      if (outcome === 'updated') ctx.updated = true;
      updatePending(ctx.current, ctx.fileCounts);
    } else if (Object.keys(ctx.current).length) saveCurrent(ctx.current);
    const partial = ctx.unavailable.size > 0;
    const partialDetail = partial
      ? ` Consulta temporariamente indisponível: ${[...ctx.unavailable].join(', ')}. Novas tentativas serão automáticas.` : '';
    // Só declara sucesso total depois que ambas as consultas terminam.
    const inFlight = ctx.completed.size < KINDS.length;
    if (nzbInFlight > 0 && !ctx.updated) return;
    const label = !Object.keys(ctx.current).length && !inFlight ? S.API_DOWN
      : partial ? S.PARTIAL : inFlight ? S.CHECKING
      : pendingDownloads ? S.PENDING : ctx.updated ? S.OK : S.MONITORING;
    show(label, (ctx.updated ? 'Resposta válida recebida do WebDAV. Atualize a biblioteca no Infuse.'
      : inFlight ? 'Consultando as listas do TorBox.' : 'Monitoramento ativo enquanto esta aba estiver visível.')
      + pendingDetail() + partialDetail);
  }
  async function pollLists(key, rev) {
    const ctx = { current: {}, fileCounts: {}, completed: new Set(), unavailable: new Set(),
      updated: false, delay: POLL, fatal: null, reconciliation: Promise.resolve() };
    // No máximo duas listagens simultâneas. Cada resultado é reconciliado
    // ao chegar: um endpoint lento não retém o refresh do endpoint saudável.
    await Promise.all(KINDS.map(async kind => {
      const result = await fetchKind(kind, key, rev);
      if (ctx.fatal) return;
      try { absorbKind(ctx, kind, result, key, rev); }
      catch (e) { ctx.fatal = e; return; }
      // Respostas que chegarem antes do envio do refresh são agrupadas;
      // os refreshes continuam estritamente em série.
      ctx.reconciliation = ctx.reconciliation.then(async () => {
        if (ctx.fatal) return;
        try { await reconcile(ctx, key, rev); } catch (e) { ctx.fatal = e; }
      });
      await ctx.reconciliation;
    }));
    if (ctx.fatal) throw ctx.fatal;
    return ctx.delay;
  }
  function cycleFailure(e, key, rev) {
    if (key !== keyNow() || rev !== revision || e.suspended) return undefined;
    if (e.auth) {
      blockedAuth = true;
      show(S.AUTH, e.message);
      return undefined;
    }
    failures++;
    const delay = Math.max(e.wait || 0, Math.min(300000, POLL * 2 ** Math.min(failures, 5)));
    retryAt = Date.now() + delay;
    show(S.RETRY, `${e.message} Nova tentativa após ${Math.ceil(delay / 1000)} s.`);
    return delay;
  }
  async function cycle() {
    if (running || nzbInFlight > 0) return;
    const key = keyNow();
    if (!key || paused() || blockedAuth || !visible()) return;
    if (Date.now() < retryAt) { schedule(0); return; }
    running = true;
    finishEligible = false; finishUntil = 0;
    const rev = revision;
    let delay = POLL;
    try {
      if (manualPending) { delay = await runManual(key, rev); return; }
      await pollingName(key, rev);
      checkActive(key, rev);
      const apiWait = apiPauseRemaining(key);
      if (apiWait > 0) {
        delay = apiWait;
        show(S.WAITING, `Limite temporário da API do TorBox. Nova consulta após ${Math.ceil(apiWait / 1000)} s.`);
        return;
      }
      if (!await acquirePolling(key, rev)) { delay = ACTIVE_POLL; return; }
      finishEligible = true;
      delay = await pollLists(key, rev);
      failures = 0; retryAt = 0;
    } catch (e) {
      const wait = cycleFailure(e, key, rev);
      if (wait !== undefined) delay = wait;
    } finally {
      running = false;
      finishEligible = false; finishUntil = 0;
      const immediate = wakePending || rev !== revision;
      wakePending = false;
      const nextDelay = immediate ? 0 : Math.min(delay, pollDelay());
      releasePolling(!visible() || paused() || rev !== revision ? 0
        : Math.max(nextDelay, retryAt - Date.now()), !paused() && rev === revision);
      pollInvalidated = false;
      schedule(nextDelay);
    }
  }

  // ------------------------------------------------------------- Inicialização
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('TorBox: diagnóstico', showDiagnostics);
    GM_registerMenuCommand('TorBox: definir API key', configure);
    GM_registerMenuCommand('TorBox: verificar e atualizar WebDAV', requestManual);
    GM_registerMenuCommand('TorBox: pausar/retomar', togglePause);
    GM_registerMenuCommand('TorBox: apagar chave armazenada', forget);
  }
  if (typeof GM_addValueChangeListener === 'function') {
    for (const name of [KEY, PAUSE])
      GM_addValueChangeListener(name, (_name, _old, _new, remote) => { if (remote) changedSettings(); });
    // O wBlock mantém o snapshot GM sincronizado entre as abas do userscript.
    GM_addValueChangeListener(STATE, (_name, _old, _new, remote) => { if (remote) schedule(); });
  }
  if (IS_DMM) {
    syncDmmApiKey(false);
    document.addEventListener('click', interceptDmmNzbClick, true);
    window.addEventListener('storage', event => {
      if (!event?.key || event.key === DMM_KEY) syncDmmApiKey(true);
    });
    window.addEventListener('local-storage', () => syncDmmApiKey(true));
  }
  document.addEventListener('visibilitychange', () => {
    if (visible()) { renderControl(); schedule(0); }
    else {
      clearTimeout(timer);
      // Não abre um ciclo. Apenas autoriza a conclusão daquele que já consultava.
      if (running && finishEligible && !pollInvalidated) {
        if (!finishUntil) finishUntil = Date.now() + FINISH_WINDOW;
      } else releasePolling(0, false);
    }
  });
  window.addEventListener('pageshow', () => { renderControl(); schedule(0); });
  window.addEventListener('online', () => schedule(0));
  window.addEventListener('pagehide', () => {
    clearTimeout(timer); finishEligible = false; finishUntil = 0;
    releasePolling(0, false);
  });
  mount();
  if (!document.body) document.addEventListener('DOMContentLoaded', mount, { once: true });
  if (paused()) show(S.PAUSED, 'Toque para retomar o acompanhamento.');
  else if (keyNow()) { show(S.CHECKING, 'Consultando as listas do TorBox.'); schedule(0); }
})();
