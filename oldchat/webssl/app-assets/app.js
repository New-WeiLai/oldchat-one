/* global crypto, fetch */
(function () {
  const WEBAPP_VERSION = '20260228-parsefix3';
  const BURN_ALLOWED = { 5: true, 10: true, 20: true, 30: true, 60: true, 300: true };

  const state = {
    accessToken: '',
    refreshToken: '',
    user: null,
    friends: [],
    groups: [],
    friendMap: {},
    groupMap: {},
    groupMemberMap: {},
    view: 'chats',
    active: null,
    messages: [],
    unread: { direct: {}, group: {} },
    ws: null,
    wsConnected: false,
    sessionId: '',
    encKey: null,
    macKey: null,
    refreshInFlight: false,
    pollTimer: null,
    quoteDraft: null,
    burnConsumed: {},
    redPacketDone: {},
    burnModalTimer: null,
  };

  let renderListScheduled = false;

  const els = {
    app: document.getElementById('app'),
    statusPill: document.getElementById('statusPill'),
    userPill: document.getElementById('userPill'),
    btnLogout: document.getElementById('btnLogout'),
    tabs: document.querySelectorAll('.tab'),
    searchInput: document.getElementById('searchInput'),
    listView: document.getElementById('listView'),
    conversationTitle: document.getElementById('conversationTitle'),
    conversationMeta: document.getElementById('conversationMeta'),
    messageList: document.getElementById('messageList'),
    messageInput: document.getElementById('messageInput'),
    composer: document.getElementById('composer'),
    emptyState: document.getElementById('emptyState'),
    loginView: document.getElementById('loginView'),
    loginForm: document.getElementById('loginForm'),
    loginIdentifier: document.getElementById('loginIdentifier'),
    loginPassword: document.getElementById('loginPassword'),
    btnBackList: document.getElementById('btnBackList'),
    toast: document.getElementById('toast'),
    burnSeconds: document.getElementById('burnSeconds'),
    composerQuote: document.getElementById('composerQuote'),
    composerQuoteText: document.getElementById('composerQuoteText'),
    btnClearQuote: document.getElementById('btnClearQuote'),
    burnModal: document.getElementById('burnModal'),
    burnModalContent: document.getElementById('burnModalContent'),
    burnModalCountdown: document.getElementById('burnModalCountdown'),
    btnBurnClose: document.getElementById('btnBurnClose'),
  };

  const LS_ACCESS = 'oldchat_access_token';
  const LS_REFRESH = 'oldchat_refresh_token';
  const LS_USER = 'oldchat_user';
  const LS_DEVICE = 'oldchat_device_id';
  const LS_BURN_CONSUMED = 'oldchat_burn_consumed';
  const LS_RED_PACKET_DONE = 'oldchat_red_packet_done';

  function showToast(message) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.classList.add('show');
    setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  function loadJSONMap(key) {
    const raw = localStorage.getItem(key) || '';
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return {};
      return parsed;
    } catch (err) {
      return {};
    }
  }

  function saveJSONMap(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value || {}));
    } catch (err) {
      // ignore
    }
  }

  function getDeviceId() {
    let id = localStorage.getItem(LS_DEVICE);
    if (id) return id;
    if (crypto && typeof crypto.randomUUID === 'function') {
      id = crypto.randomUUID();
    } else {
      id = `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    }
    localStorage.setItem(LS_DEVICE, id);
    return id;
  }

  function normalizeBurnSeconds(seconds) {
    const n = Number(seconds) || 0;
    return BURN_ALLOWED[n] ? n : 0;
  }

  function isBurnEnabled(seconds) {
    return normalizeBurnSeconds(seconds) > 0;
  }

  function isBurnLockedMessage(msg) {
    if (!msg) return false;
    const type = (msg.msg_type || 'text').toLowerCase();
    return type !== 'recall' && isBurnEnabled(msg.burn_after_seconds);
  }

  function isBurnConsumed(messageId) {
    return !!(messageId && state.burnConsumed[messageId]);
  }

  function markBurnConsumed(messageId) {
    if (!messageId || state.burnConsumed[messageId]) return;
    state.burnConsumed[messageId] = 1;
    saveJSONMap(LS_BURN_CONSUMED, state.burnConsumed);
  }

  function markRedPacketDone(packetId) {
    const key = (packetId || '').trim().toUpperCase();
    if (!key || state.redPacketDone[key]) return;
    state.redPacketDone[key] = 1;
    saveJSONMap(LS_RED_PACKET_DONE, state.redPacketDone);
  }

  function isRedPacketDone(packetId) {
    const key = (packetId || '').trim().toUpperCase();
    if (!key) return false;
    return !!state.redPacketDone[key];
  }

  function setStatus(online) {
    state.wsConnected = online;
    if (online) {
      els.statusPill.textContent = '在线';
      els.statusPill.classList.add('online');
    } else {
      els.statusPill.textContent = '离线';
      els.statusPill.classList.remove('online');
    }
    if (state.accessToken) {
      startPolling();
    }
  }

  function showLogin(show) {
    if (show) {
      els.loginView.classList.add('show');
    } else {
      els.loginView.classList.remove('show');
    }
  }

  function setUser(user) {
    state.user = user;
    if (user) {
      const name = user.display_name || user.username || user.uid || '已登录';
      els.userPill.textContent = name;
    } else {
      els.userPill.textContent = '未登录';
    }
  }

  function setView(view) {
    state.view = view;
    els.app.dataset.view = view;
    els.tabs.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    scheduleRenderList();
  }

  function setPanel(panel) {
    els.app.dataset.panel = panel;
  }

  function setQuoteDraft(draft) {
    state.quoteDraft = draft || null;
    if (!state.quoteDraft) {
      els.composerQuote.classList.remove('show');
      els.composerQuoteText.textContent = '';
      return;
    }
    const sender = state.quoteDraft.from_name || state.quoteDraft.from_uid || '对方';
    const content = quotePreviewText(
      state.quoteDraft.type,
      state.quoteDraft.media_kind,
      state.quoteDraft.text
    );
    els.composerQuoteText.textContent = `引用 ${sender}: ${content}`;
    els.composerQuote.classList.add('show');
  }

  function clearQuoteDraft() {
    setQuoteDraft(null);
  }

  function saveAuth() {
    localStorage.setItem(LS_ACCESS, state.accessToken || '');
    localStorage.setItem(LS_REFRESH, state.refreshToken || '');
    localStorage.setItem(LS_USER, state.user ? JSON.stringify(state.user) : '');
  }

  function loadAuth() {
    state.accessToken = localStorage.getItem(LS_ACCESS) || '';
    state.refreshToken = localStorage.getItem(LS_REFRESH) || '';
    const rawUser = localStorage.getItem(LS_USER);
    if (rawUser) {
      try {
        state.user = JSON.parse(rawUser);
      } catch (err) {
        state.user = null;
      }
    }
    state.burnConsumed = loadJSONMap(LS_BURN_CONSUMED);
    state.redPacketDone = loadJSONMap(LS_RED_PACKET_DONE);
  }

  async function apiRequest(path, options) {
    const opts = options || {};
    const headers = opts.headers || {};
    const needsAuth = opts.auth !== false;
    if (needsAuth && state.accessToken) {
      headers.Authorization = `Bearer ${state.accessToken}`;
    }
    if (opts.body && !(opts.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
    });

    if (response.status === 401 && needsAuth && state.refreshToken) {
      const refreshed = await refreshToken();
      if (refreshed) {
        return apiRequest(path, options);
      }
    }

    const text = await response.text();
    if (!text) {
      return { ok: response.ok, data: null };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      data = text;
    }
    if (!response.ok) {
      throw { status: response.status, data };
    }
    return { ok: true, data };
  }

  async function refreshToken() {
    if (state.refreshInFlight) return false;
    state.refreshInFlight = true;
    try {
      const resp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/auth/refresh', {
        method: 'POST',
        body: { refresh_token: state.refreshToken },
        auth: false,
      });
      if (resp && resp.data && resp.data.access_token) {
        state.accessToken = resp.data.access_token;
        if (resp.data.refresh_token) {
          state.refreshToken = resp.data.refresh_token;
        }
        saveAuth();
        return true;
      }
      return false;
    } catch (err) {
      return false;
    } finally {
      state.refreshInFlight = false;
    }
  }

  async function login(identifier, password) {
    const body = {
      identifier,
      password,
      device_id: getDeviceId(),
      device_name: navigator.userAgent.slice(0, 120),
      platform: 'web',
      app_version: 'web',
    };
    const resp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/auth/login', { method: 'POST', body, auth: false });
    state.accessToken = resp.data.access_token;
    state.refreshToken = resp.data.refresh_token;
    state.user = resp.data.user;
    saveAuth();
    setUser(state.user);
  }

  async function logout() {
    state.accessToken = '';
    state.refreshToken = '';
    state.user = null;
    state.active = null;
    state.messages = [];
    state.quoteDraft = null;
    saveAuth();
    disconnectWS();
    stopPolling();
    closeBurnModal();
    setUser(null);
    showLogin(true);
  }

  async function boot() {
    showLogin(false);
    setUser(state.user);
    setStatus(false);
    renderConversationHeader();
    try {
      await Promise.all([loadFriends(), loadGroups()]);
      scheduleRenderList();
      await connectWS();
      startPolling();
    } catch (err) {
      showToast('登录已过期，请重新登录');
      await logout();
    }
  }

  function displayNameForUID(uid) {
    if (!uid) return '';
    const upper = String(uid).toUpperCase();
    const friend = state.friendMap[upper] || state.friendMap[uid];
    if (friend && friend.name) return friend.name;
    return upper;
  }

  async function loadFriends() {
    try {
      const resp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/friends');
      const friends = resp.data.friends || [];
      state.friends = friends.map((f) => ({
        uid: (f.uid || f.id || '').toUpperCase(),
        name: f.display_name || f.username || f.uid || f.id,
        avatar: f.avatar_url || '',
      })).filter((f) => f.uid);
      state.friendMap = {};
      state.friends.forEach((f) => {
        state.friendMap[f.uid] = f;
      });
    } catch (err) {
      showToast('好友列表加载失败');
    }
  }

  async function loadGroups() {
    try {
      const resp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/groups/list');
      const groups = resp.data.groups || [];
      state.groups = groups.map((g) => ({
        id: (g.group_id || g.id || '').toUpperCase(),
        name: g.name || g.group_id,
        avatar: g.avatar_url || '',
      })).filter((g) => g.id);
      state.groupMap = {};
      state.groups.forEach((g) => {
        state.groupMap[g.id] = g;
      });
    } catch (err) {
      showToast('群组列表加载失败');
    }
  }

  async function loadGroupMembers(groupId) {
    if (!groupId) return;
    try {
      const resp = await apiRequest(`https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/groups/members?group_id=${encodeURIComponent(groupId)}`);
      const members = resp.data.members || [];
      const map = {};
      members.forEach((m) => {
        const uid = (m.uid || '').toUpperCase();
        if (!uid) return;
        const name = m.display_name || m.username || uid;
        map[uid] = name;
      });
      state.groupMemberMap[groupId] = map;
    } catch (err) {
      // group mention lookup is best-effort
    }
  }

  function renderList() {
    const filter = (els.searchInput.value || '').trim().toLowerCase();
    let items = [];
    if (state.view === 'groups') {
      items = state.groups.map((g) => ({
        id: g.id,
        title: g.name,
        subtitle: `群号 ${g.id}`,
        type: 'group',
        unread: state.unread.group[g.id] || 0,
      }));
    } else {
      items = state.friends.map((f) => ({
        id: f.uid,
        title: f.name,
        subtitle: f.uid,
        type: 'direct',
        unread: state.unread.direct[f.uid] || 0,
      }));
    }

    const filtered = items.filter((i) => {
      return !filter || i.title.toLowerCase().includes(filter) || (i.subtitle || '').toLowerCase().includes(filter);
    });

    els.listView.innerHTML = '';
    if (!filtered.length) {
      els.listView.innerHTML = '<div class="item-subtitle">暂无数据</div>';
      return;
    }

    const fragment = document.createDocumentFragment();
    filtered.forEach((item) => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.dataset.id = item.id;
      row.dataset.type = item.type;
      if (state.active && state.active.type === item.type && state.active.id === item.id) {
        row.classList.add('active');
      }

      const textWrap = document.createElement('div');
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = item.title;
      const subtitle = document.createElement('div');
      subtitle.className = 'item-subtitle';
      subtitle.textContent = item.subtitle;
      textWrap.appendChild(title);
      textWrap.appendChild(subtitle);
      row.appendChild(textWrap);

      if (item.unread) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = item.unread > 99 ? '99+' : item.unread;
        row.appendChild(badge);
      }

      row.addEventListener('click', () => {
        openConversation(item.type, item.id);
      });
      fragment.appendChild(row);
    });
    els.listView.appendChild(fragment);
  }

  function scheduleRenderList() {
    if (renderListScheduled) return;
    renderListScheduled = true;
    requestAnimationFrame(() => {
      renderListScheduled = false;
      renderList();
    });
  }

  function renderConversationHeader() {
    if (!state.active) {
      els.conversationTitle.textContent = '旧聊 Web';
      els.conversationMeta.textContent = '选择一个会话开始聊天';
      els.emptyState.style.display = 'block';
      els.composer.style.display = 'none';
      return;
    }
    const info = state.active.type === 'group'
      ? state.groupMap[state.active.id]
      : state.friendMap[state.active.id];
    els.conversationTitle.textContent = info ? (info.name || info.title || state.active.id) : state.active.id;
    els.conversationMeta.textContent = state.active.type === 'group' ? `群号 ${state.active.id}` : state.active.id;
    els.emptyState.style.display = 'none';
    els.composer.style.display = 'flex';
  }

  function tryParsePayloadObject(rawBody) {
    if (rawBody == null) return null;
    if (typeof rawBody === 'object') {
      return rawBody;
    }

    let current = String(rawBody).trim();
    if (!current) return null;

    for (let i = 0; i < 3; i++) {
      if (!current) return null;
      if (current[0] === '{' && current[current.length - 1] === '}') {
        try {
          return JSON.parse(current);
        } catch (err) {
          break;
        }
      }
      if (current[0] === '\"' && current[current.length - 1] === '\"') {
        try {
          const decoded = JSON.parse(current);
          if (decoded && typeof decoded === 'object') {
            return decoded;
          }
          if (typeof decoded === 'string') {
            current = decoded.trim();
            continue;
          }
          return null;
        } catch (err) {
          return null;
        }
      }
      break;
    }

    // Tolerate prefixed wrappers like ':{...}' or 'json={...}'.
    const firstBrace = current.indexOf('{');
    const lastBrace = current.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = current.slice(firstBrace, lastBrace + 1).trim();
      if (candidate[0] === '{' && candidate[candidate.length - 1] === '}') {
        try {
          return JSON.parse(candidate);
        } catch (err) {
          return null;
        }
      }
    }
    return null;
  }

  function parseMessagePayload(body) {
    const out = {
      v: 0,
      text: body == null ? '' : String(body),
      mediaKind: '',
      voiceText: '',
      quote: null,
      mentions: [],
      forward: null,
    };
    if (body == null) return out;
    const obj = tryParsePayloadObject(body);
    if (!obj || typeof obj !== 'object') return out;
    try {
      const hasPayloadShape = Object.prototype.hasOwnProperty.call(obj, 'v')
        || Object.prototype.hasOwnProperty.call(obj, 'quote')
        || Object.prototype.hasOwnProperty.call(obj, 'mentions')
        || Object.prototype.hasOwnProperty.call(obj, 'media_kind')
        || Object.prototype.hasOwnProperty.call(obj, 'voice_text')
        || Object.prototype.hasOwnProperty.call(obj, 'forward_v2');
      if (!hasPayloadShape) return out;

      out.v = Number(obj.v || 0);
      out.text = String(obj.text || obj.title || out.text || '');
      out.mediaKind = String(obj.media_kind || '');
      out.voiceText = String(obj.voice_text || '');
      if (obj.quote && typeof obj.quote === 'object') {
        out.quote = {
          id: String(obj.quote.id || ''),
          from_uid: String(obj.quote.from_uid || ''),
          from_name: String(obj.quote.from_name || ''),
          type: String(obj.quote.type || ''),
          text: String(obj.quote.text || ''),
          media_kind: String(obj.quote.media_kind || ''),
          thumb_url: String(obj.quote.thumb_url || ''),
        };
      }
      if (Array.isArray(obj.mentions)) {
        out.mentions = obj.mentions.map((it) => ({
          uid: String((it && it.uid) || '').toUpperCase(),
          name: String((it && it.name) || ''),
        })).filter((it) => !!it.uid);
      }
      if (obj.forward_v2 && typeof obj.forward_v2 === 'object' && Array.isArray(obj.forward_v2.items)) {
        out.forward = {
          title: String(obj.forward_v2.title || ''),
          items: obj.forward_v2.items,
        };
      }
      return out;
    } catch (err) {
      return out;
    }
  }

  function quotePreviewText(type, mediaKind, text) {
    const plain = (text || '').trim();
    if (plain) return plain;
    const t = (type || '').toLowerCase();
    if (t === 'image') return mediaKind === 'emoji' ? '[表情]' : '[图片]';
    if (t === 'voice') return '[语音]';
    if (t === 'video') return '[视频]';
    if (t === 'resource') return mediaKind === 'music' ? '[音乐]' : '[资源]';
    if (t === 'music') return '[音乐]';
    if (t === 'red_packet') return '[红包]';
    return '';
  }

  function parseRedPacketBody(bodyText) {
    const payload = {
      packetId: '',
      title: '',
      totalAmount: 0,
      totalCount: 0,
      coverUrl: '',
      status: '',
      remainingCount: null,
    };
    const raw = bodyText == null ? '' : String(bodyText).trim();
    if (!raw) return payload;

    const obj = tryParsePayloadObject(raw);
    if (obj && typeof obj === 'object') {
      payload.packetId = String(obj.packet_id || '');
      payload.title = String(obj.text || obj.title || '');
      payload.totalAmount = Number(obj.total_amount || 0) || 0;
      payload.totalCount = Number(obj.total_count || 0) || 0;
      payload.coverUrl = String(obj.cover_url || '');
      payload.status = String(obj.status || '');
      if (Object.prototype.hasOwnProperty.call(obj, 'remaining_count')) {
        payload.remainingCount = Number(obj.remaining_count || 0) || 0;
      }
      return payload;
    }

    payload.title = raw;
    return payload;
  }

  function isRedPacketDoneInPayload(redPacket) {
    if (!redPacket) return false;
    if ((redPacket.status || '').toLowerCase() === 'done') return true;
    if (redPacket.remainingCount != null && redPacket.remainingCount <= 0) return true;
    if ((redPacket.title || '').indexOf('[消息已焚毁]') >= 0) return true;
    return false;
  }

  function formatTime(ts) {
    if (!ts) return '';
    const millis = ts < 1e12 ? ts * 1000 : ts;
    const date = new Date(millis);
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function resolveUrl(url) {
    if (!url) return '';
    try {
      return new URL(url, window.location.href).toString();
    } catch (err) {
      return url;
    }
  }

  function safeOpen(url) {
    const target = resolveUrl(url);
    if (!target) return;
    window.open(target, '_blank', 'noopener');
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(() => showToast('已复制')).catch(() => {
        window.prompt('复制', text);
      });
    } else {
      window.prompt('复制', text);
    }
  }

  function guessNameFromUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url, window.location.href);
      const part = (u.pathname || '').split('/').pop() || '';
      if (!part) return '';
      return decodeURIComponent(part);
    } catch (e) {
      const part = url.split('?')[0].split('#')[0].split('/').pop() || '';
      try {
        return decodeURIComponent(part);
      } catch (err) {
        return part;
      }
    }
  }

  function parseResourceBody(bodyText, mediaUrl) {
    const out = { name: '', size: '', hint: '' };
    const text = (bodyText || '').trim();
    if (text) {
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] || '').trim();
        if (!line) continue;
        if (!out.name && (line.indexOf('资源:') === 0 || line.indexOf('文件:') === 0 || line.indexOf('资源：') === 0 || line.indexOf('文件：') === 0)) {
          out.name = line.split(/[:：]/).slice(1).join(':').trim();
          continue;
        }
        if (!out.size && (line.indexOf('大小:') === 0 || line.indexOf('大小：') === 0)) {
          out.size = line.split(/[:：]/).slice(1).join(':').trim();
          continue;
        }
        if (!out.hint && (line.indexOf('点击') >= 0 && line.indexOf('下载') >= 0)) {
          out.hint = line;
        }
      }
    }
    if (!out.name) {
      out.name = guessNameFromUrl(mediaUrl) || '资源文件';
    }
    if (!out.hint) {
      out.hint = '点击下载';
    }
    return out;
  }

  function appendTextWithMentionSpans(container, text) {
    const value = text == null ? '' : String(text);
    if (!value) {
      container.textContent = '';
      return;
    }
    const regex = /(@[A-Za-z0-9_\-]+)/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(value)) !== null) {
      const start = match.index;
      const token = match[0];
      if (start > lastIndex) {
        container.appendChild(document.createTextNode(value.slice(lastIndex, start)));
      }
      const span = document.createElement('span');
      span.className = 'mention-token';
      span.textContent = token;
      container.appendChild(span);
      lastIndex = start + token.length;
    }
    if (lastIndex < value.length) {
      container.appendChild(document.createTextNode(value.slice(lastIndex)));
    }
  }

  function jumpToMessage(messageId) {
    if (!messageId) return;
    const selector = `.message[data-message-id="${String(messageId).replace(/"/g, '\\"')}"]`;
    const node = els.messageList.querySelector(selector);
    if (!node) {
      showToast('未找到被引用消息');
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }

  function createQuoteDraft(msg, payload) {
    if (!msg) return null;
    const quoteType = (msg.msg_type || 'text').toLowerCase();
    const fromUid = (msg.from_uid || '').toUpperCase();
    return {
      id: msg.id || '',
      from_uid: fromUid,
      from_name: fromUid === (state.user && state.user.uid ? state.user.uid.toUpperCase() : '') ? '你' : displayNameForUID(fromUid),
      type: quoteType,
      text: quotePreviewText(quoteType, payload.mediaKind, payload.text),
      media_kind: payload.mediaKind || '',
      thumb_url: msg.thumb_url || msg.media_url || '',
    };
  }

  function closeBurnModal() {
    if (state.burnModalTimer) {
      clearInterval(state.burnModalTimer);
      state.burnModalTimer = null;
    }
    els.burnModal.classList.remove('show');
    els.burnModalContent.textContent = '';
    els.burnModalCountdown.textContent = '';
  }

  function openBurnModal(content, seconds) {
    closeBurnModal();
    let remain = normalizeBurnSeconds(seconds);
    if (remain <= 0) remain = 10;
    els.burnModalContent.textContent = content || '(空消息)';
    els.burnModal.classList.add('show');

    function refreshCountdown() {
      els.burnModalCountdown.textContent = `该内容将在 ${remain} 秒后关闭`;
    }

    refreshCountdown();
    state.burnModalTimer = setInterval(() => {
      remain -= 1;
      if (remain <= 0) {
        closeBurnModal();
        showToast('阅后即焚消息已销毁');
        return;
      }
      refreshCountdown();
    }, 1000);
  }

  async function openRedPacket(packet, msg) {
    const packetId = (packet.packetId || '').trim();
    if (!packetId) {
      showToast('红包信息缺失');
      return;
    }
    try {
      const detailResp = await apiRequest(`https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/redpackets/${encodeURIComponent(packetId)}`);
      const detail = detailResp.data || {};
      const done = String(detail.status || '').toLowerCase() === 'done'
        || Number(detail.remaining_count || 0) <= 0;
      if (done) {
        markRedPacketDone(packetId);
      }

      const title = detail.title || packet.title || '恭喜发财';
      const statusLine = done
        ? '该红包已领完'
        : `剩余 ${Number(detail.remaining_count || 0)} 个`;

      if (detail.can_claim) {
        const ok = window.confirm(`红包：${title}\n${statusLine}\n是否立即领取？`);
        if (!ok) return;
        const claimResp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/redpackets/claim', {
          method: 'POST',
          body: { packet_id: packetId },
        });
        const amount = Number(claimResp.data.amount || 0);
        if (Number(claimResp.data.remaining_count || 0) <= 0) {
          markRedPacketDone(packetId);
        }
        showToast(`领取成功 +${amount} 旧币`);
      } else {
        showToast(`${title} · ${statusLine}`);
      }

      if (msg && msg.body) {
        // keep UI state in sync without mutating server data
        renderMessages();
      }
    } catch (err) {
      const raw = err && err.data;
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw || {});
      if (text.indexOf('red_packet_empty') >= 0) {
        markRedPacketDone(packetId);
        showToast('红包已领完');
        renderMessages();
        return;
      }
      if (text.indexOf('red_packet_already_claimed') >= 0) {
        showToast('你已领取过该红包');
        return;
      }
      if (text.indexOf('red_packet_no_permission') >= 0) {
        showToast('无权查看该红包');
        return;
      }
      showToast('红包操作失败');
    }
  }

  function createMessageNode(msg) {
    const node = document.createElement('div');
    const myUid = state.user && state.user.uid ? String(state.user.uid).toUpperCase() : '';
    const fromUid = (msg.from_uid || '').toUpperCase();
    const isMine = fromUid && myUid && fromUid === myUid;
    node.className = 'message' + (isMine ? ' me' : '');
    if (msg.id) {
      node.dataset.messageId = msg.id;
    }

    const payload = parseMessagePayload(msg.body || '');
    const rawType = (msg.msg_type || 'text').toLowerCase();
    const burnLocked = isBurnLockedMessage(msg);
    const burnConsumed = burnLocked && isBurnConsumed(msg.id);

    if (payload.mentions && payload.mentions.length && myUid) {
      const hitMe = payload.mentions.some((it) => it.uid === myUid);
      if (hitMe) {
        node.classList.add('mention-me');
      }
    }

    if (!burnLocked && payload.quote && payload.quote.id) {
      const quoteWrap = document.createElement('div');
      quoteWrap.className = 'message-quote';
      const quoteSender = document.createElement('div');
      quoteSender.className = 'message-quote-sender';
      quoteSender.textContent = payload.quote.from_name || payload.quote.from_uid || '对方';
      const quoteText = document.createElement('div');
      quoteText.className = 'message-quote-text';
      quoteText.textContent = quotePreviewText(payload.quote.type, payload.quote.media_kind, payload.quote.text);
      quoteWrap.appendChild(quoteSender);
      quoteWrap.appendChild(quoteText);
      quoteWrap.addEventListener('click', () => jumpToMessage(payload.quote.id));
      node.appendChild(quoteWrap);
    }

    if (burnLocked && !burnConsumed) {
      const burnCard = document.createElement('div');
      burnCard.className = 'message-burn';
      const title = document.createElement('div');
      title.className = 'message-burn-title';
      title.textContent = '阅后即焚消息';
      const desc = document.createElement('div');
      desc.className = 'message-burn-desc';
      desc.textContent = `点击查看，查看后即焚（${normalizeBurnSeconds(msg.burn_after_seconds)} 秒）`;
      burnCard.appendChild(title);
      burnCard.appendChild(desc);
      burnCard.addEventListener('click', () => {
        markBurnConsumed(msg.id);
        renderMessages();
        openBurnModal(payload.text || msg.body || '', msg.burn_after_seconds);
      });
      node.appendChild(burnCard);
    } else if (burnLocked && burnConsumed) {
      const text = document.createElement('div');
      text.className = 'message-text';
      text.textContent = isMine ? '你发送的阅后即焚消息已销毁' : '该阅后即焚消息已销毁';
      node.appendChild(text);
    } else if (rawType === 'image' || rawType === 'video') {
      const mediaWrap = document.createElement('div');
      mediaWrap.className = 'media-card' + (rawType === 'video' ? ' video-card' : '');
      const img = document.createElement('img');
      img.className = 'message-image';
      img.alt = rawType === 'video' ? '视频预览' : '图片';
      img.src = resolveUrl(msg.thumb_url || msg.media_url || '');
      mediaWrap.appendChild(img);
      if (rawType === 'video') {
        const play = document.createElement('div');
        play.className = 'video-play-badge';
        play.textContent = '▶';
        mediaWrap.appendChild(play);
      }
      mediaWrap.addEventListener('click', () => safeOpen(msg.media_url || msg.thumb_url));
      node.appendChild(mediaWrap);
    } else if (rawType === 'resource') {
      const mediaUrl = resolveUrl(msg.media_url);
      const info = parseResourceBody(payload.text || msg.body, mediaUrl);
      const card = document.createElement('div');
      card.className = 'file-card';
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.addEventListener('click', () => safeOpen(mediaUrl));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          safeOpen(mediaUrl);
        }
      });

      const icon = document.createElement('div');
      icon.className = 'file-icon';
      icon.textContent = 'FILE';

      const textWrap = document.createElement('div');
      textWrap.className = 'file-info';
      const name = document.createElement('div');
      name.className = 'file-name';
      name.textContent = info.name;
      const meta = document.createElement('div');
      meta.className = 'file-meta';
      meta.textContent = (info.size ? `${info.size} · ` : '') + info.hint;
      textWrap.appendChild(name);
      textWrap.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'file-actions';

      const btnDownload = document.createElement('button');
      btnDownload.type = 'button';
      btnDownload.className = 'file-action';
      btnDownload.textContent = '下载';
      btnDownload.addEventListener('click', (e) => {
        e.stopPropagation();
        safeOpen(mediaUrl);
      });

      const btnCopy = document.createElement('button');
      btnCopy.type = 'button';
      btnCopy.className = 'file-action';
      btnCopy.textContent = '复制链接';
      btnCopy.addEventListener('click', (e) => {
        e.stopPropagation();
        copyText(mediaUrl);
      });

      actions.appendChild(btnDownload);
      actions.appendChild(btnCopy);

      card.appendChild(icon);
      card.appendChild(textWrap);
      card.appendChild(actions);
      node.appendChild(card);
    } else if (rawType === 'red_packet') {
      const red = parseRedPacketBody(msg.body);
      const done = isRedPacketDoneInPayload(red) || isRedPacketDone(red.packetId);
      if (done && red.packetId) {
        markRedPacketDone(red.packetId);
      }
      const card = document.createElement('div');
      card.className = 'red-card' + (done ? ' done' : '');
      const title = document.createElement('div');
      title.className = 'red-title';
      title.textContent = red.title || '恭喜发财';
      const desc = document.createElement('div');
      desc.className = 'red-desc';
      if (red.totalAmount > 0 && red.totalCount > 0) {
        desc.textContent = `${red.totalAmount} 旧币 · ${red.totalCount} 个`;
      } else {
        desc.textContent = done ? '已领完' : '点击打开红包';
      }
      card.appendChild(title);
      card.appendChild(desc);
      card.addEventListener('click', () => openRedPacket(red, msg));
      node.appendChild(card);
    } else if (rawType === 'voice') {
      const voice = document.createElement('div');
      voice.className = 'message-text';
      const sec = Math.max(1, Math.round((Number(msg.duration_ms || 0) || 0) / 1000));
      voice.textContent = `[语音] ${sec} 秒`;
      node.appendChild(voice);
    } else if (rawType === 'recall') {
      const recall = document.createElement('div');
      recall.className = 'message-text';
      recall.textContent = payload.text || msg.body || (isMine ? '你撤回了一条消息' : '对方撤回了一条消息');
      node.appendChild(recall);
    } else {
      const body = document.createElement('div');
      body.className = 'message-text';
      appendTextWithMentionSpans(body, payload.text || msg.body || '');
      node.appendChild(body);
    }

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    if (!burnConsumed && rawType !== 'recall') {
      const btnQuote = document.createElement('button');
      btnQuote.type = 'button';
      btnQuote.className = 'msg-action-btn';
      btnQuote.textContent = '引用';
      btnQuote.addEventListener('click', () => {
        setQuoteDraft(createQuoteDraft(msg, payload));
        if (els.messageInput) {
          els.messageInput.focus();
        }
      });
      actions.appendChild(btnQuote);
    }
    if (actions.childNodes.length > 0) {
      node.appendChild(actions);
    }

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const sender = isMine ? '你' : (fromUid || '未知');
    meta.textContent = `${sender} · ${formatTime(msg.created_at || msg.createdAt)}`;
    node.appendChild(meta);

    return node;
  }

  function renderMessages() {
    const nearBottom = els.messageList.scrollHeight - els.messageList.scrollTop - els.messageList.clientHeight < 60;
    els.messageList.innerHTML = '';
    if (!state.messages.length) {
      return;
    }
    const fragment = document.createDocumentFragment();
    state.messages.forEach((msg) => {
      fragment.appendChild(createMessageNode(msg));
    });
    els.messageList.appendChild(fragment);
    if (nearBottom) {
      els.messageList.scrollTop = els.messageList.scrollHeight;
    }
  }

  function appendMessage(msg) {
    const nearBottom = els.messageList.scrollHeight - els.messageList.scrollTop - els.messageList.clientHeight < 60;
    const node = createMessageNode(msg);
    els.messageList.appendChild(node);
    if (nearBottom) {
      els.messageList.scrollTop = els.messageList.scrollHeight;
    }
  }

  async function openConversation(type, id) {
    state.active = { type, id };
    clearQuoteDraft();
    renderConversationHeader();
    setPanel('chat');
    els.messageList.innerHTML = '';
    if (type === 'direct') {
      state.unread.direct[id] = 0;
      await markDirectRead(id);
      await loadDirectMessages(id);
    } else {
      state.unread.group[id] = 0;
      await Promise.all([markGroupRead(id), loadGroupMembers(id), loadGroupMessages(id)]);
    }
    scheduleRenderList();
  }

  async function loadDirectMessages(uid) {
    try {
      const resp = await apiRequest(`https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/direct/messages/v2?with_uid=${encodeURIComponent(uid)}&limit=50&offset=0`);
      state.messages = (resp.data.messages || []).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      renderMessages();
    } catch (err) {
      showToast('拉取私聊记录失败');
    }
  }

  async function loadGroupMessages(groupId) {
    try {
      const resp = await apiRequest(`https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/groups/messages/v2?group_id=${encodeURIComponent(groupId)}&limit=50&offset=0`);
      state.messages = (resp.data.messages || []).sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
      renderMessages();
    } catch (err) {
      showToast('拉取群聊记录失败');
    }
  }

  function extractMentionsForGroup(text, groupId) {
    const result = [];
    if (!text || !groupId) return result;
    const memberMap = state.groupMemberMap[groupId] || {};
    const seen = {};
    const regex = /@([A-Za-z0-9_\-]{2,32})/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      const uid = String(match[1] || '').toUpperCase();
      if (!uid || seen[uid]) continue;
      seen[uid] = 1;
      result.push({ uid, name: memberMap[uid] || uid });
      if (result.length >= 30) break;
    }
    return result;
  }

  function buildOutgoingBody(text) {
    const raw = (text || '').trim();
    const hasQuote = !!(state.quoteDraft && state.quoteDraft.id);
    const mentions = state.active && state.active.type === 'group'
      ? extractMentionsForGroup(raw, state.active.id)
      : [];
    const hasMentions = mentions.length > 0;

    if (!hasQuote && !hasMentions) {
      return raw;
    }

    const payload = {
      v: 2,
      text: raw,
    };

    if (hasQuote) {
      payload.quote = {
        id: state.quoteDraft.id || '',
        from_uid: state.quoteDraft.from_uid || '',
        from_name: state.quoteDraft.from_name || '',
        type: state.quoteDraft.type || 'text',
        text: state.quoteDraft.text || '',
      };
      if (state.quoteDraft.media_kind) {
        payload.quote.media_kind = state.quoteDraft.media_kind;
      }
      if (state.quoteDraft.thumb_url) {
        payload.quote.thumb_url = state.quoteDraft.thumb_url;
      }
    }

    if (hasMentions) {
      payload.mentions = mentions;
    }

    try {
      return JSON.stringify(payload);
    } catch (err) {
      return raw;
    }
  }

  async function sendMessage(text) {
    if (!state.active) return;
    const plain = (text || '').trim();
    if (!plain) return;

    const body = buildOutgoingBody(plain);
    const burnAfterSeconds = normalizeBurnSeconds(Number(els.burnSeconds.value || 0));

    if (state.active.type === 'direct') {
      const resp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/direct/send', {
        method: 'POST',
        body: {
          to_uid: state.active.id,
          body,
          msg_type: 'text',
          burn_after_seconds: burnAfterSeconds,
        },
      });
      const msg = resp.data;
      state.messages.push(msg);
      appendMessage(msg);
    } else if (state.active.type === 'group') {
      const resp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/groups/message/send', {
        method: 'POST',
        body: {
          group_id: state.active.id,
          body,
          msg_type: 'text',
          burn_after_seconds: burnAfterSeconds,
        },
      });
      const msg = resp.data;
      state.messages.push(msg);
      appendMessage(msg);
    }

    clearQuoteDraft();
  }

  async function markDirectRead(uid) {
    try {
      await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/direct/read', { method: 'POST', body: { with_uid: uid } });
    } catch (err) {
      // ignore
    }
  }

  async function markGroupRead(groupId) {
    try {
      await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/groups/read', { method: 'POST', body: { group_id: groupId } });
    } catch (err) {
      // ignore
    }
  }

  async function fetchUnread() {
    if (!state.accessToken) return;
    try {
      const directResp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/direct/unread', {
        method: 'POST',
        body: { limit: 50 },
      });
      const directMap = {};
      (directResp.data.messages || []).forEach((msg) => {
        const peer = (msg.peer_uid || '').toUpperCase();
        if (!peer) return;
        if (!directMap[peer]) directMap[peer] = 0;
        directMap[peer] += 1;
      });
      state.unread.direct = directMap;

      const groupResp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/groups/unread', {
        method: 'POST',
        body: { limit: 50 },
      });
      const groupMap = {};
      (groupResp.data.messages || []).forEach((msg) => {
        const groupId = (msg.group_id || '').toUpperCase();
        if (!groupId) return;
        if (!groupMap[groupId]) groupMap[groupId] = 0;
        groupMap[groupId] += 1;
      });
      state.unread.group = groupMap;
      scheduleRenderList();
    } catch (err) {
      // ignore polling errors
    }
  }

  function startPolling() {
    stopPolling();
    const interval = state.wsConnected ? 45000 : 15000;
    state.pollTimer = setInterval(fetchUnread, interval);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  async function connectWS() {
    if (!state.accessToken) return;
    try {
      await ensureSession();
    } catch (err) {
      showToast('加密握手失败，将使用轮询');
      setStatus(false);
      return;
    }

    const wsProtocol = location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${wsProtocol}://${location.host}https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/ws?token=${encodeURIComponent(state.accessToken)}&sid=${encodeURIComponent(state.sessionId)}`;
    const ws = new WebSocket(wsUrl);
    state.ws = ws;

    ws.onopen = () => {
      setStatus(true);
    };
    ws.onclose = () => {
      setStatus(false);
    };
    ws.onerror = () => {
      setStatus(false);
    };
    ws.onmessage = async (event) => {
      const payload = await decodeWsPayload(event.data);
      if (!payload) return;
      handleWsEvent(payload);
    };
  }

  function disconnectWS() {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
  }

  function handleWsEvent(message) {
    if (!message || !message.type) return;
    if (message.type === 'direct_message') {
      handleDirectMessage(message.data);
    } else if (message.type === 'group_message') {
      handleGroupMessage(message.data);
    }
  }

  function handleDirectMessage(msg) {
    if (!msg || !msg.from_uid) return;
    const fromUid = String(msg.from_uid).toUpperCase();
    if (state.active && state.active.type === 'direct' && state.active.id === fromUid) {
      state.messages.push(msg);
      appendMessage(msg);
      markDirectRead(fromUid);
    } else {
      state.unread.direct[fromUid] = (state.unread.direct[fromUid] || 0) + 1;
      scheduleRenderList();
    }
  }

  function handleGroupMessage(msg) {
    if (!msg || !msg.group_id) return;
    const groupId = String(msg.group_id).toUpperCase();
    if (state.active && state.active.type === 'group' && state.active.id === groupId) {
      state.messages.push(msg);
      appendMessage(msg);
      markGroupRead(groupId);
    } else {
      state.unread.group[groupId] = (state.unread.group[groupId] || 0) + 1;
      scheduleRenderList();
    }
  }

  function base64ToBytes(str) {
    const binary = atob(str);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    bytes.forEach((b) => {
      binary += String.fromCharCode(b);
    });
    return btoa(binary);
  }

  function concatBytes(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  async function sha256(data) {
    const hash = await crypto.subtle.digest('SHA-256', data);
    return new Uint8Array(hash);
  }

  async function hmacSha256(keyBytes, data) {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', key, data);
    return new Uint8Array(sig);
  }

  function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }
    return result === 0;
  }

  function pkcs7Unpad(data) {
    if (!data.length) return data;
    const pad = data[data.length - 1];
    if (pad <= 0 || pad > 16) return data;
    return data.slice(0, data.length - pad);
  }

  async function ensureSession() {
    if (!crypto || !crypto.subtle) {
      throw new Error('crypto not supported');
    }
    if (state.sessionId && state.encKey && state.macKey) return;

    const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
    const clientPub = bytesToBase64(new Uint8Array(spki));
    const resp = await apiRequest('https://nwlproxy.dpdns.org/60.205.94.101:8080/v1/auth/handshake', {
      method: 'POST',
      body: { client_pub: clientPub },
      auth: false,
    });
    const serverPubBytes = base64ToBytes(resp.data.server_pub);
    const serverPub = await crypto.subtle.importKey('spki', serverPubBytes, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const secret = await crypto.subtle.deriveBits({ name: 'ECDH', public: serverPub }, keys.privateKey, 256);
    const secretBytes = new Uint8Array(secret);
    state.sessionId = resp.data.session_id;
    state.encKey = await sha256(concatBytes(secretBytes, new TextEncoder().encode('enc')));
    state.macKey = await sha256(concatBytes(secretBytes, new TextEncoder().encode('mac')));
  }

  async function decryptEnvelope(payload) {
    if (!state.encKey || !state.macKey) return null;
    let env;
    try {
      env = JSON.parse(payload);
    } catch (err) {
      return null;
    }
    if (!env.iv || !env.data || !env.mac) return null;
    const iv = base64ToBytes(env.iv);
    const ciphertext = base64ToBytes(env.data);
    const mac = base64ToBytes(env.mac);
    const expected = await hmacSha256(state.macKey, concatBytes(iv, ciphertext));
    if (!timingSafeEqual(mac, expected)) {
      return null;
    }
    const key = await crypto.subtle.importKey('raw', state.encKey, { name: 'AES-CBC' }, false, ['decrypt']);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, ciphertext);
    const plainBytes = pkcs7Unpad(new Uint8Array(plainBuf));
    return new TextDecoder().decode(plainBytes);
  }

  async function decodeWsPayload(data) {
    if (typeof data !== 'string') return null;
    try {
      const raw = JSON.parse(data);
      if (raw && raw.type) return raw;
    } catch (err) {
      // continue
    }
    const decrypted = await decryptEnvelope(data);
    if (!decrypted) return null;
    try {
      return JSON.parse(decrypted);
    } catch (err) {
      return null;
    }
  }

  function wireEvents() {
    els.tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        setView(btn.dataset.view);
        setPanel('list');
      });
    });
    els.searchInput.addEventListener('input', debounce(scheduleRenderList, 120));
    els.btnLogout.addEventListener('click', logout);
    els.btnBackList.addEventListener('click', () => setPanel('list'));
    els.btnClearQuote.addEventListener('click', clearQuoteDraft);
    els.btnBurnClose.addEventListener('click', closeBurnModal);
    els.burnModal.addEventListener('click', (event) => {
      if (event.target === els.burnModal) {
        closeBurnModal();
      }
    });

    els.composer.addEventListener('submit', async (event) => {
      event.preventDefault();
      const text = els.messageInput.value;
      els.messageInput.value = '';
      try {
        await sendMessage(text);
      } catch (err) {
        showToast('发送失败');
      }
    });

    els.loginForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = els.loginIdentifier.value.trim();
      const pw = els.loginPassword.value;
      if (!id || !pw) {
        showToast('请输入账号和密码');
        return;
      }
      try {
        await login(id, pw);
        await boot();
      } catch (err) {
        showToast('登录失败，请检查账号密码');
      }
    });
  }

  function init() {
    try {
      document.documentElement.setAttribute('data-webapp-version', WEBAPP_VERSION);
      if (typeof console !== 'undefined' && console.log) {
        console.log('[OldChatWeb] version=', WEBAPP_VERSION);
      }
    } catch (err) {
      // ignore
    }
    wireEvents();
    loadAuth();
    if (state.user) {
      setUser(state.user);
    }
    if (state.accessToken) {
      boot();
    } else {
      showLogin(true);
    }
  }

  init();
})();
