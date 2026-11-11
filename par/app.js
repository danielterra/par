const $ = id => document.getElementById(id);
const call = document.querySelector('.call');
const links = new Map();
const mediaOrder = ['audio', 'camera', 'screen'];
const videoInputs = {
  camera: {
    label: 'Câmera', start: 'Ligar câmera', stop: 'Desligar câmera', method: 'getUserMedia',
    options: { video: { width: { ideal: 1280 }, height: { ideal: 720 } } },
  },
  screen: {
    label: 'Tela', start: 'Compartilhar tela', stop: 'Parar compartilhamento', method: 'getDisplayMedia',
    options: {
      video: { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 15 } },
      audio: { restrictOwnAudio: true },
      systemAudio: 'include',
      windowAudio: 'system',
      selfBrowserSurface: 'exclude',
    },
  },
};
const codeLimit = 65536;
const defaultIceServers = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const fragment = new URLSearchParams(location.hash.slice(1));
const roomPattern = /^[A-Za-z0-9_-]{16}$/;
const invitedRoom = fragment.get('sala');
const roomUrl = new URL('./', location.href);
roomUrl.hash = '';
roomUrl.search = '';

let session;
let mic;
let micBusy = false;
let busy = false;
let avatarBusy = false;
const avatarSize = 128;
const avatarLimit = 24000;
const profileNameKey = 'par.name';
const profileAvatarKey = 'par.avatar';

function readPreference(key) {
  try { return localStorage.getItem(key) ?? ''; }
  catch { return ''; }
}

function savePreference(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // The profile still works in this tab when browser storage is unavailable.
  }
}

function validAvatar(image) {
  return typeof image === 'string' && image.length <= avatarLimit &&
    /^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(image);
}

const savedAvatar = readPreference(profileAvatarKey);
let profileAvatar = validAvatar(savedAvatar) ? savedAvatar : '';

function validDescription(description, kind) {
  return description?.type === kind && typeof description.sdp === 'string' && description.sdp.length < 44000;
}

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_');
}

function inviteUrl(room) {
  const url = new URL(roomUrl);
  url.hash = new URLSearchParams({ sala: room });
  return url.href;
}

async function roomRequest(current, action, details = {}, keepalive = false) {
  const response = await fetch(new URL('room', roomUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Par-Client': '1' },
    body: JSON.stringify({ action, room: current.room, id: current.id, token: current.token, ...details }),
    signal: AbortSignal.timeout(8000),
    keepalive,
  });
  const data = await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(data.error || 'O serviço de salas não respondeu. Tente novamente.'), { status: response.status });
  }
  return data;
}

function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

function render() {
  const connected = [...links.values()].filter(isOpen);
  const relayed = connected.filter(link => link.relayed).length;
  $('status').textContent = connected.length
    ? relayed
      ? connected.length + (connected.length === 1 ? ' conexão' : ' conexões') + ' · ' + relayed + ' via TURN'
      : connected.length + (connected.length === 1 ? ' conexão direta' : ' conexões diretas')
    : session ? ([...links.values()].some(link => link.reconnecting) ? 'Reconectando…'
      : links.size ? 'Conectando aos participantes…' : 'Aguardando participantes') : 'Desconectado';
  $('dot').classList.toggle('online', connected.length > 0);
  const turnReady = session?.iceExpiry > Date.now();
  $('turn-status').hidden = !session?.turnConfigured;
  $('turn-status').textContent = turnReady ? 'TURN disponível' : 'TURN indisponível nesta sessão';
  $('setup').hidden = Boolean(session);
  $('start').disabled = busy || avatarBusy || !window.RTCPeerConnection || !window.crypto?.randomUUID;
  $('reset').hidden = !session;
  call.hidden = !session;
  $('share').hidden = !session;
  $('participants').hidden = !session;
  renderParticipants();
  $('send').disabled = !connected.length;
  $('attach').disabled = !connected.length;
  $('message').disabled = !connected.length;
  $('message').placeholder = connected.length ? 'Escreva aqui' : 'Aguardando participantes';
  renderControl('mic', mic, mic ? 'Desativar microfone' : 'Ativar microfone', micBusy, navigator.mediaDevices?.getUserMedia);
  for (const [kind, input] of Object.entries(videoInputs)) {
    renderControl(kind, input.track, input.track ? input.stop : input.start, input.busy, navigator.mediaDevices?.[input.method]);
  }
  const supportsSources = Boolean(session && navigator.mediaDevices?.enumerateDevices && navigator.mediaDevices?.getUserMedia);
  $('mic-source').disabled = !supportsSources || micBusy || Boolean(session?.sourceBusy);
  $('camera-source').disabled = !supportsSources || videoInputs.camera.busy || Boolean(session?.sourceBusy);
  $('screen-label').textContent = videoInputs.screen.audioTrack ? 'Tela + áudio' : 'Tela';
  renderProfile();
}

function renderControl(id, active, action, pending, supported) {
  const button = $(id);
  button.disabled = !session || pending || !supported;
  button.setAttribute('aria-label', action);
  button.setAttribute('aria-pressed', Boolean(active));
  button.title = supported ? action : 'Este navegador não oferece este recurso.';
}

function renderParticipants() {
  const people = $('people');
  const entries = session ? [
    [session.name + ' (você)', 'Conectado', true, null],
    ...[...links.values()].map(link => [
      link.name, isOpen(link) ? 'Conectado' : link.reconnecting ? 'Reconectando…' : 'Conectando…', isOpen(link), link.id, Boolean(link.audio.srcObject),
    ]),
  ] : [];
  const signature = JSON.stringify(entries);
  if (people.dataset.signature === signature) return;
  people.dataset.signature = signature;
  people.replaceChildren(...entries.map(([name, status, connected, id]) => {
    const item = document.createElement('li');
    const label = document.createElement('strong');
    const indicator = document.createElement('span');
    label.textContent = name;
    indicator.textContent = status;
    item.classList.toggle('connected', connected);
    item.append(label, indicator);
    if (id) {
      const link = links.get(id);
      const controls = document.createElement('div');
      controls.className = 'peer-audio-controls';
      const volume = document.createElement('input');
      volume.type = 'range';
      volume.min = '0';
      volume.max = '100';
      volume.value = String(link.volume);
      volume.disabled = !link.audio.srcObject;
      volume.setAttribute('aria-label', 'Volume de ' + name);
      volume.setAttribute('aria-valuetext', volume.value + '%');
      volume.oninput = () => {
        link.volume = Number(volume.value);
        volume.setAttribute('aria-valuetext', volume.value + '%');
        void applyPeerVolume(link).catch(() => notice('O navegador não conseguiu ajustar este volume.'));
      };
      controls.append(mutePeerButton(link), volume);
      item.append(controls);
    }
    return item;
  }));
}

async function prepareIce(current) {
  if (current.iceExpiry > Date.now() + 60000) return;
  current.iceServers = defaultIceServers;
  try {
    const endpoint = new URL('turn', roomUrl);
    const result = await fetch(endpoint, {
      method: 'POST',
      cache: 'no-store',
      signal: AbortSignal.timeout(7000),
      headers: { 'X-Par-Client': '1' },
    });
    if (current !== session) return;
    current.turnConfigured = result.status !== 404;
    if (!result.ok) return;
    const { iceServers, ttl } = await result.json();
    current.iceServers = [...defaultIceServers, ...iceServers];
    current.iceExpiry = Date.now() + ttl * 1000;
  } catch {
    // STUN and direct candidates remain available when TURN fails.
  }
}

function updateRoute(link) {
  const pair = link.pc.sctp?.transport.iceTransport?.getSelectedCandidatePair?.();
  if (!pair) return;
  link.relayed = pair.local.type === 'relay' || pair.remote.type === 'relay';
  render();
}

let unreadMessages = 0;

function updateUnread() {
  const badge = $('chat-unread');
  badge.textContent = unreadMessages > 99 ? '99+' : String(unreadMessages);
  badge.hidden = !unreadMessages;
  $('view-chat').setAttribute('aria-label', unreadMessages ? 'Chat, ' + unreadMessages + (unreadMessages === 1 ? ' mensagem nova' : ' mensagens novas') : 'Chat');
}

function selectCallView(view) {
  call.dataset.view = view;
  $('view-stage').setAttribute('aria-pressed', String(view === 'stage'));
  $('view-chat').setAttribute('aria-pressed', String(view === 'chat'));
  if (view === 'chat') {
    unreadMessages = 0;
    updateUnread();
    $('messages').scrollTop = $('messages').scrollHeight;
  }
}

$('view-stage').onclick = () => selectCallView('stage');
$('view-chat').onclick = () => selectCallView('chat');

function updateCallHeight() {
  const viewport = window.visualViewport;
  if (viewport && Math.abs(viewport.scale - 1) < 0.01) {
    const messages = $('messages');
    const atEnd = messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 8;
    call.parentElement.style.setProperty('--call-height', Math.floor(viewport.height) + 'px');
    if (atEnd && call.dataset.view === 'chat') messages.scrollTop = messages.scrollHeight;
  }
}

window.visualViewport?.addEventListener('resize', updateCallHeight);
updateCallHeight();

function markUnread() {
  if (!$('call-chat').getClientRects().length && call.dataset.view === 'stage') {
    unreadMessages++;
    updateUnread();
  }
}

function appendMessage(author, message) {
  const item = document.createElement('li');
  const name = document.createElement('strong');
  name.textContent = author;
  item.append(name, document.createTextNode(message));
  $('messages').append(item);
  $('messages').scrollTop = $('messages').scrollHeight;
  return item;
}

function isOpen(link) {
  return link?.channel?.readyState === 'open' && !link.reconnecting &&
    !['disconnected', 'failed', 'closed'].includes(link.pc.connectionState);
}

function send(link, packet) {
  if (!isOpen(link)) return;
  try {
    link.channel.send(JSON.stringify(packet));
  } catch {
    notice('Uma conexão ficou indisponível durante o envio.');
  }
}

function attachChannel(current, link, channel) {
  link.channel = channel;
  channel.binaryType = 'arraybuffer';
  const pc = link.pc;
  const isCurrent = () => current === session && links.get(link.id) === link &&
    link.pc === pc && link.channel === channel;
  channel.onopen = () => {
    if (!isCurrent()) return;
    peerConnected(link);
    const iceTransport = pc.sctp?.transport.iceTransport;
    iceTransport?.addEventListener('selectedcandidatepairchange', () => {
      if (isCurrent()) updateRoute(link);
    });
    updateRoute(link);
    sendVideoState(link);
    if (current.avatar) send(link, { type: 'avatar', image: current.avatar });
    render();
  };
  channel.onclose = () => {
    if (isCurrent()) requestPeerRecovery(current, link, 1000);
  };
  channel.onmessage = ({ data }) => {
    if (!isCurrent()) return;
    if (data instanceof ArrayBuffer) {
      receiveFileChunk(link, data);
      return;
    }
    if (typeof data !== 'string' || data.length > codeLimit) return;
    let packet;
    try {
      packet = JSON.parse(data);
    } catch {
      return;
    }
    if (!packet || typeof packet !== 'object') return;
    if (typeof packet.type === 'string' && packet.type.startsWith('file-')) {
      handleFilePacket(current, link, packet);
      return;
    }
    if (packet.type === 'chat' && typeof packet.message === 'string' && packet.message.length <= 2000 && packet.message.trim()) {
      appendMessage(link.name, packet.message);
      markUnread();
      return;
    }
    if (packet.type === 'avatar' && validAvatar(packet.image)) {
      showAvatar(link.tile.photo, packet.image);
      return;
    }
    if (packet.type === 'video') {
      link.cameraActive = packet.camera === true;
      link.screenActive = packet.screen === true;
      if (link.screen) {
        link.screen.hidden = !link.screenActive;
        if (link.screen.hidden && expandedScreen?.card === link.screen) collapseScreen();
      }
      showCamera(link.tile, link.cameraActive, link.screen);
      watchRemoteVideo(current, link);
      return;
    }
  };
}

let expandedScreen;

function collapseScreen() {
  if (!expandedScreen) return;
  const { card, button } = expandedScreen;
  expandedScreen = undefined;
  if (document.fullscreenElement === card) void document.exitFullscreen().catch(() => {});
  card.classList.remove('expanded');
  button.textContent = 'Tela cheia';
  button.setAttribute('aria-pressed', 'false');
}

async function expandScreen(card, button) {
  if (expandedScreen?.card === card) {
    collapseScreen();
    return;
  }
  collapseScreen();
  expandedScreen = { card, button };
  button.textContent = 'Sair da tela cheia';
  button.setAttribute('aria-pressed', 'true');
  try {
    if (card.requestFullscreen) await card.requestFullscreen();
    else card.classList.add('expanded');
  } catch {
    if (expandedScreen?.card === card) card.classList.add('expanded');
  }
}

document.addEventListener('fullscreenchange', () => {
  if (expandedScreen && !document.fullscreenElement && !expandedScreen.card.classList.contains('expanded')) collapseScreen();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') collapseScreen();
});

function mediaVideo(track) {
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  if (track) video.srcObject = new MediaStream([track]);
  return video;
}

function initials(name) {
  return name.trim().split(/\s+/u).slice(0, 2).map(word => Array.from(word)[0]).join('').toLocaleUpperCase('pt-BR');
}

function showAvatar(photo, image) {
  photo.hidden = !image;
  if (image && photo.getAttribute('src') !== image) photo.src = image;
  if (!image && photo.hasAttribute('src')) photo.removeAttribute('src');
}

function renderProfile() {
  $('profile-initials').textContent = initials($('name').value) || '?';
  showAvatar($('profile-preview').querySelector('img'), profileAvatar);
  $('avatar-file').disabled = avatarBusy || busy;
  $('remove-avatar').hidden = !profileAvatar;
  $('remove-avatar').disabled = avatarBusy || busy;
}

async function optimizeAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (!side) throw new Error('Imagem inválida.');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = avatarSize;
    const context = canvas.getContext('2d');
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2,
      side, side, 0, 0, avatarSize, avatarSize);
    const result = canvas.toDataURL('image/jpeg', 0.72);
    if (!validAvatar(result)) throw new Error('A imagem não pôde ser reduzida.');
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function avatarNotice(message = '') {
  $('avatar-status').textContent = message;
  $('avatar-status').hidden = !message;
}

$('name').value = readPreference(profileNameKey).slice(0, 40);
$('name').oninput = renderProfile;
$('avatar-file').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(file.type) || file.size > 25 * 1024 * 1024) {
    avatarNotice('Escolha uma imagem JPEG, PNG, WebP, GIF ou AVIF de até 25 MB.');
    return;
  }
  avatarBusy = true;
  avatarNotice();
  render();
  try {
    profileAvatar = await optimizeAvatar(file);
    savePreference(profileAvatarKey, profileAvatar);
  } catch {
    avatarNotice('Não foi possível preparar essa foto. Tente outro arquivo.');
  } finally {
    avatarBusy = false;
    render();
  }
};
$('remove-avatar').onclick = () => {
  profileAvatar = '';
  savePreference(profileAvatarKey, '');
  avatarNotice();
  renderProfile();
  $('avatar-file').focus();
};

function participantTile(name, local = false) {
  const card = document.createElement('figure');
  card.className = 'participant-tile';
  const visual = document.createElement('div');
  visual.className = 'participant-visual';
  const avatar = document.createElement('span');
  avatar.className = 'participant-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = initials(name);
  const photo = document.createElement('img');
  photo.alt = '';
  showAvatar(photo, local ? profileAvatar : '');
  avatar.append(photo);
  const video = mediaVideo();
  video.hidden = true;
  const caption = document.createElement('figcaption');
  const title = document.createElement('span');
  title.textContent = local ? name + ' (você)' : name;
  caption.append(title);
  visual.append(avatar, video);
  card.append(visual, caption);
  $('tiles').append(card);
  return { card, visual, avatar, photo, video };
}

function showCamera(tile, active, screen) {
  tile.video.hidden = !active || !tile.video.srcObject;
  const overlay = !tile.video.hidden && screen && !screen.hidden;
  const target = overlay ? screen.querySelector('.screen-content') : tile.visual;
  if (tile.video.parentElement !== target) target.append(tile.video);
  tile.video.classList.toggle('camera-overlay', Boolean(overlay));
  tile.card.hidden = Boolean(overlay);
  tile.avatar.hidden = !tile.video.hidden;
}

function screenCard(track, label, hidden = false, fullscreen = false) {
  const card = document.createElement('figure');
  card.className = 'shared-screen';
  const visual = document.createElement('div');
  visual.className = 'screen-visual';
  const content = document.createElement('div');
  content.className = 'screen-content';
  const video = mediaVideo(track);
  video.className = 'screen-feed';
  video.addEventListener('resize', () => {
    if (video.videoWidth && video.videoHeight) {
      content.style.setProperty('--screen-ratio', video.videoWidth / video.videoHeight);
    }
  });
  content.append(video);
  visual.append(content);
  const caption = document.createElement('figcaption');
  const title = document.createElement('span');
  title.textContent = label;
  caption.append(title);
  if (fullscreen) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = 'Tela cheia';
    button.setAttribute('aria-pressed', 'false');
    button.onclick = () => expandScreen(card, button);
    caption.append(button);
  }
  card.hidden = hidden;
  card.append(visual, caption);
  $('videos').append(card);
  return card;
}

function sendVideoState(link) {
  send(link, {
    type: 'video',
    camera: Boolean(videoInputs.camera.track),
    screen: Boolean(videoInputs.screen.track),
  });
}

function localTrack(kind) {
  if (kind !== 'audio') return videoInputs[kind].track ?? null;
  if (session?.audioMix?.active) return session.audioMix.destination.stream.getAudioTracks()[0];
  return mic?.getAudioTracks()[0] ?? videoInputs.screen.audioTrack ?? null;
}

function updateAudio(current) {
  const displayAudio = videoInputs.screen.audioTrack;
  if (displayAudio && !current.audioMix) {
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    current.audioMix = { context, destination, sources: [], active: false };
  }
  const mix = current.audioMix;
  if (mix) {
    for (const source of mix.sources) source.disconnect();
    mix.sources = [];
    mix.active = false;
    if (displayAudio) {
      const microphone = mic?.getAudioTracks()[0];
      const tracks = microphone ? [displayAudio, microphone] : [displayAudio];
      for (const track of tracks) {
        const source = mix.context.createMediaStreamSource(new MediaStream([track]));
        // Leave headroom when multiple input tracks are active.
        const gain = mix.context.createGain();
        gain.gain.value = 1 / Math.sqrt(tracks.length);
        source.connect(gain);
        gain.connect(mix.destination);
        mix.sources.push(gain);
        mix.sources.push(source);
      }
      mix.active = true;
      void mix.context.resume().catch(() => {});
    }
  }
  return replaceLocalTrack('audio');
}

function attachLocalTracks(link) {
  return Promise.all(mediaOrder.map(kind => link.senders[kind].replaceTrack(localTrack(kind))));
}

function replaceLocalTrack(kind) {
  const track = localTrack(kind);
  const active = [...links.values()];
  return Promise.allSettled(active.map(link => link.senders[kind]?.replaceTrack(track))).then(results => {
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  });
}

function clearVideo(input) {
  input.track?.stop();
  input.audioTrack?.stop();
  input.track = undefined;
  input.audioTrack = undefined;
  input.preview?.remove();
  input.preview = undefined;
}

async function updateVideo(kind, current) {
  try {
    await Promise.all([
      replaceLocalTrack(kind),
      kind === 'screen' && updateAudio(current),
    ]);
  } catch {
    if (current === session) notice('Um participante não conseguiu receber toda a mídia compartilhada.');
  }
  if (current === session) renderLocalVideo(kind, current);
}

function renderLocalVideo(kind, current) {
  if (kind === 'camera') {
    const track = videoInputs.camera.track;
    current.tile.video.srcObject = track ? new MediaStream([track]) : null;
  }
  showCamera(current.tile, Boolean(videoInputs.camera.track), videoInputs.screen.preview);
  for (const link of links.values()) sendVideoState(link);
  render();
}

function watchVideoEnd(kind, current, track) {
  const input = videoInputs[kind];
  track.addEventListener('ended', () => {
    if (current !== session || input.track !== track) return;
    clearVideo(input);
    void updateVideo(kind, current);
  }, { once: true });
}

function captureOptions(kind, deviceId = '') {
  const base = kind === 'video' ? videoInputs.camera.options.video : {};
  return { [kind]: { ...base, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) } };
}

for (const [kind, input] of Object.entries(videoInputs)) {
  $(kind).onclick = async () => {
    const current = session;
    if (input.track) {
      clearVideo(input);
      await updateVideo(kind, current);
      return;
    }
    input.busy = true;
    notice();
    render();
    try {
      const options = kind === 'camera' ? captureOptions('video', current.sources.video) : input.options;
      const stream = await navigator.mediaDevices[input.method](options);
      const track = stream.getVideoTracks()[0];
      if (current !== session || !track || track.readyState === 'ended') {
        stream.getTracks().forEach(item => item.stop());
        return;
      }
      input.track = track;
      const audioTrack = stream.getAudioTracks()[0];
      if (kind === 'screen' && audioTrack?.readyState === 'live') {
        input.audioTrack = audioTrack;
        audioTrack.addEventListener('ended', () => {
          if (current !== session || input.audioTrack !== audioTrack) return;
          input.audioTrack = undefined;
          void updateVideo(kind, current);
        }, { once: true });
      } else if (kind === 'screen') {
        notice('Tela compartilhada sem áudio. Para enviar som, escolha uma fonte com opção de áudio.');
      }
      if (kind === 'screen') input.preview = screenCard(track, input.label + ' · Você');
      watchVideoEnd(kind, current, track);
      await updateVideo(kind, current);
    } catch (error) {
      if (current === session && error.name !== 'NotAllowedError') {
        notice('O navegador não conseguiu iniciar ' + (kind === 'camera' ? 'a câmera.' : 'o compartilhamento de tela.'));
      }
    } finally {
      input.busy = false;
      render();
    }
  };
}

function dropPeer(id) {
  const link = links.get(id);
  links.delete(id);
  closePeerMedia(link);
  link.tile.card.remove();
}

function closePeerMedia(link) {
  closeFileTransfers(link);
  clearTimeout(link.recoveryTimer);
  clearTimeout(link.videoTimer);
  link.recoveryTimer = undefined;
  link.videoTimer = undefined;
  link.channel = undefined;
  link.pc.close();
  link.playbackSource?.disconnect();
  link.playbackGain?.disconnect();
  link.playbackSource = undefined;
  link.playbackGain = undefined;
  link.audio.srcObject = null;
  link.audio.remove();
  link.tile.video.srcObject = null;
  showCamera(link.tile, false);
  if (link.screen) {
    if (expandedScreen?.card === link.screen) collapseScreen();
    link.screen.remove();
    link.screen = undefined;
  }
  link.cameraActive = false;
  link.screenActive = false;
  link.relayed = false;
  updateListen();
}

function updateMuteButton(button, link) {
  const action = (link.muted ? 'Reativar áudio de ' : 'Silenciar ') + link.name;
  button.setAttribute('aria-label', action);
  button.setAttribute('aria-pressed', String(link.muted));
  button.title = action;
}

function mutePeerButton(link) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary peer-mute';
  button.dataset.mute = link.id;
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/><path class="sound-wave" d="M16 9a4 4 0 0 1 0 6m3-9a8 8 0 0 1 0 12"/><path class="sound-muted" d="m16 10 5 5m0-5-5 5"/></svg>';
  updateMuteButton(button, link);
  button.onclick = () => {
    link.muted = !link.muted;
    for (const control of document.querySelectorAll('[data-mute="' + CSS.escape(link.id) + '"]')) {
      updateMuteButton(control, link);
    }
    void applyPeerVolume(link).catch(() => notice('O navegador não conseguiu atualizar este áudio.'));
  };
  return button;
}

async function applyPeerVolume(link) {
  const level = link.volume / 100;
  const audio = link.audio;
  audio.muted = link.muted || level === 0 || Boolean(link.playbackGain);
  if (!link.playbackGain) {
    audio.volume = level;
    if (audio.volume === level || !audio.srcObject || level === 0) return;
    const current = session;
    const context = current.playbackContext ??= new AudioContext();
    await context.resume();
    if (session !== current || links.get(link.id) !== link || !audio.srcObject) return;
    if (!link.playbackGain) {
      link.playbackSource = context.createMediaStreamSource(audio.srcObject);
      link.playbackGain = context.createGain();
      link.playbackGain.gain.value = 0;
      link.playbackSource.connect(link.playbackGain).connect(context.destination);
    }
    audio.muted = true;
  }
  link.playbackGain.gain.value = link.muted ? 0 : link.volume / 100;
  if (link.playbackGain.gain.value && link.playbackGain.context.state !== 'running') {
    await link.playbackGain.context.resume();
  }
}

function updateListen() {
  $('listen').hidden = ![...links.values()].some(link => link.audio.srcObject && link.audio.paused);
}

function newLink(current, { id, name }) {
  const audio = document.createElement('audio');
  audio.autoplay = true;
  const link = { id, name, audio, volume: 100, muted: false, tile: participantTile(name) };
  link.tile.card.querySelector('figcaption').append(mutePeerButton(link));
  links.set(id, link);
  startPeerConnection(current, link);
  return link;
}

function startPeerConnection(current, link) {
  const pc = new RTCPeerConnection({ iceServers: current.iceServers ?? defaultIceServers });
  const { audio } = link;
  link.pc = pc;
  link.senders = {};
  const isCurrent = () => current === session && links.get(link.id) === link && link.pc === pc;
  pc.onconnectionstatechange = () => {
    if (!isCurrent()) return;
    if (pc.connectionState === 'connected' && link.channel?.readyState === 'open') {
      peerConnected(link);
    } else if (['failed', 'closed'].includes(pc.connectionState)) {
      requestPeerRecovery(current, link, 1000);
    } else if (pc.connectionState === 'disconnected') {
      requestPeerRecovery(current, link, 4000);
    }
    render();
  };
  pc.ondatachannel = ({ channel }) => { if (isCurrent()) attachChannel(current, link, channel); };
  pc.ontrack = ({ track, transceiver }) => {
    if (!isCurrent()) return;
    const kind = mediaOrder[pc.getTransceivers().indexOf(transceiver)];
    if (kind === 'camera') {
      link.tile.video.srcObject = new MediaStream([track]);
      showCamera(link.tile, link.cameraActive, link.screen);
      for (const event of ['mute', 'unmute', 'ended']) {
        track.addEventListener(event, () => { if (isCurrent()) watchRemoteVideo(current, link); });
      }
      watchRemoteVideo(current, link);
      return;
    }
    if (kind === 'screen') {
      link.screen = screenCard(track, 'Tela · ' + link.name, !link.screenActive, true);
      link.screen.querySelector('figcaption').append(mutePeerButton(link));
      showCamera(link.tile, link.cameraActive, link.screen);
      for (const event of ['mute', 'unmute', 'ended']) {
        track.addEventListener(event, () => { if (isCurrent()) watchRemoteVideo(current, link); });
      }
      watchRemoteVideo(current, link);
      return;
    }
    if (kind !== 'audio') return;
    $('videos').after(audio);
    audio.srcObject = new MediaStream([track]);
    void applyPeerVolume(link).catch(() => {});
    renderParticipants();
    audio.play().then(updateListen, updateListen);
  };
  armPeerRecovery(current, link, 25000);
}

async function gather(pc, description) {
  await pc.setLocalDescription(description);
  if (pc.iceGatheringState !== 'complete') {
    await new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(finish, 8000);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }
  return pc.localDescription.toJSON();
}

async function makeOffer(current, link) {
  const { pc } = link;
  for (const kind of mediaOrder) {
    link.senders[kind] = pc.addTransceiver(kind === 'audio' ? 'audio' : 'video', { direction: 'sendrecv' }).sender;
  }
  attachChannel(current, link, pc.createDataChannel('chat'));
  await attachLocalTracks(link);
  return gather(pc, await pc.createOffer());
}

async function makeAnswer(link, description) {
  const { pc } = link;
  await pc.setRemoteDescription(description);
  const transceivers = pc.getTransceivers();
  if (transceivers.length !== mediaOrder.length) throw new Error('Mídia incompatível.');
  for (const [index, kind] of mediaOrder.entries()) {
    transceivers[index].direction = 'sendrecv';
    link.senders[kind] = transceivers[index].sender;
  }
  await attachLocalTracks(link);
  return gather(pc, await pc.createAnswer());
}

function relay(current, link, description) {
  if (current === session && links.get(link.id) === link) {
    current.outbox.push({ id: crypto.randomUUID(), to: link.id, description });
    scheduleSync(current, 0);
  }
}

function queuePeer(current, link, task) {
  link.signaling = (link.signaling ?? Promise.resolve()).then(() => {
    if (current === session && links.get(link.id) === link) return task();
  }).catch(() => {
    if (current === session && links.get(link.id) === link) requestPeerRecovery(current, link, 5000);
  });
}

function peerConnected(link) {
  clearTimeout(link.recoveryTimer);
  link.recoveryTimer = undefined;
  link.reconnecting = false;
}

function armPeerRecovery(current, link, delay) {
  clearTimeout(link.recoveryTimer);
  const timer = setTimeout(() => queuePeer(current, link, async () => {
    if (link.recoveryTimer !== timer) return;
    link.recoveryTimer = undefined;
    link.reconnecting = true;
    render();
    if (current.id < link.id) {
      await refreshPeerIce(current);
      if (current !== session || links.get(link.id) !== link || !link.reconnecting) return;
      closePeerMedia(link);
      startPeerConnection(current, link);
      await negotiate(current, link);
    } else {
      relay(current, link, { type: 'restart', attempt: link.attempt ?? null });
      armPeerRecovery(current, link, 25000);
    }
  }), delay);
  link.recoveryTimer = timer;
}

function requestPeerRecovery(current, link, delay) {
  if (link.reconnecting && link.recoveryTimer) return;
  link.reconnecting = true;
  armPeerRecovery(current, link, delay);
  render();
}

function refreshPeerIce(current) {
  if (current.iceExpiry > Date.now() + 60000 || current.iceRetryAt > Date.now()) {
    return current.iceRefresh;
  }
  current.iceRetryAt = Date.now() + 30000;
  current.iceRefresh = prepareIce(current).finally(() => { current.iceRefresh = undefined; });
  return current.iceRefresh;
}

function remoteVideoMuted(link) {
  const stalled = video => {
    const track = video?.srcObject?.getVideoTracks()[0];
    return track && (track.muted || track.readyState === 'ended');
  };
  return (link.cameraActive && stalled(link.tile.video)) ||
    (link.screenActive && stalled(link.screen?.querySelector('.screen-feed')));
}

function watchRemoteVideo(current, link) {
  if (!remoteVideoMuted(link)) {
    clearTimeout(link.videoTimer);
    link.videoTimer = undefined;
    return;
  }
  if (link.videoTimer) return;
  link.videoTimer = setTimeout(() => {
    link.videoTimer = undefined;
    if (current === session && links.get(link.id) === link && remoteVideoMuted(link)) {
      requestPeerRecovery(current, link, 1000);
    }
  }, 10000);
}

async function negotiate(current, link) {
  const attempt = crypto.randomUUID();
  link.attempt = attempt;
  const offer = await makeOffer(current, link);
  relay(current, link, { ...offer, attempt });
}

async function handleSignal(current, link, description) {
  if (current.id < link.id) {
    if (description?.type === 'restart' && description.attempt === link.attempt) {
      requestPeerRecovery(current, link, 1000);
    } else if (validDescription(description, 'answer') &&
        (description.attempt === link.attempt || (!description.attempt && !link.reconnecting)) &&
        link.pc.signalingState === 'have-local-offer') {
      await link.pc.setRemoteDescription(description);
    }
    return;
  }
  if (!validDescription(description, 'offer')) return;
  if (description.attempt && description.attempt === link.attempt) return;
  if (link.senders.audio || link.pc.signalingState !== 'stable') {
    if (!description.attempt) return;
    link.reconnecting = true;
    await refreshPeerIce(current);
    if (current !== session || links.get(link.id) !== link) return;
    closePeerMedia(link);
    startPeerConnection(current, link);
  }
  link.attempt = description.attempt;
  const answer = await makeAnswer(link, description);
  relay(current, link, { ...answer, attempt: link.attempt });
}

function updateRoster(current, peers) {
  const present = new Set(peers.map(peer => peer.id));
  for (const id of links.keys()) {
    if (!present.has(id)) dropPeer(id);
  }
  for (const peer of peers) {
    if (links.has(peer.id)) continue;
    const link = newLink(current, peer);
    if (current.id < peer.id) queuePeer(current, link, () => negotiate(current, link));
  }
  render();
}

function scheduleSync(current, delay = 2000) {
  if (current !== session || current.syncing) return;
  clearTimeout(current.timer);
  current.timer = setTimeout(() => syncRoom(current), delay);
}

async function syncRoom(current) {
  current.syncing = true;
  const outbox = current.outbox.slice(0, 8);
  let delay = 2000;
  try {
    const result = await roomRequest(current, 'sync', { cursor: current.cursor, outbox });
    if (current !== session) return;
    if (current.offline) notice();
    current.offline = false;
    current.outbox.splice(0, outbox.length);
    updateRoster(current, result.peers);
    for (const signal of result.signals) {
      if (current !== session) return;
      current.cursor = signal.seq;
      const link = links.get(signal.sender);
      if (!link) continue;
      const description = JSON.parse(signal.description);
      queuePeer(current, link, () => handleSignal(current, link, description));
    }
    if (current.outbox.length) delay = 0;
  } catch (error) {
    if (current !== session) return;
    if (error.status === 410) {
      leave();
      notice(error.message);
      return;
    }
    current.offline = true;
    notice('A sinalização está temporariamente indisponível. Tentando reconectar…');
    delay = 5000;
  } finally {
    current.syncing = false;
    scheduleSync(current, delay);
  }
}

function leave(resetAddress = false) {
  if (!session) return;
  const current = session;
  session = undefined;
  clearTimeout(current.timer);
  void roomRequest(current, 'leave', {}, true).catch(() => {});
  for (const id of links.keys()) dropPeer(id);
  mic?.getTracks().forEach(track => track.stop());
  mic = undefined;
  $('source-dialog').close();
  for (const input of Object.values(videoInputs)) clearVideo(input);
  current.tile.card.remove();
  $('participants').open = false;
  for (const url of current.fileDownloads ?? []) URL.revokeObjectURL(url);
  $('messages').replaceChildren();
  unreadMessages = 0;
  updateUnread();
  selectCallView('stage');
  $('message').value = '';
  if (resetAddress && !roomPattern.test(invitedRoom)) history.replaceState(null, '', roomUrl);
  if (current.audioMix) void current.audioMix.context.close().catch(() => {});
  if (current.playbackContext) void current.playbackContext.close().catch(() => {});
  notice();
  render();
}

$('entry').onsubmit = async event => {
  event.preventDefault();
  if (busy || avatarBusy || session) return;
  const name = $('name').value.trim();
  if (!name) {
    notice('Informe o nome que você quer exibir.');
    $('name').focus();
    return;
  }
  const joining = roomPattern.test(invitedRoom);
  const current = {
    name, avatar: profileAvatar, room: joining ? invitedRoom : newRoomId(), id: crypto.randomUUID(),
    token: crypto.randomUUID(), cursor: 0, outbox: [], sources: { audio: '', video: '' },
  };
  busy = true;
  notice(joining ? 'Entrando na sala…' : 'Criando a sala…');
  render();
  try {
    await roomRequest(current, joining ? 'join' : 'create', { name });
    session = current;
    savePreference(profileNameKey, current.name);
    current.tile = participantTile(current.name, true);
    history.replaceState(null, '', inviteUrl(current.room));
    render();
    await prepareIce(current);
    if (current !== session) return;
    notice();
    scheduleSync(current, 0);
  } catch (error) {
    notice(error.message || 'Não foi possível acessar a sala. Tente novamente.');
  } finally {
    busy = false;
    render();
  }
};

$('reset').onclick = () => leave(true);
addEventListener('pagehide', () => leave());

$('share').onclick = async () => {
  if (!session) return;
  const url = inviteUrl(session.room);
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Convite para o Par', url });
      return;
    } catch (error) {
      if (error.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    notice('Link da sala copiado.');
  } catch {
    notice('Copie o endereço desta página para compartilhar a sala.');
  }
};

$('composer').onsubmit = event => {
  event.preventDefault();
  const message = $('message').value.trim();
  if (!message) return;
  let sent = 0;
  for (const link of links.values()) {
    if (!isOpen(link)) continue;
    try {
      link.channel.send(JSON.stringify({ type: 'chat', message }));
      sent++;
    } catch {
      notice('Uma conexão ficou indisponível durante o envio.');
    }
  }
  if (sent) {
    appendMessage(session.name + ' (você)', message);
    $('message').value = '';
  }
};

$('mic').onclick = async () => {
  const current = session;
  micBusy = true;
  render();
  try {
    if (mic) {
      mic.getTracks().forEach(track => track.stop());
      mic = undefined;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia(captureOptions('audio', current.sources.audio));
      if (current !== session) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      mic = stream;
    }
    await updateAudio(current);
  } catch {
    if (current === session) notice('O navegador não conseguiu ativar ou atualizar o microfone.');
  } finally {
    micBusy = false;
    render();
  }
};

const sourceLabels = { audio: 'Microfone', video: 'Câmera' };
let sourceKind;

function activeCapture(kind) {
  return kind === 'audio' ? mic?.getAudioTracks()[0] : videoInputs.camera.track;
}

function renderSourceDialog() {
  const pending = Boolean(session?.sourceBusy);
  for (const id of ['source-device', 'source-apply', 'source-refresh']) $(id).disabled = pending;
  const track = activeCapture(sourceKind);
  $('source-current').textContent = track?.label ? 'Em uso: ' + track.label
    : 'A fonte escolhida será usada ao ligar o dispositivo.';
}

async function listSources(probeLabels = false) {
  const current = session;
  if (!current || current.sourceBusy) return;
  const kind = sourceKind;
  current.sourceBusy = true;
  renderSourceDialog();
  render();
  let probe;
  try {
    const list = async () => (await navigator.mediaDevices.enumerateDevices())
      .filter(device => device.kind === kind + 'input' && device.deviceId);
    let devices = await list();
    if (probeLabels && !activeCapture(kind) && (!devices.length || devices.some(device => !device.label))) {
      probe = await navigator.mediaDevices.getUserMedia(captureOptions(kind));
      if (current !== session) return;
      devices = await list();
    }
    if (current !== session) return;
    const select = $('source-device');
    const selected = current.sources[kind];
    select.replaceChildren(new Option('Padrão do sistema', ''), ...devices.map((device, index) =>
      new Option(device.label || 'Dispositivo ' + (index + 1), device.deviceId)));
    if (selected && !devices.some(device => device.deviceId === selected)) {
      select.add(new Option('Dispositivo selecionado indisponível', selected));
    }
    select.value = selected;
    $('source-status').textContent = !devices.length || devices.some(device => !device.label)
      ? 'Use Atualizar lista para identificar os dispositivos. O navegador pode pedir permissão.'
      : '';
  } catch {
    if (current === session) $('source-status').textContent = 'Não foi possível listar os dispositivos. Confira a permissão do navegador.';
  } finally {
    probe?.getTracks().forEach(track => track.stop());
    current.sourceBusy = false;
    if (current === session) {
      renderSourceDialog();
      render();
    }
  }
}

function openSources(kind) {
  sourceKind = kind;
  $('source-title').textContent = sourceLabels[kind];
  $('source-status').textContent = '';
  $('source-dialog').showModal();
  void listSources();
}

$('mic-source').onclick = () => openSources('audio');
$('camera-source').onclick = () => openSources('video');
$('source-refresh').onclick = () => void listSources(true);

async function switchCapture(current, kind, deviceId) {
  const previousMic = mic;
  const previous = activeCapture(kind);
  const stream = await navigator.mediaDevices.getUserMedia(captureOptions(kind, deviceId));
  const track = (kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks())[0];
  if (current !== session || !track || track.readyState !== 'live') {
    stream.getTracks().forEach(item => item.stop());
    if (current === session) throw new Error('Dispositivo indisponível.');
    return;
  }
  const audio = kind === 'audio';
  if (audio) mic = stream;
  else videoInputs.camera.track = track;
  const apply = () => audio ? updateAudio(current) : replaceLocalTrack('camera');
  try {
    await apply();
  } catch (error) {
    if (current === session) {
      if (audio) mic = previousMic;
      else videoInputs.camera.track = previous;
      await apply().catch(() => {});
    }
    stream.getTracks().forEach(item => item.stop());
    throw error;
  }
  previous?.stop();
  if (current !== session) return;
  if (!audio) {
    watchVideoEnd('camera', current, track);
    renderLocalVideo('camera', current);
  }
}

$('source-apply').onclick = async () => {
  const current = session;
  if (!current || current.sourceBusy) return;
  const kind = sourceKind;
  const deviceId = $('source-device').value;
  current.sourceBusy = true;
  renderSourceDialog();
  render();
  try {
    if (activeCapture(kind) && deviceId !== current.sources[kind]) await switchCapture(current, kind, deviceId);
    if (current !== session) return;
    current.sources[kind] = deviceId;
    $('source-dialog').close();
  } catch {
    if (current === session) $('source-status').textContent = 'Não foi possível usar esse dispositivo. Confira a conexão e a permissão.';
  } finally {
    current.sourceBusy = false;
    if (current === session) {
      renderSourceDialog();
      render();
    }
  }
};

$('listen').onclick = async () => {
  await Promise.allSettled([...links.values()].map(({ audio }) => audio.srcObject && audio.play()));
  updateListen();
};

if (roomPattern.test(invitedRoom)) {
  $('setup-title').textContent = 'Entre na sala';
  $('instructions').textContent = 'Escolha como quer aparecer para os outros participantes.';
  $('start').textContent = 'Entrar na sala';
} else if (location.hash) {
  notice('Este convite é inválido ou pertence a uma versão anterior. Peça um novo link ou crie uma sala.');
}
if (!window.RTCPeerConnection || !window.crypto?.randomUUID) {
  notice('Abra o Par por HTTPS em um navegador com suporte a WebRTC.');
}
render();
