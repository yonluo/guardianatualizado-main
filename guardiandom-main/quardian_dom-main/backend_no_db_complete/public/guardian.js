(() => {
  'use strict';
  const $ = (s) => document.querySelector(s),
    $$ = (s) => [...document.querySelectorAll(s)];
  const STORE = 'guardian-v2';
  const defaultSettings = {
    profileVisible: {
      label: 'Perfil visível para contatos',
      description: 'Permitir que pessoas da sua rede vejam seu perfil.',
      value: true,
    },
    notifications: {
      label: 'Notificações de segurança',
      description: 'Receber alertas e atualizações importantes.',
      value: true,
    },
    privacyMode: {
      label: 'Modo de privacidade',
      description: 'Restringir detalhes públicos do seu perfil.',
      value: true,
    },
    cameraSharing: {
      label: 'Compartilhamento de câmeras',
      description: 'Permitir que contatos autorizados vejam suas câmeras.',
      value: true,
    },
    emergencyAlerts: {
      label: 'Alertas de emergência',
      description: 'Receber avisos imediatos de risco e emergência.',
      value: true,
    },
  };
  let state = {
    user: null,
    cameras: [],
    publicCameras: [],
    sharedCameras: [],
    contacts: [],
    groups: [],
    conversations: [],
    activeChat: null,
    view: 'overview',
    contactTab: 'contacts',
    recordingScope: 'mine',
    feed: [],
    communityFeed: [],
    feedFilter: 'all',
    stories: [],
    alerts: [],
    notifications: [],
    localNotifications: [],
    achievements: [],
    reputation: null,
    settings: {},
  };
  let toastTimer;
  let socket = null;
  let realtimeSyncTimer = null;
  let conversationSyncInProgress = false;
  let activeMessageSyncInProgress = false;
  let notificationSyncTimer = null;
  let notificationSyncInProgress = false;
  let cameraReportData = null;
  let cameraReportTarget = null;
  let liveHlsPlayer = null;
  const feedMediaUrls = new Set();
  const chatMediaUrls = new Map();
  let pendingChatMedia = [];
  let imageViewerItems = [];
  let imageViewerIndex = 0;
  let userLocation = null;
  let locationWatchId = null;
  const mapViewport = { center: null, zoom: null };
  let mapDrag = null;
  const safe = (v = '') =>
    String(v).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  function fileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(new Error('Não foi possível ler o arquivo selecionado.'));
      reader.readAsDataURL(file);
    });
  }
  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(STORE) || '{}');
    } catch {
      return {};
    }
  };
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }
  function openModal(id) {
    $('#' + id).classList.remove('hidden');
  }
  function closeModal(id) {
    $('#' + id).classList.add('hidden');
    if (id === 'liveCameraModal') {
      liveHlsPlayer?.destroy();
      liveHlsPlayer = null;
      const player = $('#liveCameraPlayer');
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
    if (id === 'chatImageViewer') {
      $('#chatImageViewerImage').removeAttribute('src');
    }
  }
  function disconnectSocket() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    if (realtimeSyncTimer) {
      clearInterval(realtimeSyncTimer);
      realtimeSyncTimer = null;
    }
    if (notificationSyncTimer) {
      clearInterval(notificationSyncTimer);
      notificationSyncTimer = null;
    }
  }
  function showAuth(register = false) {
    disconnectSocket();
    $('#authScreen').classList.remove('hidden');
    $('#app').classList.add('hidden');
    $('#loginForm').classList.toggle('hidden', register);
    $('#registerForm').classList.toggle('hidden', !register);
    $('#authEyebrow').textContent = register
      ? 'COMECE SUA REDE DE CONFIANÇA'
      : 'BEM-VINDO DE VOLTA';
    $('#authTitle').textContent = register ? 'Crie sua conta' : 'Entre na sua conta';
    $('#authSub').textContent = register
      ? 'Crie seu espaço de segurança no Guardian.'
      : 'Acesse seu espaço de segurança.';
    $('#switchText').textContent = register ? 'Já tem uma conta?' : 'Ainda não tem uma conta?';
    $('#switchAuth').textContent = register ? 'Entrar' : 'Criar conta';
    $('#authError').textContent = '';
  }
  $('#switchAuth').onclick = () => showAuth($('#registerForm').classList.contains('hidden'));
  async function authRequest(path, data) {
    const res = await fetch('/api/auth/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    let d = {};
    try {
      d = await res.json();
    } catch {}
    if (!res.ok) throw Error(d.error || d.message || 'Não foi possível concluir.');
    return d;
  }
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const b = e.currentTarget.querySelector('button');
    b.disabled = true;
    b.textContent = 'Entrando…';
    try {
      const d = await authRequest('login', { email: f.get('email'), password: f.get('password') });
      state.user = d.usuario;
      startApp();
    } catch (err) {
      $('#authError').textContent =
        err.message + ' Se o backend não estiver iniciado, confira as instruções do README.';
    } finally {
      b.disabled = false;
      b.innerHTML = 'Entrar <span>→</span>';
    }
  });
  $('#registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const b = e.currentTarget.querySelector('button');
    b.disabled = true;
    try {
      const d = await authRequest('register', {
        name: f.get('name'),
        email: f.get('email'),
        cpf: f.get('cpf'),
        birthdate: f.get('birthdate'),
        password: f.get('password'),
      });
      state.user = d.usuario;
      startApp();
    } catch (err) {
      $('#authError').textContent = err.message;
    } finally {
      b.disabled = false;
    }
  });
  function currentKey() {
    return 'guardian-data-' + (state.user?.id || state.user?.email || 'guest');
  }
  async function syncConversationList() {
    if (!state.user || conversationSyncInProgress) return;
    conversationSyncInProgress = true;
    try {
      const response = await fetch('/api/social/conversations');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível atualizar as conversas.');
      const previous = new Map(state.conversations.map((item) => [String(item.id), item]));
      state.conversations = result.map((item) => {
        const old = previous.get(String(item.id));
        return {
          ...item,
          serverManaged: true,
          previewMessage: item.messages?.at(-1) || old?.previewMessage,
          messages: old?.messages?.length ? old.messages : item.messages || [],
        };
      });
      renderConversations();
    } catch (error) {
      console.error('Conversation refresh failed:', error);
    } finally {
      conversationSyncInProgress = false;
    }
  }
  async function refreshActiveConversation() {
    if (!state.user || state.view !== 'messages' || activeMessageSyncInProgress) return;
    const conversation = state.conversations.find(
      (item) => String(item.id) === String(state.activeChat) && item.serverManaged
    );
    if (!conversation) return;
    activeMessageSyncInProgress = true;
    try {
      const latestId = conversation.messages.reduce(
        (latest, message) => Math.max(latest, Number(message.id) || 0),
        0
      );
      const response = await fetch(
        `/api/social/conversations/${encodeURIComponent(conversation.id)}/messages?after=${latestId}`
      );
      const messages = await response.json();
      if (!response.ok) throw new Error(messages.error || 'Não foi possível atualizar mensagens.');
      if (!messages.length) return;
      const newMessages = messages.map((message) => ({
        ...message,
        mine: Number(message.senderId) === Number(state.user?.id),
        time: new Date(message.createdAt).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        }),
      }));
      const knownIds = new Set(conversation.messages.map((message) => String(message.id)));
      const unseenMessages = newMessages.filter((message) => !knownIds.has(String(message.id)));
      if (!unseenMessages.length) return;
      await Promise.all(
        unseenMessages.flatMap((message) =>
          (message.media || []).map(async (item) => {
            const mediaResponse = await fetch(
              `/api/social/messages/${encodeURIComponent(message.id)}/media/${encodeURIComponent(item.id)}`
            );
            if (mediaResponse.ok) {
              chatMediaUrls.set(item.id, URL.createObjectURL(await mediaResponse.blob()));
            }
          })
        )
      );
      conversation.messages.push(...unseenMessages);
      renderActiveChat(conversation);
      renderConversations();
    } catch (error) {
      console.error('Active conversation refresh failed:', error);
    } finally {
      activeMessageSyncInProgress = false;
    }
  }
  function handleIncomingRealtimeMessage(payload) {
    if (!payload || !payload.conversationId || !payload.message) return;
    if (String(state.activeChat) === String(payload.conversationId)) {
      refreshActiveConversation();
    } else {
      syncConversationList();
    }
  }
  function connectRealtimeSocket() {
    if (!state.user) return;
    if (socket && socket.connected) return;
    disconnectSocket();
    realtimeSyncTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      if (state.view === 'messages') syncConversationList();
      refreshActiveConversation();
    }, 2500);
    loadNotifications(true);
    notificationSyncTimer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      loadNotifications(true);
    }, 15000);
    if (typeof io !== 'function') return;
    socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      syncConversationList();
    });
    socket.on('message:received', handleIncomingRealtimeMessage);
    socket.on('notification:new', () => loadNotifications(true));
    socket.on('connect_error', (error) => {
      console.error('Real-time connection failed; automatic message sync remains active:', error.message);
    });
  }
  function startApp() {
    const old = load();
    const { token: _token, ...safeUser } = state.user || {};
    state.user = safeUser;
    old.user = safeUser;
    const data = old[currentKey()] || {};
    data.cameras = (data.cameras || []).map(({ streamUrl, ...camera }) => camera);
    old[currentKey()] = data;
    localStorage.setItem(STORE, JSON.stringify(old));
    state.cameras = data.cameras;
    state.contacts = data.contacts || [];
    state.groups = data.groups || [];
    state.conversations = data.conversations || [];
    state.feed = data.feed || [];
    state.communityFeed = [];
    state.alerts = data.alerts || [];
    state.localNotifications = data.localNotifications || [];
    state.achievements = [];
    state.reputation = null;
    state.settings = { ...defaultSettings, ...(data.settings || {}) };
    state.activeChat = null;
    $('#authScreen').classList.add('hidden');
    $('#app').classList.remove('hidden');
    const name = state.user?.name || state.user?.email?.split('@')[0] || 'Usuário';
    $('#userName').textContent = name;
    $('#userEmail').textContent = state.user?.email || '';
    $('#userAvatar').textContent = name.trim().charAt(0).toUpperCase();
    $('#feedComposerAvatar').textContent = name.trim().charAt(0).toUpperCase();
    $('#topAvatar').textContent = name.trim().charAt(0).toUpperCase();
    $('#reputationLevel').textContent = 'Calculando nível...';
    $('#reputationSummary').textContent = 'Carregando atividades da sua conta.';
    $('#reputationScore').textContent = '0';
    $('#reputationRing').setAttribute('aria-label', 'Pontuação 0');
    $('#siteFeedbackComment').value = '';
    $('#siteFeedbackStatus').textContent =
      'Seu comentário fica associado à conta e não altera a pontuação de reputação.';
    $('#todayDate').textContent = new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date());
    renderAll();
    showView('overview');
    connectRealtimeSocket();
    loadSocialData();
    loadServerSettings();
    loadServerCameras();
    loadCameraRequests();
    loadSharedCameras();
    loadReputation();
    loadSiteFeedback();
  }
  function persist() {
    const root = load();
    const { token: _token, ...safeUser } = state.user || {};
    root.user = safeUser;
    root[currentKey()] = {
      cameras: state.cameras
        .filter((camera) => !camera.serverManaged)
        .map(({ streamUrl, rtspUrl, ...camera }) => camera),
      contacts: state.contacts,
      groups: state.groups,
      conversations: state.conversations,
      feed: state.feed,
      alerts: state.alerts,
      localNotifications: state.localNotifications,
      achievements: state.achievements,
      settings: state.settings,
    };
    localStorage.setItem(STORE, JSON.stringify(root));
  }
  function authHeaders(extra = {}) {
    return { ...extra };
  }
  async function loadSocialData() {
    try {
      const [contactsResponse, groupsResponse, conversationsResponse] = await Promise.all([
        fetch('/api/social/contacts'),
        fetch('/api/social/groups'),
        fetch('/api/social/conversations'),
      ]);
      const responses = [contactsResponse, groupsResponse, conversationsResponse];
      const results = await Promise.all(responses.map((response) => response.json()));
      const failed = responses.findIndex((response) => !response.ok);
      if (failed >= 0) throw new Error(results[failed].error || 'Não foi possível carregar sua rede.');
      state.contacts = results[0];
      state.groups = results[1];
      state.conversations = results[2].map((conversation) => ({ ...conversation, serverManaged: true }));
      renderContacts();
      renderConversations();
      renderStats();
    } catch (error) {
      toast(error.message || 'Não foi possível carregar contatos e conversas.');
    }
  }
  async function loadServerSettings() {
    try {
      const response = await fetch('/api/settings');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar as configurações.');
      for (const [name, enabled] of Object.entries(result)) {
        if (state.settings[name]) state.settings[name].value = enabled;
      }
      renderSettings();
    } catch (error) {
      toast(error.message || 'Não foi possível carregar as configurações.');
    }
  }
  async function loadServerCameras() {
    try {
      const response = await fetch('/api/cameras', { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar as câmeras.');
      const localCameras = state.cameras.filter((camera) => !camera.serverManaged);
      state.cameras = [
        ...localCameras,
        ...result.map((camera) => ({
          ...camera,
          serverManaged: true,
          status:
            camera.releaseStatus === 'approved'
              ? 'Liberada automaticamente · privada'
              : 'Aguardando análise',
          report: { number: camera.reportNumber, date: String(camera.reportDate).slice(0, 10) },
        })),
      ];
      renderAll();
      renderSharedCameras();
      renderRecordingCameras();
      if (state.view === 'recordings') loadRecordings();
    } catch (error) {
      toast(error.message || 'Não foi possível carregar as câmeras do servidor.');
    }
  }
  async function loadReputation() {
    try {
      const response = await fetch('/api/reputation', { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível calcular a reputação.');
      state.reputation = result;
      state.achievements = result.achievements || [];
      renderStats();
      renderFeed();
    } catch (error) {
      $('#reputationLevel').textContent = 'Nível indisponível';
      $('#reputationSummary').textContent =
        error.message || 'Não foi possível carregar sua atividade.';
    }
  }
  async function loadSiteFeedback() {
    try {
      const response = await fetch('/api/reputation/feedback', { headers: authHeaders() });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || 'Não foi possível carregar seu comentário.');
      if (result?.comment) {
        $('#siteFeedbackComment').value = result.comment;
        $('#siteFeedbackStatus').textContent =
          'Seu último comentário está salvo. Você pode editá-lo.';
      }
    } catch (error) {
      $('#siteFeedbackStatus').textContent =
        error.message || 'Não foi possível carregar seu comentário.';
    }
  }
  function showView(view) {
    if (view === 'recordings' && state.cameras.length === 0) {
      toast('Cadastre sua primeira câmera para liberar a aba de gravações.');
      view = 'cameras';
    }
    state.view = view;
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + view).classList.remove('hidden');
    $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    const labels = {
      overview: ['Visão geral', 'Bom ter você por aqui ✦'],
      feed: ['Feed', 'Comunidade em movimento'],
      alerts: ['Alertas', 'Seu radar de risco'],
      map: ['Mapa de câmeras', 'Mapa da comunidade'],
      cameras: ['Minhas câmeras', 'Suas câmeras, seu controle'],
      recordings: ['Transmissões e gravações', 'Vídeo privado, acesso autorizado'],
      messages: ['Mensagens', 'Converse com sua comunidade'],
      contacts: ['Contatos e grupos', 'Sua rede de confiança'],
      settings: ['Configurações', 'Sua conta, sua segurança'],
    };
    $('#pageCrumb').textContent = labels[view][0];
    $('#pageTitle').textContent = labels[view][1];
    if (view === 'messages') {
      renderConversations();
      syncConversationList();
    }
    if (view === 'map') {
      loadPublicCameras();
      renderPublicCameras();
      startLocationTracking();
    }
    if (view === 'contacts') renderContacts();
    if (view === 'feed') {
      renderFeed();
      loadCommunityFeed();
      loadStories();
      loadReputation();
      loadSiteFeedback();
    }
    if (view === 'alerts') renderAlerts();
    if (view === 'recordings') {
      renderRecordingCameras();
      loadRecordings();
    }
    if (view === 'settings') renderSettings();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $$('[data-view]').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
  $$('[data-goto]').forEach((b) => (b.onclick = () => showView(b.dataset.goto)));
  $('#logoutBtn').onclick = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    state.user = null;
    const saved = load();
    delete saved.user;
    localStorage.setItem(STORE, JSON.stringify(saved));
    showAuth(false);
  };
  function renderAll() {
    renderStats();
    renderCameras();
    renderPublicCameras();
    renderContacts();
    renderConversations();
    renderFeed();
    renderAlerts();
    renderSettings();
  }
  function renderStats() {
    $('#statCameras').textContent = state.cameras.length;
    $('#cameraCount').textContent = state.cameras.length;
    const recordingsNav = $('[data-view="recordings"]');
    if (recordingsNav) {
      const needsCamera = state.cameras.length === 0;
      recordingsNav.title = needsCamera
        ? 'Cadastre uma câmera para acessar as gravações.'
        : 'Acessar transmissões e gravações.';
      recordingsNav.setAttribute(
        'aria-label',
        needsCamera ? 'Gravações; cadastre uma câmera para acessar' : 'Gravações'
      );
    }
    $('#statContacts').textContent = state.contacts.length;
    $('#statGroups').textContent = state.groups.length;
    $('#statShares').textContent = state.cameras.filter((c) => (c.sharedWith || []).length).length;
    const pub = [...state.publicCameras, ...state.cameras, ...state.sharedCameras].filter(
      (c) => c.isPublic && c.releaseStatus === 'approved'
    );
    $('#mapCameraText').textContent = pub.length
      ? `· ${pub.length} câmera(s) publicada(s)`
      : '· Nenhuma câmera publicada';
    $('#mapEmpty').classList.toggle('hidden', pub.length > 0);
    const reputation = state.reputation;
    if (reputation) {
      $('#reputationLevel').textContent = `Nível ${reputation.level}`;
      $('#reputationSummary').textContent =
        `${reputation.communityPosts} publicações · ${reputation.cameras} câmeras cadastradas.`;
      $('#reputationScore').textContent = reputation.score;
      $('#reputationRing').setAttribute('aria-label', `Pontuação ${reputation.score}`);
    }
  }
  function cameraCard(c, owned = false) {
    const needsApproval = c.releaseStatus !== 'approved';
    const managed = c.serverManaged === true;
    const isOwned = managed && state.cameras.some(
      (camera) => camera.serverManaged && String(camera.id) === String(c.id)
    );
    const releaseLabel =
      c.releaseStatus === 'pending'
        ? 'Em análise'
        : c.releaseStatus === 'reviewing'
          ? 'Análise em andamento'
          : c.releaseStatus === 'approved'
            ? 'Liberada · privada'
            : c.releaseStatus === 'not_requested'
              ? 'BO informado'
              : 'BO obrigatório';
    const accessStatus = needsApproval
      ? `<span class="pill pending">${safe(releaseLabel)}</span>`
      : `<span class="pill ${c.isPublic ? 'public' : 'private'}">${c.isPublic ? '● Pública no mapa' : '🔒 Privada'}</span>`;
    const actions = owned
      ? `<div class="camera-actions">
          ${managed ? `<button class="mini-btn" data-camera-recordings="${safe(c.id)}">Gravações</button>` : ''}
          ${managed && !needsApproval ? `<button class="btn primary small" data-camera-live="${safe(c.id)}">Ao vivo</button><a class="mini-btn" href="/api/cameras/${encodeURIComponent(c.id)}/report-evidence">BO anexado</a><button class="mini-btn" data-camera-share="${safe(c.id)}">Compartilhar referência</button><button class="mini-btn" data-camera-toggle="${safe(c.id)}">${c.isPublic ? 'Tornar privada' : 'Publicar no mapa'}</button>` : ''}
          ${
            !managed && c.releaseStatus === 'not_requested'
              ? `<button class="btn primary small" data-camera-release="${safe(c.id)}">Solicitar liberação</button>`
              : !managed && !c.releaseStatus
                ? `<button class="btn primary small" data-camera-report="${safe(c.id)}">Informar BO e solicitar liberação</button>`
                : ''
          }
          ${
            !managed && !needsApproval
              ? `<button class="mini-btn" data-camera-share="${safe(c.id)}">Compartilhar</button><button class="mini-btn" data-camera-toggle="${safe(c.id)}">${c.isPublic ? 'Tornar privada' : 'Publicar no mapa'}</button>`
              : ''
          }
          <button class="mini-btn danger" data-camera-delete="${safe(c.id)}">Excluir</button>
        </div>
        ${
          needsApproval
            ? `<p class="camera-review-note">${managed ? 'O acesso ao stream é privado ao proprietário. O envio do BO não verifica a autenticidade do documento.' : 'Câmera de cadastro local. Para transmitir, cadastre-a novamente com um endereço RTSP e o BO.'}</p>`
            : ''
        }`
      : managed && c.sharedAccess
        ? `<div class="camera-actions"><button class="btn primary small" data-camera-live="${safe(c.id)}">Ao vivo</button><button class="mini-btn" data-camera-recordings="${safe(c.id)}">Gravações</button></div>`
        : managed && !isOwned
          ? `<div class="camera-actions"><button class="mini-btn" data-camera-request="${safe(c.id)}">Solicitar acesso ao proprietário</button></div>`
          : '';
    return `<article class="camera-card"><div class="camera-symbol">▣</div><div class="camera-info"><h3>${safe(c.name)}</h3><p>⌖ ${safe(c.location || 'Local não informado')}</p><div class="camera-meta">${accessStatus}<span class="pill">${safe(c.status || 'Cadastrada')}</span>${owned && (c.report?.number || c.reportNumber) ? `<span class="pill">BO ${safe(c.report?.number || c.reportNumber)}</span>` : ''}</div>${actions}</div></article>`;
  }
  function renderCameras() {
    const list = $('#myCameraList');
    list.innerHTML = state.cameras.map((c) => cameraCard(c, true)).join('');
    $('#emptyCameras').classList.toggle('hidden', state.cameras.length > 0);
    $('#statCameras').textContent = state.cameras.length;
    list.querySelectorAll('[data-camera-toggle]').forEach(
      (b) =>
        (b.onclick = async () => {
          const c = state.cameras.find((x) => String(x.id) === b.dataset.cameraToggle);
          if (!c || c.releaseStatus !== 'approved') {
            toast('A câmera precisa ser liberada antes de ser publicada.');
            return;
          }
          const nextVisibility = !c.isPublic;
          if (c.serverManaged) {
            try {
              const response = await fetch(`/api/cameras/${encodeURIComponent(c.id)}/visibility`, {
                method: 'PATCH',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ isPublic: nextVisibility }),
              });
              const result = await response.json();
              if (!response.ok) throw new Error(result.error || 'Não foi possível alterar a publicação.');
              c.isPublic = result.isPublic;
            } catch (error) {
              toast(error.message || 'Não foi possível alterar a publicação.');
              return;
            }
          } else c.isPublic = nextVisibility;
          persist();
          await loadPublicCameras();
          renderAll();
          toast(c.isPublic ? 'Câmera publicada no mapa.' : 'Câmera removida do mapa público.');
        })
    );
    list.querySelectorAll('[data-camera-delete]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (confirm('Excluir esta câmera do seu painel?')) {
            const camera = state.cameras.find((item) => String(item.id) === b.dataset.cameraDelete);
            if (camera?.serverManaged) {
              try {
                const response = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}`, {
                  method: 'DELETE',
                  headers: authHeaders(),
                });
                if (!response.ok) {
                  const result = await response.json();
                  throw new Error(result.error || 'Não foi possível excluir a câmera.');
                }
              } catch (error) {
                toast(error.message || 'Não foi possível excluir a câmera.');
                return;
              }
            }
            state.cameras = state.cameras.filter((c) => String(c.id) !== b.dataset.cameraDelete);
            persist();
            renderAll();
            toast('Câmera excluída.');
          }
        })
    );
    list
      .querySelectorAll('[data-camera-share]')
      .forEach((b) => (b.onclick = () => openShareModal(b.dataset.cameraShare)));
    list.querySelectorAll('[data-camera-release]').forEach(
      (b) =>
        (b.onclick = () => {
          const c = state.cameras.find((camera) => String(camera.id) === b.dataset.cameraRelease);
          if (!c || c.releaseStatus !== 'not_requested') return;
          c.releaseStatus = 'pending';
          c.status = 'Aguardando análise';
          c.releaseRequestedAt = new Date().toISOString();
          persist();
          renderAll();
          toast(
            'Solicitação registrada neste dispositivo; a análise exige integração com o servidor.'
          );
        })
    );
    list
      .querySelectorAll('[data-camera-report]')
      .forEach((button) => (button.onclick = () => openCameraModal(button.dataset.cameraReport)));
    list
      .querySelectorAll('[data-camera-live]')
      .forEach((button) => (button.onclick = () => openLiveCamera(button.dataset.cameraLive)));
    list
      .querySelectorAll('[data-camera-recordings]')
      .forEach(
        (button) => (button.onclick = () => openCameraRecordings(button.dataset.cameraRecordings))
      );
  }
  function normalizeMapSearch(value = '') {
    return String(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase('pt-BR')
      .trim();
  }
  function getPublicCameraMatches(query = '') {
    const normalizedQuery = normalizeMapSearch(query);
    return [...new Map([...state.publicCameras, ...state.cameras, ...state.sharedCameras].map((camera) => [String(camera.id), camera])).values()].filter(
      (camera) =>
        camera.isPublic &&
        camera.releaseStatus === 'approved' &&
        normalizeMapSearch(`${camera.name || ''} ${camera.location || ''}`).includes(normalizedQuery)
    );
  }
  function renderPublicCameras() {
    const query = ($('#mapSearch')?.value || '').trim();
    const pub = getPublicCameraMatches(query);
    $('#publicCameraTotal').textContent =
      `${pub.length} ${pub.length === 1 ? 'câmera pública' : 'câmeras públicas'}`;
    const cameraList = $('#publicCameraList');
    cameraList.innerHTML = pub.length
      ? pub.map((c) => cameraCard(c, false)).join('')
      : `<div class="map-empty-state">
          <span class="map-empty-icon" aria-hidden="true">⌖</span>
          <div>
            <h4>${query ? 'Nenhuma câmera encontrada' : 'Ainda não há câmeras públicas por aqui'}</h4>
            <p>${query ? 'Tente buscar por outro nome ou local.' : 'Quando alguém compartilhar uma câmera publicamente, ela aparecerá no mapa.'}</p>
          </div>
          ${query ? '' : '<button class="btn secondary small" type="button" data-map-register>＋ Cadastrar câmera</button>'}
        </div>`;
    cameraList.querySelector('[data-map-register]')?.addEventListener('click', () => showView('cameras'));
    cameraList.querySelectorAll('[data-camera-request]').forEach((button) => {
      button.onclick = async () => {
        try {
          const response = await fetch('/api/requests/solicitar', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ cameraId: button.dataset.cameraRequest }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Não foi possível solicitar acesso.');
          toast(result.mensagem);
        } catch (error) {
          toast(error.message || 'Não foi possível solicitar acesso.');
        }
      };
    });
    cameraList.querySelectorAll('[data-camera-live]').forEach((button) => {
      button.onclick = () => openLiveCamera(button.dataset.cameraLive);
    });
    cameraList.querySelectorAll('[data-camera-recordings]').forEach((button) => {
      button.onclick = () => openCameraRecordings(button.dataset.cameraRecordings);
    });
    const coordinates = pub
      .map((camera) => ({
        latitude: Number(camera.latitude),
        longitude: Number(camera.longitude),
      }))
      .filter(
        ({ latitude, longitude }) =>
          Number.isFinite(latitude) &&
          Number.isFinite(longitude) &&
          latitude >= -90 &&
          latitude <= 90 &&
          longitude >= -180 &&
          longitude <= 180
      );
    renderCommunityMap(coordinates);
  }
  async function loadPublicCameras() {
    try {
      const response = await fetch('/api/cameras/public');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar as câmeras públicas.');
      state.publicCameras = result;
      renderPublicCameras();
      renderStats();
    } catch (error) {
      toast(error.message || 'Não foi possível carregar as câmeras públicas.');
    }
  }
  async function loadSharedCameras() {
    try {
      const response = await fetch('/api/cameras/shared');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar os compartilhamentos.');
      state.sharedCameras = result;
      renderPublicCameras();
      renderRecordingCameras();
      renderSharedCameras();
    } catch (error) {
      toast(error.message || 'Não foi possível carregar os compartilhamentos.');
    }
  }
  async function loadCameraRequests() {
    try {
      const response = await fetch('/api/requests');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar solicitações.');
      const requests = result.filter((item) => Number(item.ownerId) === Number(state.user?.id) && ['pending', 'approved'].includes(item.status));
      $('#cameraRequestsSection').classList.toggle('hidden', requests.length === 0);
      $('#cameraRequestsList').innerHTML = requests.map((item) => `
        <article class="camera-card"><div class="camera-info"><h3>${safe(item.cameraName)}</h3>
        <p>Solicitante: ${safe(item.requesterName)} · ${item.status === 'approved' ? 'Acesso concedido' : 'Aguardando decisão'}</p><div class="camera-actions">
        ${item.status === 'pending' ? `<button class="btn primary small" data-request-approve="${safe(item.id)}">Aprovar vídeo e gravações</button><button class="mini-btn danger" data-request-reject="${safe(item.id)}">Recusar</button>` : `<button class="mini-btn danger" data-request-revoke="${safe(item.id)}">Revogar acesso</button>`}</div></div></article>`).join('');
      $('#cameraRequestsList').querySelectorAll('[data-request-approve], [data-request-reject], [data-request-revoke]').forEach((button) => {
        button.onclick = async () => {
          const approve = button.hasAttribute('data-request-approve');
          const reject = button.hasAttribute('data-request-reject');
          const revoke = button.hasAttribute('data-request-revoke');
          const id = button.dataset.requestApprove || button.dataset.requestReject || button.dataset.requestRevoke;
          try {
            const action = approve ? 'aprovar' : reject ? 'recusar' : 'revogar';
            const response = await fetch(`/api/requests/${action}/${encodeURIComponent(id)}`, { method: 'PUT' });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Não foi possível responder à solicitação.');
            toast(result.mensagem);
            await loadCameraRequests();
          } catch (error) {
            toast(error.message || 'Não foi possível responder à solicitação.');
          }
        };
      });
    } catch (error) {
      toast(error.message || 'Não foi possível carregar solicitações.');
    }
  }
  function renderSharedCameras() {
    const section = $('#sharedCamerasSection');
    if (!section) return;
    section.classList.toggle('hidden', state.sharedCameras.length === 0);
    $('#sharedCameraList').innerHTML = state.sharedCameras.map((camera) => cameraCard(camera, false)).join('');
    $('#sharedCameraList').querySelectorAll('[data-camera-live]').forEach((button) => {
      button.onclick = () => openLiveCamera(button.dataset.cameraLive);
    });
    $('#sharedCameraList').querySelectorAll('[data-camera-recordings]').forEach((button) => {
      button.onclick = () => openCameraRecordings(button.dataset.cameraRecordings);
    });
  }
  let googleMapInstance = null;
  const googleMapMarkers = [];
  let mapSearchTimer = null;
  let mapSearchRequestId = 0;
  let mapSearchActive = false;
  let lastMapGeocodeAt = 0;

  function saveMapViewport(map = googleMapInstance) {
    const center = map?.getCenter();
    if (!center) return;
    mapViewport.center = { latitude: center.lat(), longitude: center.lng() };
    mapViewport.zoom = map.getZoom();
  }

  function ensureGoogleMap() {
    const map = $('#googleMap');
    if (!map || !window.google?.maps) return null;
    if (!googleMapInstance) {
      googleMapInstance = new window.google.maps.Map(map, {
        center: { lat: -14.2, lng: -51.9 },
        zoom: 4,
        mapTypeId: window.google.maps.MapTypeId.ROADMAP,
        disableDefaultUI: false,
        zoomControl: true,
        streetViewControl: false,
        fullscreenControl: false,
        mapTypeControl: false,
        gestureHandling: 'greedy',
      });
      googleMapInstance.addListener('idle', () => saveMapViewport());
    }
    return googleMapInstance;
  }

  function cameraCoordinates(cameras) {
    return cameras
      .map((camera) => ({
        latitude: Number(camera.latitude),
        longitude: Number(camera.longitude),
      }))
      .filter(
        ({ latitude, longitude }) =>
          Number.isFinite(latitude) &&
          Number.isFinite(longitude) &&
          latitude >= -90 &&
          latitude <= 90 &&
          longitude >= -180 &&
          longitude <= 180
      );
  }

  function focusMapOnCameras(coordinates) {
    const map = ensureGoogleMap();
    if (!map || !coordinates.length) return;
    if (coordinates.length === 1) {
      map.setCenter({ lat: coordinates[0].latitude, lng: coordinates[0].longitude });
      map.setZoom(15);
      saveMapViewport(map);
      return;
    }
    const bounds = new window.google.maps.LatLngBounds();
    coordinates.forEach(({ latitude, longitude }) => bounds.extend({ lat: latitude, lng: longitude }));
    map.fitBounds(bounds, 60);
    window.google.maps.event.addListenerOnce(map, 'idle', () => saveMapViewport(map));
  }

  function renderCommunityMap(coordinates) {
    const map = $('#googleMap');
    if (!map) return;
    if (!window.google?.maps) {
      if (window.guardianGoogleMapsReady) {
        map.textContent = 'Google Maps não foi carregado corretamente.';
      }
      return;
    }

    const googleMap = ensureGoogleMap();
    if (!googleMap) return;

    googleMapMarkers.forEach((marker) => marker.setMap(null));
    googleMapMarkers.length = 0;

    const defaultCenter = { lat: -14.2, lng: -51.9 };
    const initialCenter =
      userLocation ||
      (coordinates.length
        ? {
            lat:
              coordinates.reduce((sum, coordinate) => sum + coordinate.latitude, 0) /
              coordinates.length,
            lng:
              coordinates.reduce((sum, coordinate) => sum + coordinate.longitude, 0) /
              coordinates.length,
          }
        : defaultCenter);

    let center = mapViewport.center
      ? { lat: Number(mapViewport.center.latitude), lng: Number(mapViewport.center.longitude) }
      : initialCenter;

    const bounds = new window.google.maps.LatLngBounds();

    coordinates.forEach((coordinate) => {
      const marker = new window.google.maps.Marker({
        position: { lat: coordinate.latitude, lng: coordinate.longitude },
        map: googleMap,
        title: 'Câmera pública',
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 8,
          fillColor: '#1453a5',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      googleMapMarkers.push(marker);
      bounds.extend(marker.getPosition());
    });

    if (userLocation) {
      const userMarker = new window.google.maps.Marker({
        position: { lat: userLocation.latitude, lng: userLocation.longitude },
        map: googleMap,
        title: 'Sua localização',
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 10,
          fillColor: '#ffc629',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 3,
        },
      });
      googleMapMarkers.push(userMarker);
      bounds.extend(userMarker.getPosition());
      center = { lat: userLocation.latitude, lng: userLocation.longitude };
    }

    if (mapSearchActive && mapViewport.center) {
      googleMap.setCenter({
        lat: Number(mapViewport.center.latitude),
        lng: Number(mapViewport.center.longitude),
      });
      googleMap.setZoom(mapViewport.zoom || 14);
    } else if (coordinates.length || userLocation) {
      if (userLocation && coordinates.length) {
        googleMap.fitBounds(bounds, 60);
      } else if (coordinates.length === 1) {
        googleMap.setCenter({ lat: coordinates[0].latitude, lng: coordinates[0].longitude });
        googleMap.setZoom(13);
      } else if (coordinates.length > 1) {
        googleMap.fitBounds(bounds, 50);
      } else {
        googleMap.setCenter(center);
        googleMap.setZoom(14);
      }
    } else {
      googleMap.setCenter(defaultCenter);
      googleMap.setZoom(4);
    }

    saveMapViewport(googleMap);
  }

  function renderMapWithCurrentData() {
    renderCommunityMap(cameraCoordinates(getPublicCameraMatches($('#mapSearch')?.value || '')));
  }
  window.renderMapWithCurrentData = renderMapWithCurrentData;

  function setMapSearchStatus(message) {
    const status = $('#mapSearchStatus');
    if (status) status.textContent = message;
  }

  async function searchOpenStreetMapLocation(query, requestId) {
    const wait = Math.max(0, 1000 - (Date.now() - lastMapGeocodeAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (requestId !== mapSearchRequestId) return;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    lastMapGeocodeAt = Date.now();
    try {
      const params = new URLSearchParams({
        q: query,
        format: 'jsonv2',
        limit: '1',
        'accept-language': 'pt-BR',
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OpenStreetMap search failed: HTTP ${response.status}`);
      const results = await response.json();
      if (requestId !== mapSearchRequestId) return;
      const result = results[0];
      if (!result) {
        setMapSearchStatus('Local não encontrado. Tente outro nome ou endereço.');
        return;
      }

      const latitude = Number(result.lat);
      const longitude = Number(result.lon);
      if (
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        latitude < -90 ||
        latitude > 90 ||
        longitude < -180 ||
        longitude > 180
      ) {
        throw new Error('OpenStreetMap returned invalid coordinates.');
      }
      const map = ensureGoogleMap();
      if (!map) throw new Error('Google map is unavailable.');
      map.setCenter({ lat: latitude, lng: longitude });
      map.setZoom(14);
      saveMapViewport(map);
      setMapSearchStatus(`Local encontrado: ${result.display_name || query}`);
    } catch (error) {
      if (requestId !== mapSearchRequestId) return;
      console.error('OpenStreetMap location search failed:', error);
      setMapSearchStatus(
        error.name === 'AbortError'
          ? 'A pesquisa demorou demais. Tente novamente.'
          : 'Não foi possível pesquisar o local. Verifique sua conexão e tente novamente.'
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  function searchMapLocation(query, requestId) {
    const map = ensureGoogleMap();
    const Geocoder = window.google?.maps?.Geocoder;
    if (!map || !Geocoder) {
      setMapSearchStatus('Não foi possível pesquisar locais no mapa agora.');
      return;
    }
    setMapSearchStatus('Pesquisando local…');
    new Geocoder().geocode({ address: query }, (results, status) => {
      if (requestId !== mapSearchRequestId) return;
      if (status === 'OK' && results?.[0]?.geometry?.location) {
        const result = results[0];
        map.setCenter(result.geometry.location);
        map.setZoom(14);
        saveMapViewport(map);
        setMapSearchStatus(`Local encontrado: ${result.formatted_address || query}`);
      } else {
        if (status !== 'ZERO_RESULTS' && status !== 'REQUEST_DENIED') {
          console.warn('Google Maps location search unavailable:', status);
        }
        searchOpenStreetMapLocation(query, requestId);
      }
    });
  }

  function handleMapSearch() {
    clearTimeout(mapSearchTimer);
    const requestId = ++mapSearchRequestId;
    const query = ($('#mapSearch')?.value || '').trim();
    mapSearchActive = Boolean(query);
    renderPublicCameras();
    if (!query) {
      setMapSearchStatus('');
      return;
    }

    const matchingCameras = getPublicCameraMatches(query);
    const coordinates = cameraCoordinates(matchingCameras);
    if (coordinates.length) {
      focusMapOnCameras(coordinates);
      setMapSearchStatus(
        `${matchingCameras.length} ${matchingCameras.length === 1 ? 'câmera encontrada' : 'câmeras encontradas'}`
      );
      return;
    }

    mapSearchTimer = setTimeout(() => searchMapLocation(query, requestId), 450);
  }

  function setMapLocationStatus(message, stateName = '') {
    const status = $('#mapLocationStatus');
    if (!status) return;
    status.textContent = message;
    status.classList.toggle('error', stateName === 'error');
    status.classList.toggle('active', stateName === 'active');
  }
  function startLocationTracking() {
    if (locationWatchId !== null) return;
    if (!navigator.geolocation) {
      setMapLocationStatus('Localização não disponível neste navegador.', 'error');
      return;
    }
    setMapLocationStatus('Solicitando sua localização…');
    locationWatchId = navigator.geolocation.watchPosition(
      (position) => {
        userLocation = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        };
        if (!mapViewport.center) {
          mapViewport.center = userLocation;
          mapViewport.zoom = 14;
        }
        setMapLocationStatus('Sua localização está sendo atualizada em tempo real.', 'active');
        renderMapWithCurrentData();
      },
      (error) => {
        const messages = {
          1: 'Permita a localização no navegador para centralizar o mapa.',
          2: 'Não foi possível determinar sua localização.',
          3: 'A localização demorou para responder. Tente novamente.',
        };
        setMapLocationStatus(messages[error.code] || 'Localização indisponível.', 'error');
      },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
    );
  }
  $('#locateMeBtn').onclick = () => {
    if (userLocation) {
      mapViewport.center = userLocation;
      mapViewport.zoom = 14;
      renderMapWithCurrentData();
      setMapLocationStatus('Mapa centralizado na sua localização.', 'active');
      return;
    }
    startLocationTracking();
  };
  function approvedServerCameras() {
    return state.cameras.filter(
      (camera) => camera.serverManaged && camera.releaseStatus !== 'rejected'
    ).concat(state.sharedCameras);
  }
  function recordingScopeCameras(scope = state.recordingScope) {
    if (scope === 'shared') {
      return state.sharedCameras.filter((camera) => camera.releaseStatus !== 'rejected');
    }
    if (scope === 'live') {
      return approvedServerCameras();
    }
    return state.cameras.filter(
      (camera) => camera.serverManaged && camera.releaseStatus !== 'rejected'
    );
  }
  function renderRecordingCameras(selectedId) {
    const select = $('#recordingCameraFilter');
    if (!select) return;
    const previous = selectedId || select.value;
    const cameras = recordingScopeCameras();
    const statMine = state.cameras.filter(
      (camera) => camera.serverManaged && camera.releaseStatus !== 'rejected'
    ).length;
    const statLive = approvedServerCameras().length;
    const statShared = state.sharedCameras.filter(
      (camera) => camera.releaseStatus !== 'rejected'
    ).length;
    $('#recordingsStatMine').textContent = String(statMine);
    $('#recordingsStatLive').textContent = String(statLive);
    $('#recordingsStatShared').textContent = String(statShared);
    select.innerHTML = cameras
      .map((camera) => `<option value="${safe(camera.id)}">${safe(camera.name)}</option>`)
      .join('');
    select.disabled = cameras.length === 0;
    if (cameras.some((camera) => String(camera.id) === String(previous))) select.value = previous;
    if (!cameras.length) {
      const emptyMessages = {
        mine: 'Nenhuma câmera própria está disponível para consultar gravações.',
        live: 'Nenhuma transmissão ao vivo está disponível no momento.',
        shared: 'Nenhuma câmera compartilhada está disponível para consulta.',
      };
      $('#recordingsMessage').textContent = emptyMessages[state.recordingScope] || emptyMessages.mine;
      $('#recordingList').replaceChildren();
    }
  }
  async function loadRecordings() {
    const cameraId = $('#recordingCameraFilter').value;
    const message = $('#recordingsMessage');
    const list = $('#recordingList');
    if (!cameraId) {
      const emptyMessages = {
        mine: 'Selecione uma câmera própria para consultar gravações disponíveis.',
        live: 'Selecione uma transmissão ativa para acompanhar o vídeo em tempo real.',
        shared: 'Selecione uma câmera compartilhada para consultar gravações disponíveis.',
      };
      message.textContent = emptyMessages[state.recordingScope] || emptyMessages.mine;
      list.replaceChildren();
      return;
    }
    message.textContent = 'Buscando gravações...';
    list.replaceChildren();
    const query = new URLSearchParams();
    for (const [field, parameter] of [
      ['recordingFrom', 'from'],
      ['recordingTo', 'to'],
      ['recordingTimeFrom', 'timeFrom'],
      ['recordingTimeTo', 'timeTo'],
    ]) {
      const value = $('#' + field).value;
      if (value) query.set(parameter, value);
    }
    try {
      const response = await fetch(
        `/api/cameras/${encodeURIComponent(cameraId)}/recordings?${query}`,
        { headers: authHeaders() }
      );
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar as gravações.');
      if (!result.length) {
        message.textContent = 'Nenhuma gravação encontrada para os filtros selecionados.';
        return;
      }
      message.textContent = `${result.length} gravação(ões) encontrada(s).`;
      list.innerHTML = result
        .map(
          (recording) => `
            <article class="recording-item">
              <div>
                <strong>${safe(recording.date)} · ${safe(recording.time)}</strong>
                <div class="recording-meta"><span>◉</span>${safe(recording.cameraName || 'Câmera')}</div>
                <small>${(recording.sizeBytes / (1024 * 1024)).toFixed(1)} MB</small>
              </div>
              <div class="recording-actions">
                <button class="btn secondary small" data-play-recording="${safe(recording.downloadUrl)}" data-recording-label="${safe(recording.date)} ${safe(recording.time)}">Reproduzir</button>
                <a class="mini-btn" href="${safe(recording.downloadUrl)}?download=1">Baixar</a>
              </div>
            </article>
          `
        )
        .join('');
      list.querySelectorAll('[data-play-recording]').forEach((button) => {
        button.onclick = () => {
          const player = $('#recordingPlayer');
          player.pause();
          player.src = button.dataset.playRecording;
          player.load();
          $('#recordingPlayerTitle').textContent = `Gravação · ${button.dataset.recordingLabel}`;
          $('#recordingPlayerWrap').classList.remove('hidden');
          player.play().catch(() => {
            $('#recordingsMessage').textContent =
              'A gravação foi carregada. Pressione Reproduzir no player para iniciar.';
          });
        };
      });
    } catch (error) {
      message.textContent = error.message || 'Falha ao carregar as gravações.';
    }
  }
  async function openLiveCamera(cameraId) {
    const camera = [...state.cameras, ...state.sharedCameras].find(
      (item) => item.serverManaged && String(item.id) === String(cameraId)
    );
    if (!camera || camera.releaseStatus !== 'approved') return;
    const video = $('#liveCameraPlayer');
    const status = $('#liveCameraStatus');
    $('#liveCameraTitle').textContent = camera.name;
    status.textContent = 'Verificando conexão autorizada...';
    video.pause();
    video.removeAttribute('src');
    video.load();
    liveHlsPlayer?.destroy();
    liveHlsPlayer = null;
    openModal('liveCameraModal');
    try {
      const response = await fetch(`/api/cameras/${encodeURIComponent(camera.id)}/status`, {
        headers: authHeaders(),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível verificar a conexão.');
      if (result.status !== 'online') {
        status.textContent = 'Câmera aprovada, mas sem transmissão ativa no momento.';
        return;
      }
      const source = `/api/cameras/${encodeURIComponent(camera.id)}/live/index.m3u8`;
      const HlsPlayer = window.Hls;
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = source;
      } else if (HlsPlayer?.isSupported()) {
        liveHlsPlayer = new HlsPlayer({ enableWorker: true });
        liveHlsPlayer.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (data.fatal) status.textContent = 'Não foi possível reproduzir este fluxo HLS.';
        });
        liveHlsPlayer.loadSource(source);
        liveHlsPlayer.attachMedia(video);
      } else {
        status.textContent = 'Este navegador não oferece suporte à reprodução HLS.';
        return;
      }
      status.textContent = 'Transmissão privada conectada. O acesso é restrito ao proprietário.';
    } catch (error) {
      status.textContent = error.message || 'Não foi possível abrir a transmissão.';
    }
  }
  function openCameraRecordings(cameraId) {
    renderRecordingCameras(cameraId);
    showView('recordings');
  }
  $('#mapSearch').addEventListener('input', handleMapSearch);
  $('#refreshMap').onclick = () => {
    renderPublicCameras();
    renderMapWithCurrentData();
    toast('Mapa atualizado.');
  };
  function setCameraStep(step) {
    const reportStep = $('#cameraReportStep');
    const detailsStep = $('#cameraDetailsStep');
    reportStep.classList.toggle('hidden', step !== 1);
    detailsStep.classList.toggle('hidden', step !== 2);
    reportStep.querySelectorAll('input, button').forEach((control) => {
      control.disabled = step !== 1;
    });
    detailsStep.querySelectorAll('input, button').forEach((control) => {
      control.disabled = step !== 2;
    });
    $$('[data-step-indicator]').forEach((indicator) => {
      const active = Number(indicator.dataset.stepIndicator) === step;
      indicator.classList.toggle('active', active);
      indicator.classList.toggle('complete', Number(indicator.dataset.stepIndicator) < step);
    });
  }
  function openCameraModal(cameraId) {
    $('#cameraError').textContent = '';
    $('#cameraDetailsError').textContent = '';
    $('#cameraForm').reset();
    cameraReportData = null;
    cameraReportTarget = cameraId
      ? state.cameras.find((camera) => String(camera.id) === String(cameraId)) || null
      : null;
    $('#cameraModalTitle').textContent = cameraReportTarget
      ? 'Adicionar BO à câmera'
      : 'Cadastrar câmera';
    $('#cameraSubmitButton').textContent = cameraReportTarget
      ? 'Salvar BO e liberar acesso privado'
      : 'Cadastrar e liberar acesso privado';
    if (cameraReportTarget) {
      $('#cameraForm').elements.name.value = cameraReportTarget.name || '';
      $('#cameraForm').elements.location.value = cameraReportTarget.location || '';
      $('#cameraForm').elements.latitude.value = cameraReportTarget.latitude ?? '';
      $('#cameraForm').elements.longitude.value = cameraReportTarget.longitude ?? '';
    }
    setCameraStep(1);
    openModal('cameraModal');
  }
  $('#openCameraModal').onclick = $('#emptyAddCamera').onclick = () => openCameraModal();
  $('#continueCameraForm').onclick = () => {
    const form = $('#cameraForm');
    const reportNumber = form.elements.boNumber.value.trim();
    const reportDate = form.elements.boDate.value;
    const reportFile = form.elements.reportFile.files[0];
    const error = $('#cameraError');
    error.textContent = '';
    if (!reportNumber || !reportDate) {
      error.textContent = 'Informe o número e a data do BO para continuar.';
      return;
    }
    if (new Date(reportDate) > new Date(new Date().toDateString())) {
      error.textContent = 'A data do BO não pode estar no futuro.';
      return;
    }
    if (!reportFile) {
      error.textContent = 'Anexe o BO em PDF, JPG, PNG, WebP, MP4 ou WebM.';
      return;
    }
    if (reportFile.size > 10 * 1024 * 1024) {
      error.textContent = 'O arquivo do BO deve ter até 10 MB.';
      return;
    }
    if (
      ![
        'application/pdf',
        'image/jpeg',
        'image/png',
        'image/webp',
        'video/mp4',
        'video/webm',
      ].includes(reportFile.type)
    ) {
      error.textContent = 'Escolha um arquivo PDF, JPG, PNG, WebP, MP4 ou WebM.';
      return;
    }
    cameraReportData = { number: reportNumber, date: reportDate };
    setCameraStep(2);
  };
  $('#backCameraForm').onclick = () => {
    cameraReportData = null;
    $('#cameraDetailsError').textContent = '';
    setCameraStep(1);
  };
  $('#searchRecordings').onclick = loadRecordings;
  $('#recordingCameraFilter').addEventListener('change', loadRecordings);
  $$('.recording-tab').forEach((button) => {
    button.addEventListener('click', () => {
      state.recordingScope = button.dataset.recordingTab;
      $$('.recording-tab').forEach((tab) =>
        tab.classList.toggle('is-active', tab === button)
      );
      renderRecordingCameras();
      loadRecordings();
    });
  });
  $('#closeRecordingPlayer').onclick = () => {
    const player = $('#recordingPlayer');
    player.pause();
    player.removeAttribute('src');
    player.load();
    $('#recordingPlayerWrap').classList.add('hidden');
  };
  $('#cameraForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#cameraDetailsError').textContent = '';
    if (!cameraReportData) {
      setCameraStep(1);
      $('#cameraError').textContent = 'Preencha primeiro os dados do boletim de ocorrência.';
      return;
    }
    const f = new FormData(e.currentTarget);
    const reportFile = e.currentTarget.elements.reportFile.files[0];
    const latitude = f.get('latitude') ? Number(f.get('latitude')) : null;
    const longitude = f.get('longitude') ? Number(f.get('longitude')) : null;
    if ((latitude === null) !== (longitude === null)) {
      $('#cameraDetailsError').textContent =
        'Informe latitude e longitude juntas ou deixe ambas vazias.';
      return;
    }
    if (!window.isSecureContext) {
      $('#cameraDetailsError').textContent =
        'Use HTTPS para enviar as credenciais da câmera com segurança.';
      return;
    }
    const submitButton = $('#cameraSubmitButton');
    submitButton.disabled = true;
    submitButton.textContent = 'Enviando e liberando acesso privado…';
    try {
      const reportData = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('Não foi possível ler o arquivo do BO.'));
        reader.readAsDataURL(reportFile);
      });
      const rtspUrl = String(f.get('rtspUrl') || '').trim();
      const response = await fetch('/api/cameras', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          name: String(f.get('name') || '').trim(),
          location: String(f.get('location') || '').trim(),
          latitude,
          longitude,
          reportNumber: cameraReportData.number,
          reportDate: cameraReportData.date,
          reportEvidence: {
            fileName: reportFile.name,
            mimeType: reportFile.type,
            data: reportData,
          },
          rtspUrl,
          streamUrl: rtspUrl,
          cameraSourceUrl: rtspUrl,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível cadastrar a câmera.');
      const camera = {
        ...result,
        serverManaged: true,
        status: 'Liberada automaticamente · privada',
        report: { number: result.reportNumber, date: String(result.reportDate).slice(0, 10) },
      };
      if (cameraReportTarget && !cameraReportTarget.serverManaged) {
        state.cameras = state.cameras.filter(
          (existing) => String(existing.id) !== String(cameraReportTarget.id)
        );
      }
      state.cameras.unshift(camera);
      cameraReportTarget = null;
      cameraReportData = null;
      persist();
      renderAll();
      closeModal('cameraModal');
      showView('cameras');
      loadReputation();
      toast('Câmera liberada para sua conta. O stream continua privado.');
    } catch (error) {
      $('#cameraDetailsError').textContent =
        error.message || 'Não foi possível cadastrar a câmera.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Cadastrar e liberar acesso privado';
    }
  });
  $$('[data-close]').forEach((b) => (b.onclick = () => closeModal(b.dataset.close)));
  $$('.modal-backdrop').forEach((m) =>
    m.addEventListener('click', (event) => {
      if (event.target === m) closeModal(m.id);
    })
  );
  $('#addContactBtn').onclick = $('#emptyAddContact').onclick = () => {
    $('#contactError').textContent = '';
    $('#contactForm').reset();
    openModal('contactModal');
  };
  $('#contactForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = new FormData(e.currentTarget).get('email').trim().toLowerCase();
    if (email === state.user?.email?.toLowerCase()) {
      $('#contactError').textContent = 'Você já é o próprio titular desta conta.';
      return;
    }
    if (state.contacts.some((c) => c.email.toLowerCase() === email)) {
      $('#contactError').textContent = 'Este contato já está na sua lista.';
      return;
    }
    try {
      const response = await fetch('/api/social/contacts', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ email }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível enviar o convite.');
      await loadSocialData();
      closeModal('contactModal');
      toast('Convite enviado para uma conta Guardian existente.');
    } catch (error) {
      $('#contactError').textContent = error.message || 'Não foi possível enviar o convite.';
    }
  });
  function renderContacts() {
    const q = ($('#contactSearch')?.value || '').toLowerCase();
    const list = state.contacts.filter((c) => (c.name + ' ' + c.email).toLowerCase().includes(q));
    $('#contactCountLabel').textContent = state.contacts.length + ' contatos';
    $('#contactList').innerHTML = list
      .map(
        (c) =>
          `<article class="person-card"><span class="avatar">${safe(c.name[0] || '?')}</span><h3>${safe(c.name)}</h3><p>${safe(c.email)}</p><small>${c.status === 'accepted' ? 'Contato confirmado' : c.direction === 'incoming' ? 'Convite recebido' : 'Convite enviado'}</small><div class="person-actions">${c.status === 'accepted' ? `<button class="btn primary small" data-chat-contact="${c.userId}">Mensagem</button>` : c.direction === 'incoming' ? `<button class="btn primary small" data-contact-accept="${c.id}">Aceitar</button><button class="mini-btn" data-contact-reject="${c.id}">Recusar</button>` : ''}<button class="mini-btn" data-contact-remove="${c.id}">Remover</button></div></article>`
      )
      .join('');
    $('#emptyContacts').classList.toggle('hidden', state.contacts.length > 0);
    $('#contactsPane').classList.toggle('hidden', state.contactTab !== 'contacts');
    $('#groupsPane').classList.toggle('hidden', state.contactTab !== 'groups');
    $('#groupList').innerHTML = state.groups
      .map(
        (g) =>
          `<article class="person-card"><span class="avatar">◉</span><h3>${safe(g.name)}</h3><p>${safe(g.description || 'Grupo privado')}</p><div class="group-members">${g.members.length} participante(s)</div><div class="person-actions"><button class="btn primary small" data-chat-group="${g.id}">Abrir conversa</button><button class="mini-btn danger" data-group-remove="${g.id}">Excluir</button></div></article>`
      )
      .join('');
    $('#emptyGroups').classList.toggle('hidden', state.groups.length > 0);
    $('#contactList')
      .querySelectorAll('[data-chat-contact]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            const userId = b.dataset.chatContact;
            const c = state.contacts.find(
              (contact) =>
                String(contact.userId) === String(userId) ||
                String(contact.id) === String(userId)
            );
            if (!c) {
              toast('Contato não encontrado para iniciar a conversa.');
              return;
            }
            openDirectConversation(c);
          })
      );
    $('#contactList')
      .querySelectorAll('[data-contact-remove]')
      .forEach(
        (b) =>
          (b.onclick = async () => {
            try {
              const response = await fetch(`/api/social/contacts/${encodeURIComponent(b.dataset.contactRemove)}`, { method: 'DELETE' });
              if (!response.ok) throw new Error('Não foi possível remover o contato.');
              await loadSocialData();
            } catch (error) {
              toast(error.message);
            }
          })
      );
    $('#contactList').querySelectorAll('[data-contact-accept], [data-contact-reject]').forEach((button) => {
      button.onclick = async () => {
        const status = button.hasAttribute('data-contact-accept') ? 'accepted' : 'rejected';
        const id = button.dataset.contactAccept || button.dataset.contactReject;
        try {
          const response = await fetch(`/api/social/contacts/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            headers: authHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ status }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Não foi possível responder ao convite.');
          await loadSocialData();
          if (status === 'accepted') {
            const contact = state.contacts.find((item) => String(item.id) === String(id));
            const targetUserId = contact ? Number(contact.userId) : null;
            const conversation = targetUserId
              ? state.conversations.find(
                  (item) =>
                    item.type === 'direct' &&
                    (String(item.otherUserId) === String(targetUserId) ||
                      String(item.ref) === String(targetUserId) ||
                      String(item.userId) === String(targetUserId))
                )
              : null;
            if (conversation) {
              state.activeChat = conversation.id;
              showView('messages');
              openChat(conversation.id);
            }
          }
        } catch (error) {
          toast(error.message || 'Não foi possível responder ao convite.');
        }
      };
    });
    $('#groupList')
      .querySelectorAll('[data-chat-group]')
      .forEach(
        (b) =>
          (b.onclick = () => {
            const conversation = state.conversations.find((item) => String(item.groupId) === b.dataset.chatGroup);
            if (conversation) {
              state.activeChat = conversation.id;
              showView('messages');
              openChat(conversation.id);
            }
          })
      );
    $('#groupList')
      .querySelectorAll('[data-group-remove]')
      .forEach(
        (b) =>
          (b.onclick = async () => {
            try {
              const response = await fetch(`/api/social/groups/${encodeURIComponent(b.dataset.groupRemove)}`, { method: 'DELETE' });
              if (!response.ok) throw new Error('Não foi possível excluir o grupo.');
              await loadSocialData();
            } catch (error) {
              toast(error.message);
            }
          })
      );
  }
  $$('[data-tab]').forEach(
    (b) =>
      (b.onclick = () => {
        state.contactTab = b.dataset.tab;
        $$('[data-tab]').forEach((t) => t.classList.toggle('active', t === b));
        renderContacts();
      })
  );
  $('#contactSearch').addEventListener('input', renderContacts);
  function openGroupModal() {
    if (!state.contacts.length) {
      toast('Adicione contatos antes de criar um grupo.');
      openModal('contactModal');
      return;
    }
    $('#groupForm').reset();
    $('#groupError').textContent = '';
    $('#groupMembers').innerHTML = state.contacts
      .filter((contact) => contact.status === 'accepted')
      .map((c) => `<option value="${c.userId}">${safe(c.name)} — ${safe(c.email)}</option>`)
      .join('');
    openModal('groupModal');
  }
  $('#createGroupBtn').onclick = $('#emptyCreateGroup').onclick = openGroupModal;
  $('#groupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const members = [...$('#groupMembers').selectedOptions].map((o) => Number(o.value));
    try {
      const response = await fetch('/api/social/groups', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ name: f.get('name').trim(), description: f.get('description').trim(), members }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível criar o grupo.');
      await loadSocialData();
      closeModal('groupModal');
      showView('messages');
      const conversation = state.conversations.find((item) => String(item.groupId) === String(result.id));
      if (conversation) openChat(conversation.id);
    } catch (error) {
      $('#groupError').textContent = error.message || 'Não foi possível criar o grupo.';
    }
  });
  function ensureConversation(type, ref, name) {
    let c = state.conversations.find((x) => x.type === type && String(x.ref) === String(ref));
    if (!c) {
      c = { id: Date.now() + Math.random(), type, ref, name, messages: [] };
      state.conversations.unshift(c);
    }
    return c;
  }
  async function openDirectConversation(contact) {
    if (!contact) return;
    const targetUserId = Number(contact.userId ?? contact.id ?? contact.recipientId ?? contact.requesterId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      toast('Selecione um contato válido para iniciar a conversa.');
      return;
    }
    try {
      const existingConversation = state.conversations.find(
        (item) =>
          item.type === 'direct' &&
          (String(item.otherUserId) === String(targetUserId) ||
            String(item.ref) === String(targetUserId) ||
            String(item.userId) === String(targetUserId))
      );
      if (existingConversation) {
        state.activeChat = existingConversation.id;
        showView('messages');
        openChat(existingConversation.id);
        return;
      }
      const response = await fetch('/api/social/conversations/direct', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ userId: targetUserId }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível abrir a conversa.');
      await loadSocialData();
      const conversation =
        state.conversations.find((item) => String(item.id) === String(result.id)) ||
        state.conversations.find(
          (item) =>
            item.type === 'direct' &&
            (String(item.otherUserId) === String(targetUserId) ||
              String(item.ref) === String(targetUserId))
        );
      if (!conversation) throw new Error('A conversa não apareceu na lista.');
      state.activeChat = conversation.id;
      showView('messages');
      openChat(conversation.id);
    } catch (error) {
      toast(error.message || 'Não foi possível abrir a conversa.');
    }
  }
  function renderConversations() {
    const q = ($('#conversationSearch')?.value || '').toLowerCase();
    const list = state.conversations.filter((c) => c.name.toLowerCase().includes(q));
    $('#conversationItems').innerHTML =
      list
        .map((c) => {
          const latestMessage = c.previewMessage || c.messages.at(-1);
          const previewText =
            latestMessage?.text ||
            (latestMessage?.media?.length
              ? latestMessage.media.some((media) => media.type?.startsWith('video/'))
                ? 'Vídeo'
                : 'Foto'
              : c.type === 'group'
                ? 'Grupo privado'
                : 'Conversa privada');
          return `<button class="conversation-item ${String(c.id) === String(state.activeChat) ? 'active' : ''}" data-open-chat="${c.id}"><span class="avatar">${c.type === 'group' ? '◉' : safe(c.name[0] || '?')}</span><span><b>${safe(c.name)}</b><small>${safe(previewText)}</small></span></button>`;
        })
        .join('') ||
      '<div class="empty-inline">Nenhuma conversa ainda.<br>Adicione um contato ou crie um grupo.</div>';
    $('#conversationItems')
      .querySelectorAll('[data-open-chat]')
      .forEach((b) => (b.onclick = () => openChat(b.dataset.openChat)));
  }
  $('#conversationSearch').addEventListener('input', renderConversations);
  async function openChat(id) {
    const c = state.conversations.find((c) => String(c.id) === String(id));
    if (!c) return;
    if (c.serverManaged) {
      try {
        const response = await fetch(`/api/social/conversations/${encodeURIComponent(c.id)}/messages`);
        const messages = await response.json();
        if (!response.ok) throw new Error(messages.error || 'Não foi possível carregar mensagens.');
        c.messages = messages.map((message) => ({
          ...message,
          mine: Number(message.senderId) === Number(state.user?.id),
          time: new Date(message.createdAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
        }));
        await Promise.all(c.messages.flatMap((message) => (message.media || []).map(async (item) => {
          const mediaResponse = await fetch(`/api/social/messages/${encodeURIComponent(message.id)}/media/${encodeURIComponent(item.id)}`);
          if (mediaResponse.ok) chatMediaUrls.set(item.id, URL.createObjectURL(await mediaResponse.blob()));
        })));
      } catch (error) {
        toast(error.message || 'Não foi possível carregar mensagens.');
        return;
      }
    }
    if (pendingChatMedia.length && String(c.id) !== String(state.activeChat)) {
      pendingChatMedia.forEach((item) => URL.revokeObjectURL(item.url));
      pendingChatMedia = [];
      renderChatMediaPreview();
    }
    state.activeChat = c.id;
    renderActiveChat(c);
  }
  function renderActiveChat(c) {
    $('#chatEmpty').classList.add('hidden');
    $('#chatActive').classList.remove('hidden');
    $('#chatName').textContent = c.name;
    $('#chatSubtitle').textContent =
      c.type === 'group'
        ? 'Grupo privado · ' +
          (state.groups.find((g) => String(g.id) === String(c.groupId || c.ref))?.members.length || 0) +
          ' participante(s)'
        : 'Conversa privada';
    $('#chatAvatar').textContent = c.type === 'group' ? '◉' : c.name[0] || '?';
    $('#chatMessages').innerHTML = c.messages
      .map((m, messageIndex) => {
        const media = Array.isArray(m.media) ? m.media : [];
        const imageItems = media.filter(
          (item) => item.type?.startsWith('image/') && chatMediaUrls.has(item.id)
        );
        const imageMarkup = imageItems.length
          ? `<div class="chat-media-gallery ${imageItems.length === 1 ? 'single' : ''}">${imageItems
              .map((item, imageIndex) => {
                const url = chatMediaUrls.get(item.id);
                return url
                  ? `<button type="button" class="chat-image-button" data-chat-image="${messageIndex}" data-image-index="${imageIndex}" aria-label="Abrir ${safe(item.name)}"><img src="${safe(url)}" alt="${safe(item.name)}" loading="lazy" /></button>`
                  : '';
              })
              .join('')}</div>`
          : '';
        const videoMarkup = media
          .filter((item) => item.type?.startsWith('video/'))
          .map((item) => {
            const url = chatMediaUrls.get(item.id);
            return url
              ? `<video class="chat-video" src="${safe(url)}" controls playsinline preload="metadata" aria-label="${safe(item.name)}"></video>`
              : '';
          })
          .join('');
        const unavailableMedia = media.some((item) => !chatMediaUrls.has(item.id))
          ? '<div class="chat-media-unavailable">Mídia local indisponível nesta sessão.</div>'
          : '';
        const legacyFile = m.file
          ? `<br><a href="${safe(m.file.url)}" target="_blank" rel="noopener">${safe(m.file.name)}</a>`
          : '';
        return `<div class="message-bubble ${m.mine ? 'mine' : ''}">${m.text ? `<div>${safe(m.text)}</div>` : ''}${imageMarkup}${videoMarkup}${unavailableMedia}${legacyFile}<small>${safe(m.time)}</small></div>`;
      })
      .join('');
    $('#chatMessages')
      .querySelectorAll('[data-chat-image]')
      .forEach((button) => {
        button.onclick = () => {
          const message = c.messages[Number(button.dataset.chatImage)];
          const images = (message?.media || []).filter(
            (item) => item.type?.startsWith('image/') && chatMediaUrls.has(item.id)
          );
          openChatImageViewer(images, Number(button.dataset.imageIndex));
        };
      });
    $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
    renderConversations();
  }
  function renderChatMediaPreview() {
    const preview = $('#chatMediaPreview');
    preview.classList.toggle('hidden', pendingChatMedia.length === 0);
    preview.innerHTML = pendingChatMedia.length
      ? `<div class="chat-media-preview-heading"><span>Prévia · ${pendingChatMedia.length} arquivo(s)</span><button type="button" data-clear-chat-media>Limpar</button></div><div class="chat-media-preview-items">${pendingChatMedia
          .map((item) =>
            item.type.startsWith('video/')
              ? `<div class="chat-media-preview-item"><video src="${safe(item.url)}" muted playsinline preload="metadata"></video><span class="chat-media-preview-play">▶</span><button type="button" data-remove-chat-media="${safe(item.id)}" aria-label="Remover ${safe(item.name)}">×</button><small>${safe(item.name)}</small></div>`
              : `<div class="chat-media-preview-item"><img src="${safe(item.url)}" alt="${safe(item.name)}" /><button type="button" data-remove-chat-media="${safe(item.id)}" aria-label="Remover ${safe(item.name)}">×</button><small>${safe(item.name)}</small></div>`
          )
          .join('')}</div>`
      : '';
  }
  function removePendingChatMedia(id) {
    const index = pendingChatMedia.findIndex((item) => item.id === id);
    if (index < 0) return;
    URL.revokeObjectURL(pendingChatMedia[index].url);
    pendingChatMedia.splice(index, 1);
    renderChatMediaPreview();
  }
  $('#chatMediaPreview').addEventListener('click', (event) => {
    const removeButton = event.target.closest('[data-remove-chat-media]');
    if (removeButton) {
      removePendingChatMedia(removeButton.dataset.removeChatMedia);
      return;
    }
    if (event.target.closest('[data-clear-chat-media]')) {
      pendingChatMedia.forEach((item) => URL.revokeObjectURL(item.url));
      pendingChatMedia = [];
      renderChatMediaPreview();
    }
  });
  function openChatImageViewer(images, index) {
    imageViewerItems = images;
    imageViewerIndex = index;
    renderChatImageViewer();
    openModal('chatImageViewer');
  }
  function renderChatImageViewer() {
    const item = imageViewerItems[imageViewerIndex];
    if (!item) return;
    $('#chatImageViewerImage').src = chatMediaUrls.get(item.id);
    $('#chatImageViewerCaption').textContent = item.name;
    $('#chatImageViewerPosition').textContent =
      imageViewerItems.length > 1 ? `${imageViewerIndex + 1} de ${imageViewerItems.length}` : '';
    $('#chatImageViewerPrevious').disabled = imageViewerItems.length < 2;
    $('#chatImageViewerNext').disabled = imageViewerItems.length < 2;
  }
  $('#chatImageViewerPrevious').onclick = () => {
    imageViewerIndex = (imageViewerIndex - 1 + imageViewerItems.length) % imageViewerItems.length;
    renderChatImageViewer();
  };
  $('#chatImageViewerNext').onclick = () => {
    imageViewerIndex = (imageViewerIndex + 1) % imageViewerItems.length;
    renderChatImageViewer();
  };
  $('#messageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#messageInput');
    const text = input.value.trim();
    if (!text && !pendingChatMedia.length) return;
    const c = state.conversations.find((c) => String(c.id) === String(state.activeChat));
    if (!c) return;
    if (!c.serverManaged) {
      toast('Esta conversa local não é compartilhada. Atualize ou crie uma conversa entre contatos confirmados.');
      return;
    }
    try {
      const entries = pendingChatMedia.length ? pendingChatMedia : [null];
      for (let index = 0; index < entries.length; index += 1) {
        const file = entries[index]?.file;
        const media = file
          ? {
              fileName: file.name,
              mimeType: file.type,
              data: await fileAsBase64(file),
            }
          : undefined;
        const response = await fetch(`/api/social/conversations/${encodeURIComponent(c.id)}/messages`, {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ content: index === 0 ? text : '', media }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Não foi possível enviar a mensagem.');
      }
      pendingChatMedia.forEach((item) => URL.revokeObjectURL(item.url));
      pendingChatMedia = [];
      input.value = '';
      $('#mediaInput').value = '';
      renderChatMediaPreview();
      await openChat(c.id);
      renderConversations();
    } catch (error) {
      toast(error.message || 'Não foi possível enviar a mensagem.');
    }
  });
  $('#attachBtn').onclick = () => $('#mediaInput').click();
  $('#mediaInput').addEventListener('change', (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const c = state.conversations.find((c) => String(c.id) === String(state.activeChat));
    if (!c) {
      toast('Abra uma conversa antes de anexar arquivos.');
      e.target.value = '';
      return;
    }
    let skippedLargeFile = false;
    let skippedUnsupportedFile = false;
    for (const file of files) {
      if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(file.type)) {
        skippedUnsupportedFile = true;
        continue;
      }
      if (file.size > 4 * 1024 * 1024) {
        skippedLargeFile = true;
        continue;
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      pendingChatMedia.push({
        id,
        name: file.name,
        type: file.type,
        file,
        url: URL.createObjectURL(file),
      });
    }
    renderChatMediaPreview();
    if (skippedLargeFile)
      toast('Alguns arquivos excedem o limite de 4 MB e não foram adicionados.');
    else if (skippedUnsupportedFile) toast('Apenas fotos e vídeos podem ser anexados.');
    e.target.value = '';
  });
  $('#shareCameraBtn').onclick = () => openShareModal();
  function openShareModal(cameraId) {
    const list = state.cameras.filter((camera) => camera.releaseStatus === 'approved');
    if (!list.length) {
      toast('Só é possível compartilhar câmeras liberadas após a conferência do BO.');
      return;
    }
    $('#shareCameraChoices').innerHTML = list
      .map(
        (c) =>
          `<div class="share-choice"><div><b>${safe(c.name)}</b><small>${safe(c.location)} · ${c.isPublic ? 'Pública' : 'Privada'}</small></div><button class="btn primary small" data-share-select="${c.id}">Compartilhar</button></div>`
      )
      .join('');
    $('#shareCameraChoices')
      .querySelectorAll('[data-share-select]')
      .forEach(
        (b) =>
          (b.onclick = async () => {
            const c = state.cameras.find((c) => String(c.id) === b.dataset.shareSelect);
            const conv = state.conversations.find((c) => String(c.id) === String(state.activeChat));
            if (conv) {
              const text = `Referência de câmera: ${c.name} — ${c.location}. Para acessar o vídeo, solicite autorização ao proprietário.`;
              if (conv.serverManaged) {
                try {
                  const response = await fetch(`/api/social/conversations/${encodeURIComponent(conv.id)}/messages`, {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ content: text }),
                  });
                  const result = await response.json();
                  if (!response.ok) throw new Error(result.error || 'Não foi possível compartilhar a referência.');
                  await openChat(conv.id);
                } catch (error) {
                  toast(error.message || 'Não foi possível compartilhar a referência.');
                  return;
                }
              } else {
                conv.messages.push({ text, mine: true, time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) });
                persist();
                openChat(conv.id);
              }
            }
            closeModal('shareModal');
            toast('Referência da câmera adicionada à conversa local.');
          })
      );
    openModal('shareModal');
  }
  const feedFilterLabels = {
    all: 'Todos os relatos',
    alertas: 'Avisos e segurança',
    Aviso: 'Avisos',
    Segurança: 'Segurança',
    Comunidade: 'Comunidade',
    Suporte: 'Suporte',
  };
  $$('[data-feed-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.feedFilter = button.dataset.feedFilter || 'all';
      $$('[data-feed-filter]').forEach((filterButton) => {
        const selected = filterButton.dataset.feedFilter === state.feedFilter;
        filterButton.classList.toggle('active', selected);
        filterButton.setAttribute('aria-pressed', String(selected));
      });
      renderFeed();
    });
  });
  function renderFeed() {
    const list = $('#feedList');
    if (!list) return;
    feedMediaUrls.forEach((url) => URL.revokeObjectURL(url));
    feedMediaUrls.clear();
    const allFeed = [...(state.communityFeed || []), ...(state.feed || [])].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const categoryOf = (item) => String(item.category || item.type || 'Comunidade').trim();
    const categories = ['Aviso', 'Segurança', 'Comunidade', 'Suporte'];
    const counts = Object.fromEntries(categories.map((category) => [category, allFeed.filter((item) => categoryOf(item) === category).length]));
    document.querySelectorAll('[data-feed-count]').forEach((counter) => {
      const filter = counter.dataset.feedCount;
      const amount = filter === 'all'
        ? allFeed.length
        : filter === 'alertas'
          ? counts.Aviso + counts.Segurança
          : counts[filter] || 0;
      counter.textContent = amount ? String(amount) : '0';
    });
    const feed = state.feedFilter === 'all'
      ? allFeed
      : state.feedFilter === 'alertas'
        ? allFeed.filter((item) => ['Aviso', 'Segurança'].includes(categoryOf(item)))
        : allFeed.filter((item) => categoryOf(item) === state.feedFilter);
    $('#feedResultLabel').textContent = feedFilterLabels[state.feedFilter] || 'Publicações da comunidade';
    $('#feedResultCount').textContent = `${feed.length} ${feed.length === 1 ? 'relato' : 'relatos'}`;
    if (!feed.length) {
      list.innerHTML = `
        <div class="feed-empty">
          <span class="empty-icon">◎</span>
          <h3>${allFeed.length ? 'Nenhum relato neste tema ainda' : 'Seu feed começa aqui'}</h3>
          <p>${allFeed.length ? 'Escolha outro tema ou publique uma atualização para a comunidade.' : 'Compartilhe uma foto, um vídeo ou um aviso para sua cidade.'}</p>
        </div>`;
      return;
    }
    list.innerHTML = feed
      .map((item) => {
        const itemId = safe(item.id);
        const isCommunityPost = Boolean(item.userId);
        const category = categoryOf(item);
        const isAlertPost = ['Aviso', 'Segurança'].includes(category);
        const publishedAt = item.createdAt
          ? new Date(item.createdAt).toLocaleString('pt-BR', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'Agora';
        const commentCount = item.comments?.length || 0;
        return `
          <article class="feed-card" data-post-id="${itemId}">
            <header class="feed-post-header">
              <span class="feed-post-avatar">${safe((item.author || 'U').trim().charAt(0).toUpperCase())}</span>
              <div class="feed-post-author">
                <strong>${safe(item.author || 'Usuário')}</strong>
                <small>${safe(item.location || 'Comunidade Guardian')} <span>·</span> ${safe(publishedAt)}</small>
              </div>
              <span class="feed-post-category ${isAlertPost ? 'is-alert' : ''}">${safe(category)}</span>
            </header>
            ${isAlertPost ? `<div class="feed-alert-banner"><span aria-hidden="true">!</span><strong>${category === 'Aviso' ? 'Aviso da comunidade' : 'Alerta de segurança'}</strong></div>` : ''}
            ${item.content || item.text ? `<p class="feed-post-copy">${safe(item.content || item.text)}</p>` : ''}
            ${
              item.media?.length
                ? `<div class="feed-media-viewer" data-media-for="${itemId}">
                    <span class="media-loading">Carregando mídia…</span>
                  </div>`
                : ''
            }
            <div class="feed-post-actions">
              <span class="feed-post-source"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>${isCommunityPost ? 'Visível para a comunidade' : 'Sua publicação'}</span>
              <button type="button" class="feed-comment-link" data-focus-comment="${itemId}">${commentCount} ${commentCount === 1 ? 'comentário' : 'comentários'}</button>
            </div>
            <div class="comment-stack">
              ${(item.comments || [])
                .map(
                  (comment) => `
                    <div class="comment-item">
                      <strong>${safe(comment.author || 'Usuário')}</strong>
                      <span>${safe(comment.text)}</span>
                      <small>${safe(comment.time || 'agora')}</small>
                    </div>
                  `
                )
                .join('')}
            </div>
            <form class="comment-form" data-feed-comment="${itemId}" data-community="${isCommunityPost}">
              <input name="comment" maxlength="1000" placeholder="Adicionar comentário" aria-label="Adicionar comentário" />
              <button type="submit" class="mini-btn">Enviar</button>
            </form>
          </article>
        `;
      })
      .join('');
    loadFeedMedia();
    list.querySelectorAll('[data-focus-comment]').forEach((button) => {
      button.onclick = () => {
        const input = list.querySelector(
          `[data-feed-comment="${CSS.escape(button.dataset.focusComment)}"] input[name="comment"]`
        );
        input?.focus();
      };
    });
    const comments = $('#feedComments');
    if (comments) {
      const recentComments = feed.flatMap((item) =>
        (item.comments || []).map((comment) => ({ ...comment, postAuthor: item.author }))
      );
      comments.innerHTML = recentComments.length
        ? recentComments
            .slice(0, 3)
            .map(
              (comment) =>
                `<div class="comment-item"><strong>${safe(comment.author || 'Usuário')}</strong><span>${safe(comment.text)}</span><small>${safe(comment.time || comment.postAuthor || 'agora')}</small></div>`
            )
            .join('')
        : '<div class="empty-inline">Ainda não há comentários.</div>';
    }
    const achievements = $('#miniAchievements');
    if (achievements) {
      achievements.innerHTML = state.achievements?.length
        ? state.achievements
            .map(
              (achievement) =>
                `<div class="mini-badge"><span>${safe(achievement.icon || '✦')}</span><div><strong>${safe(achievement.title)}</strong><small>${safe(achievement.detail)}</small></div></div>`
            )
            .join('')
        : '<div class="empty-inline">Conquistas verificadas aparecerão aqui.</div>';
    }
    $('#feedList')
      ?.querySelectorAll('[data-feed-comment]')
      .forEach((form) => {
        form.addEventListener('submit', async (event) => {
          if (form.dataset.community !== 'true') return;
          event.preventDefault();
          const input = form.querySelector('input[name="comment"]');
          const text = input.value.trim();
          if (!text) return;
          const submit = form.querySelector('button[type="submit"]');
          submit.disabled = true;
          try {
            const response = await fetch(`/api/feed/${encodeURIComponent(form.dataset.feedComment)}/comments`, {
              method: 'POST',
              headers: authHeaders({ 'Content-Type': 'application/json' }),
              body: JSON.stringify({ content: text }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Não foi possível salvar o comentário.');
            const item = state.communityFeed.find((entry) => String(entry.id) === form.dataset.feedComment);
            if (item) item.comments = [...(item.comments || []), result];
            renderFeed();
          } catch (error) {
            toast(error.message || 'Não foi possível salvar o comentário.');
            submit.disabled = false;
          }
        });
      });
    $('#feedList')
      ?.querySelectorAll('[data-feed-comment]:not([data-community="true"] )')
      .forEach((form) => {
        form.addEventListener('submit', (event) => {
          event.preventDefault();
          const input = form.querySelector('input[name="comment"]');
          const text = input.value.trim();
          if (!text) return;
          const id = Number(form.dataset.feedComment);
          const item = state.feed.find((entry) => String(entry.id) === String(id));
          if (!item) return;
          item.comments = item.comments || [];
          item.comments.push({ author: state.user?.name || 'Você', text, time: 'agora' });
          persist();
          renderFeed();
        });
      });
  }

  async function loadCommunityFeed() {
    try {
      const response = await fetch('/api/feed', {
        headers: {},
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível carregar o feed.');
      state.communityFeed = data;
      renderFeed();
    } catch (error) {
      toast(error.message || 'Falha ao carregar as publicações da comunidade.');
    }
  }

  async function loadStories() {
    try {
      const response = await fetch('/api/stories');
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível carregar os Stories.');
      state.stories = result;
      renderStories();
    } catch (error) {
      toast(error.message || 'Não foi possível carregar os Stories.');
    }
  }

  function renderStories() {
    const list = $('#feedStoriesList');
    if (!list) return;
    const stories = state.stories || [];
    if (!stories.length) {
      list.innerHTML = '<p class="feed-stories-empty">Quando alguém compartilhar um relato, ele aparecerá aqui por 24 horas.</p>';
      return;
    }
    list.innerHTML = stories
      .map((story) => {
        const isAlert = Boolean(story.isAlert);
        const initial = (story.author || 'U').trim().charAt(0).toUpperCase();
        const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(story.createdAt).getTime()) / 60000));
        const age = ageMinutes < 1 ? 'agora' : ageMinutes < 60 ? `${ageMinutes} min` : `${Math.floor(ageMinutes / 60)} h`;
        return `
          <button type="button" class="feed-story-card ${isAlert ? 'story-alert' : ''}" data-open-story="${safe(story.id)}" aria-label="Abrir Story de ${safe(story.author)}${isAlert ? ', alerta com BO anexado' : ''}">
            <span class="feed-story-ring"><span class="feed-story-avatar">${safe(initial)}</span>${isAlert ? '<span class="feed-story-alert-dot" aria-hidden="true">!</span>' : ''}</span>
            <span class="feed-story-label">${safe(story.author || 'Usuário')}</span>
            <span class="feed-story-time">${safe(age)}</span>
          </button>`;
      })
      .join('');
    list.querySelectorAll('[data-open-story]').forEach((button) => {
      button.onclick = () => openStory(button.dataset.openStory);
    });
  }

  function openStory(storyId) {
    const story = state.stories.find((item) => String(item.id) === String(storyId));
    if (!story) return;
    $('#storyViewerAvatar').textContent = (story.author || 'U').trim().charAt(0).toUpperCase();
    $('#storyViewerAuthor').textContent = story.author || 'Usuário';
    const ageMinutes = Math.max(0, Math.floor((Date.now() - new Date(story.createdAt).getTime()) / 60000));
    const age = ageMinutes < 1 ? 'agora' : ageMinutes < 60 ? `há ${ageMinutes} min` : `há ${Math.floor(ageMinutes / 60)} h`;
    const remainingMinutes = Math.max(0, Math.ceil((Number(story.expiresAt) - Date.now()) / 60000));
    const remaining = remainingMinutes < 60
      ? `${remainingMinutes} min restantes`
      : `${Math.ceil(remainingMinutes / 60)} h restantes`;
    $('#storyViewerMeta').textContent = `${story.category} · ${age} · ${remaining}`;
    $('#storyViewerContent').textContent = story.content;
    $('#storyViewerAlert').classList.toggle('hidden', !story.isAlert);

    const media = $('#storyViewerMedia');
    media.replaceChildren();
    media.classList.toggle('hidden', !story.mediaUrl);
    if (story.mediaUrl) {
      const element = story.mediaType === 'video' ? document.createElement('video') : document.createElement('img');
      element.src = story.mediaUrl;
      if (element instanceof HTMLVideoElement) {
        element.controls = true;
        element.playsInline = true;
      } else {
        element.alt = `Mídia do Story de ${story.author || 'usuário'}`;
      }
      media.append(element);
    }

    const evidenceLink = $('#storyViewerEvidence');
    const ownsStory = Number(story.userId) === Number(state.user?.id);
    evidenceLink.classList.toggle('hidden', !story.evidenceUrl || !ownsStory);
    if (story.evidenceUrl && ownsStory) evidenceLink.href = story.evidenceUrl;
    $('#deleteStoryButton').classList.toggle('hidden', !ownsStory);
    $('#deleteStoryButton').onclick = async () => {
      try {
        const response = await fetch(`/api/stories/${encodeURIComponent(story.id)}`, { method: 'DELETE' });
        const result = response.status === 204 ? {} : await response.json();
        if (!response.ok) throw new Error(result.error || 'Não foi possível excluir o Story.');
        state.stories = state.stories.filter((item) => String(item.id) !== String(story.id));
        closeModal('storyViewerModal');
        renderStories();
        toast('Story excluído.');
      } catch (error) {
        toast(error.message || 'Não foi possível excluir o Story.');
      }
    };
    openModal('storyViewerModal');
  }

  $('#newStoryButton')?.addEventListener('click', () => {
    $('#storyForm').reset();
    $('#storyFormError').textContent = '';
    $('#storyAlertFields').classList.add('hidden');
    $('#storyForm').elements.reportNumber.required = false;
    $('#storyForm').elements.reportDate.required = false;
    $('#storyEvidenceInput').required = false;
    openModal('storyComposerModal');
  });

  $('#storyIsAlert')?.addEventListener('change', (event) => {
    const enabled = event.currentTarget.checked;
    $('#storyAlertFields').classList.toggle('hidden', !enabled);
    $('#storyForm').elements.reportNumber.required = enabled;
    $('#storyForm').elements.reportDate.required = enabled;
    $('#storyEvidenceInput').required = enabled;
  });

  $('#storyForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const mediaFile = $('#storyMediaInput').files[0];
    const evidenceFile = $('#storyEvidenceInput').files[0];
    const isAlert = $('#storyIsAlert').checked;
    const totalBytes = (mediaFile?.size || 0) + (evidenceFile?.size || 0);
    const submit = form.querySelector('button[type="submit"]');
    const error = $('#storyFormError');
    error.textContent = '';
    if (mediaFile && mediaFile.size > 4 * 1024 * 1024) {
      error.textContent = 'A mídia do Story deve ter até 4 MB.';
      return;
    }
    if (totalBytes > 10 * 1024 * 1024) {
      error.textContent = 'A soma da mídia e do BO deve ter até 10 MB.';
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Publicando…';
    try {
      const media = mediaFile ? {
        fileName: mediaFile.name,
        mimeType: mediaFile.type,
        data: await fileAsBase64(mediaFile),
      } : undefined;
      const reportEvidence = isAlert && evidenceFile ? {
        fileName: evidenceFile.name,
        mimeType: evidenceFile.type,
        data: await fileAsBase64(evidenceFile),
      } : undefined;
      const response = await fetch('/api/stories', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          content: String(data.get('content') || '').trim(),
          category: String(data.get('category') || 'Comunidade'),
          isAlert,
          media,
          reportNumber: isAlert ? String(data.get('reportNumber') || '').trim() : undefined,
          reportDate: isAlert ? String(data.get('reportDate') || '') : undefined,
          reportEvidence,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível publicar o Story.');
      state.stories = [result, ...(state.stories || [])];
      renderStories();
      form.reset();
      $('#storyAlertFields').classList.add('hidden');
      $('#storyForm').elements.reportNumber.required = false;
      $('#storyForm').elements.reportDate.required = false;
      $('#storyEvidenceInput').required = false;
      closeModal('storyComposerModal');
      toast(isAlert ? 'Alerta com BO publicado por 24 horas.' : 'Story publicado por 24 horas.');
    } catch (submitError) {
      error.textContent = submitError.message || 'Não foi possível publicar o Story.';
    } finally {
      submit.disabled = false;
      submit.innerHTML = 'Publicar Story <span>→</span>';
    }
  });

  function loadFeedMedia() {
    $('#feedList')
      ?.querySelectorAll('[data-media-for]')
      .forEach(async (container) => {
        const postId = container.dataset.mediaFor;
        const post = state.communityFeed.find((item) => String(item.id) === postId);
        if (!post) return;
        for (const media of post.media || []) {
          try {
            const response = await fetch(
              `/api/feed/${encodeURIComponent(postId)}/media/${encodeURIComponent(media.id)}`,
              {
                headers: {},
              }
            );
            if (!response.ok) throw new Error('Mídia indisponível.');
            const blob = await response.blob();
            if (!container.isConnected) continue;
            const url = URL.createObjectURL(blob);
            feedMediaUrls.add(url);
            const element =
              media.mediaType === 'video'
                ? document.createElement('video')
                : document.createElement('img');
            element.src = url;
            if (element instanceof HTMLVideoElement) {
              element.controls = true;
              element.playsInline = true;
              element.preload = 'metadata';
              element.setAttribute('aria-label', `Vídeo publicado por ${post.author}`);
            } else {
              element.alt = `Foto publicada por ${post.author}`;
              element.loading = 'lazy';
            }
            container.replaceChildren(element);
          } catch {
            container.textContent = 'Não foi possível carregar esta mídia.';
            container.classList.add('media-error');
          }
        }
      });
  }

  function renderAlerts() {
    const list = $('#alertList');
    if (!list) return;
    const alerts = state.alerts || [];
    const urgentCount = alerts.filter((alert) =>
      ['high', 'critical'].includes(alert.severity)
    ).length;
    $('#alertsTotalCount').textContent = String(alerts.length);
    $('#alertsUrgentCount').textContent = String(urgentCount);
    list.innerHTML = alerts.length
      ? alerts
          .map(
            (alert) => {
              const severity = ['low', 'medium', 'high', 'critical'].includes(alert.severity)
                ? alert.severity
                : 'low';
              const severityLabel = {
                critical: 'Crítico',
                high: 'Alto',
                medium: 'Médio',
                low: 'Baixo',
              }[severity];
              return `
          <article class="alert-card ${severity}">
            <div class="alert-top">
              <span class="alert-badge ${severity}"><span aria-hidden="true"></span>${severityLabel}</span>
              <span class="alert-recorded-at">${safe(alert.time || 'agora')}</span>
            </div>
            <h3>${safe(alert.title)}</h3>
            <div class="alert-meta">${safe(alert.summary || 'Registro de monitoramento')}</div>
            <p>${safe(alert.details)}</p>
            ${alert.location ? `<div class="alert-location"><span aria-hidden="true">⌖</span>${safe(alert.location)}</div>` : ''}
            <div class="alert-footer">
              <span><span class="alert-footer-dot" aria-hidden="true"></span>Registrado ${safe(alert.time || 'agora')}</span>
              <span>Privado</span>
            </div>
          </article>
        `;
            }
          )
          .join('')
      : `<div class="feed-empty alert-empty">
          <span class="empty-icon" aria-hidden="true">⚑</span>
          <span class="alert-empty-kicker">TUDO ORGANIZADO</span>
          <h3>Nenhum alerta registrado</h3>
          <p>Seus registros aparecerão aqui. Você também pode criar um alerta para guardar uma informação importante.</p>
          <button type="button" class="btn primary" data-create-first-alert>Criar primeiro alerta <span aria-hidden="true">→</span></button>
        </div>`;
    list.querySelector('[data-create-first-alert]')?.addEventListener('click', () => {
      $('#createAlertBtn').click();
    });
  }

  function renderSettings() {
    const list = $('#settingsList');
    if (!list) return;
    const entries = Object.entries(state.settings || defaultSettings);
    list.innerHTML = entries
      .map(
        ([key, value]) => `
          <label class="toggle-item">
            <div>
              <strong>${safe(value.label || key)}</strong>
              <small>${safe(value.description || '')}</small>
            </div>
            <span class="switch">
              <input type="checkbox" data-setting-name="${key}" ${value.value ? 'checked' : ''} />
              <span class="slider"></span>
            </span>
          </label>
        `
      )
      .join('');
    list.querySelectorAll('[data-setting-name]').forEach((input) => {
      input.addEventListener('change', (event) => {
        const name = event.target.dataset.settingName;
        if (!state.settings[name]) return;
        const previous = state.settings[name].value;
        state.settings[name].value = event.target.checked;
        fetch('/api/settings', {
          method: 'PUT',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ settings: { [name]: event.target.checked } }),
        }).then(async (response) => {
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || 'Não foi possível salvar.');
          persist();
        }).catch((error) => {
          state.settings[name].value = previous;
          event.target.checked = previous;
          toast(error.message || 'Não foi possível salvar a configuração.');
        });
      });
    });
    const profileName = $('#profileNameInput');
    const profileEmail = $('#profileEmailInput');
    const profileBio = $('#profileBioInput');
    if (profileName && state.user) {
      profileName.value = state.user.name || '';
      profileEmail.value = state.user.email || '';
      profileBio.value = state.user.bio || '';
    }
  }

  $('#feedForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const text = String(form.get('text') || '').trim();
    const file = form.get('media');
    const submitButton = formElement.querySelector('button[type="submit"]');
    if (!text && !(file instanceof File && file.size)) {
      toast('Escreva uma legenda ou escolha uma foto/vídeo para compartilhar.');
      return;
    }
    if (file instanceof File && file.size > 4 * 1024 * 1024) {
      toast('O arquivo deve ter até 4 MB.');
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = 'Enviando…';
    (async () => {
      try {
        let media;
        if (file instanceof File && file.size) {
          const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(',')[1]);
            reader.onerror = () => reject(new Error('Não foi possível ler o arquivo selecionado.'));
            reader.readAsDataURL(file);
          });
          media = { fileName: file.name, mimeType: file.type, data };
        }
        const response = await fetch('/api/feed', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            content: text,
            category: String(form.get('type') || 'Comunidade'),
            media,
          }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Não foi possível publicar.');
        state.communityFeed = [result, ...(state.communityFeed || [])];
        formElement.reset();
        $('#feedMediaPreview').classList.add('hidden');
        renderFeed();
        loadReputation();
        toast('Publicação compartilhada com a comunidade.');
      } catch (error) {
        toast(error.message || 'Falha ao publicar no feed.');
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Compartilhar';
      }
    })();
  });

  $('#siteFeedbackForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const comment = form.elements.comment.value.trim();
    const submitButton = form.querySelector('button[type="submit"]');
    if (!comment) {
      $('#siteFeedbackStatus').textContent = 'Escreva um comentário antes de enviar.';
      return;
    }
    submitButton.disabled = true;
    submitButton.textContent = 'Enviando…';
    try {
      const response = await fetch('/api/reputation/feedback', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ comment }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível enviar seu comentário.');
      $('#siteFeedbackStatus').textContent = result.message;
      toast(result.message);
    } catch (error) {
      $('#siteFeedbackStatus').textContent = error.message || 'Falha ao enviar comentário.';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Enviar comentário';
    }
  });

  $('#feedMediaInput')?.addEventListener('change', (event) => {
    const file = event.currentTarget.files[0];
    const preview = $('#feedMediaPreview');
    preview.replaceChildren();
    if (!file) {
      preview.classList.add('hidden');
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      event.currentTarget.value = '';
      preview.classList.add('hidden');
      toast('O arquivo deve ter até 4 MB.');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/webm'].includes(file.type)) {
      event.currentTarget.value = '';
      preview.classList.add('hidden');
      toast('Escolha uma foto JPG, PNG ou WebP, ou vídeo MP4 ou WebM.');
      return;
    }
    const url = URL.createObjectURL(file);
    feedMediaUrls.add(url);
    const element = file.type.startsWith('video/')
      ? document.createElement('video')
      : document.createElement('img');
    element.src = url;
    if (element instanceof HTMLVideoElement) {
      element.controls = true;
      element.muted = true;
      element.playsInline = true;
    } else {
      element.alt = 'Prévia da foto escolhida';
    }
    preview.append(element);
    preview.classList.remove('hidden');
  });

  $('#profileForm')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (!state.user) return;
    const updatedUser = {
      name: String(form.get('name') || state.user.name || 'Usuário').trim(),
      email: String(form.get('email') || state.user.email || '').trim(),
      bio: String(form.get('bio') || '').trim(),
    };
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(updatedUser),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Não foi possível atualizar o perfil.');
      Object.assign(state.user, updatedUser);
      persist();
      $('#userName').textContent = updatedUser.name;
      $('#userEmail').textContent = updatedUser.email;
      $('#userAvatar').textContent = updatedUser.name.charAt(0).toUpperCase();
      $('#topAvatar').textContent = updatedUser.name.charAt(0).toUpperCase();
      toast('Perfil atualizado.');
    } catch (error) {
      toast(error.message || 'Não foi possível atualizar o perfil.');
    }
  });

  $('#createAlertBtn')?.addEventListener('click', () => {
    $('#alertForm').reset();
    $('#alertFormError').textContent = '';
    openModal('alertModal');
  });

  $('#alertForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const title = String(form.get('title') || '').trim();
    if (!title) {
      $('#alertFormError').textContent = 'Informe o motivo do alerta.';
      return;
    }
    const alert = {
      id: Date.now(),
      severity: String(form.get('severity') || 'medium'),
      title,
      summary: title,
      time: new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }),
      details: String(form.get('details') || '').trim() || 'Sem detalhes adicionais.',
      location: String(form.get('location') || '').trim(),
    };
    state.alerts = [alert, ...(state.alerts || [])];
    const localNotification = {
      id: `local-${alert.id}`,
      titulo: 'Alerta registrado',
      mensagem: `${alert.title} foi salvo neste dispositivo.`,
      lida: false,
      createdAt: new Date().toISOString(),
      categoria: 'alert',
      local: true,
    };
    state.localNotifications = [localNotification, ...(state.localNotifications || [])].slice(
      0,
      100
    );
    persist();
    renderAlerts();
    loadNotifications(true);
    closeModal('alertModal');
    toast('Alerta registrado neste dispositivo.');
  });

  $('#supportBtn')?.addEventListener('click', () => {
    toast('Suporte acionado. Seu pedido foi registrado localmente e será revisado em breve.');
  });

  function renderNotifications() {
    const list = $('#notificationList');
    const unreadCount = state.notifications.filter((item) => !item.lida).length;
    const count = $('#notificationCount');
    count.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    count.classList.toggle('hidden', unreadCount === 0);
    $('#notificationBtn').setAttribute(
      'aria-label',
      unreadCount ? `Notificações, ${unreadCount} não lidas` : 'Abrir notificações'
    );
    if (!state.notifications.length) {
      list.innerHTML = `
        <div class="notification-empty">
          <span aria-hidden="true">✓</span>
          <strong>Tudo em dia</strong>
          <p>Quando houver novidades importantes, elas aparecerão aqui.</p>
        </div>`;
      return;
    }
    list.innerHTML = state.notifications
      .map((item) => {
        const category = ['message', 'contact', 'camera', 'alert'].includes(item.categoria)
          ? item.categoria
          : 'system';
        const icon = {
          message: '✉',
          contact: '♧',
          camera: '▣',
          alert: '⚑',
          system: '•',
        }[category];
        const date = new Date(item.createdAt);
        const dateLabel = Number.isNaN(date.getTime())
          ? ''
          : new Intl.DateTimeFormat('pt-BR', {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            }).format(date);
        return `
          <button type="button" class="notification-item ${item.lida ? '' : 'unread'}" data-notification-id="${safe(item.id)}" data-notification-category="${category}">
            <span class="notification-item-icon" aria-hidden="true">${icon}</span>
            <span class="notification-item-copy">
              <span class="notification-item-heading">${safe(item.titulo)}</span>
              <span class="notification-item-message">${safe(item.mensagem)}</span>
              <span class="notification-item-date">${safe(dateLabel)}</span>
            </span>
            ${item.lida ? '' : '<span class="notification-unread-dot" aria-label="Não lida"></span>'}
          </button>`;
      })
      .join('');
  }
  async function loadNotifications(silent = false) {
    if (!state.user || notificationSyncInProgress) return;
    notificationSyncInProgress = true;
    try {
      const response = await fetch('/api/notifications');
      const notifications = await response.json();
      if (!response.ok)
        throw new Error(notifications.error || 'Não foi possível carregar notificações.');
      state.notifications = [
        ...notifications.map((item) => ({
          ...item,
          lida: item.lida === true || Number(item.lida) === 1,
          local: false,
        })),
        ...(state.localNotifications || []),
      ]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 100);
      renderNotifications();
    } catch (error) {
      if (!silent) toast(error.message || 'Não foi possível carregar notificações.');
      else console.error('Notification refresh failed:', error);
    } finally {
      notificationSyncInProgress = false;
    }
  }
  async function markNotificationRead(notification) {
    if (notification.lida) return;
    if (notification.local) {
      notification.lida = true;
      state.localNotifications = state.localNotifications.map((item) =>
        String(item.id) === String(notification.id) ? notification : item
      );
      persist();
      renderNotifications();
      return;
    }
    const response = await fetch(
      `/api/notifications/${encodeURIComponent(notification.id)}/read`,
      { method: 'PUT' }
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || 'Não foi possível atualizar a notificação.');
    notification.lida = true;
    renderNotifications();
  }
  function navigateFromNotification(category, notification) {
    const destination = notification.local
      ? 'alerts'
      : {
      message: 'messages',
      contact: 'contacts',
      camera: 'cameras',
      alert: 'feed',
      system: 'overview',
    }[category] || 'overview';
    closeNotificationPanel();
    showView(destination);
  }
  function closeNotificationPanel() {
    $('#notificationPanel').classList.add('hidden');
    $('#notificationBtn').setAttribute('aria-expanded', 'false');
  }
  $('#notificationBtn').onclick = async () => {
    const panel = $('#notificationPanel');
    const isOpening = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !isOpening);
    $('#notificationBtn').setAttribute('aria-expanded', String(isOpening));
    if (isOpening) await loadNotifications();
  };
  $('#notificationList').addEventListener('click', async (event) => {
    const itemButton = event.target.closest('[data-notification-id]');
    if (!itemButton) return;
    const notification = state.notifications.find(
      (item) => String(item.id) === itemButton.dataset.notificationId
    );
    if (!notification) return;
    try {
      await markNotificationRead(notification);
      navigateFromNotification(itemButton.dataset.notificationCategory, notification);
    } catch (error) {
      toast(error.message || 'Não foi possível abrir a notificação.');
    }
  });
  $('#markAllNotificationsRead').onclick = async () => {
    try {
      const response = await fetch('/api/notifications/read-all', { method: 'PUT' });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error || 'Não foi possível atualizar as notificações.');
      state.notifications.forEach((item) => (item.lida = true));
      state.localNotifications = state.localNotifications.map((item) => ({ ...item, lida: true }));
      persist();
      renderNotifications();
    } catch (error) {
      toast(error.message || 'Não foi possível atualizar as notificações.');
    }
  };
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.notification-anchor')) closeNotificationPanel();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') loadNotifications(true);
  });
  $('#profileButton').onclick = () =>
    toast('Perfil: ' + (state.user?.name || state.user?.email || 'Usuário'));
  async function resumeSession() {
    try {
      const response = await fetch('/api/auth/session');
      if (!response.ok) throw new Error('Sessão não encontrada.');
      const result = await response.json();
      state.user = result.usuario;
      startApp();
    } catch {
      const saved = load();
      if (saved.user?.token) {
        delete saved.user.token;
        localStorage.setItem(STORE, JSON.stringify(saved));
      }
      showAuth(false);
    }
  }
  resumeSession();
})();
