import { DEFAULT_EVENT_ANIMATION } from './animation-settings.js';

const $ = (selector) => document.querySelector(selector);
const base = `${location.protocol}//${location.host}`;
const sendNow = $('#sendNow');
let dashboardTargetsInitialized = false;

$('#normalUrl').textContent = `${base}/overlay/feed`;
$('#persistUrl').textContent = `${base}/overlay/feed?persist=1&limit=8`;
$('#customUrl').textContent = `${base}/overlay/feed?limit=5&platform=twitch&events=chat,sub,resub,gift,reward`;
$('#chatConsoleUrl').textContent = `${base}/chat`;
$('#twitchRedirect').textContent = `http://localhost:${location.port || 4242}/auth/twitch/callback`;
$('#youtubeRedirect').textContent = `http://localhost:${location.port || 4242}/auth/youtube/callback`;

function setOverlayPreviewAnimations(enabled) {
  const frame = $('#preview');
  frame.contentWindow?.postMessage({
    type: 'overlay-preview-animations',
    enabled: Boolean(enabled)
  }, location.origin);
}

const params = new URLSearchParams(location.search);
if (params.get('twitchConnected') === '1') flash('Twitch est autorisé. Les permissions chat + rewards ont été mises à jour.', 'success');
if (params.get('twitchError')) flash(params.get('twitchError'), 'errorbox');
if (params.get('youtubeConnected') === '1') flash('YouTube est autorisé pour envoyer des messages dans le live chat.', 'success');
if (params.get('youtubeError')) flash(params.get('youtubeError'), 'errorbox');
if (params.size) history.replaceState(null, '', '/');

const animationInputs = {
  fps: $('#animFps'),
  trailLength: $('#animTrail'),
  orbitDuration: $('#animOrbit'),
  orbSize: $('#animOrb'),
  glowIntensity: $('#animGlow'),
  eventDuration: $('#animDuration')
};

const animationValueNodes = {
  fps: $('#animFpsValue'),
  trailLength: $('#animTrailValue'),
  orbitDuration: $('#animOrbitValue'),
  orbSize: $('#animOrbValue'),
  glowIntensity: $('#animGlowValue'),
  eventDuration: $('#animDurationValue')
};

let savedAnimation = null;

function flash(text, type = 'notice') {
  $('#flash').innerHTML = `<div class="notice ${type}">${escapeHtml(text)}</div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function renderStatus(target, status) {
  const state = status?.state || 'needs-config';
  const detail = status?.detail || 'Pas encore démarré';
  const channel = status?.channel ? ` — ${status.channel}` : '';
  target.innerHTML = `<span class="dot ${state}"></span><span>${escapeHtml(detail + channel)}</span>`;
}

function renderCapability(target, ok, connectedText, missingText) {
  target.innerHTML = ok
    ? `<strong>● ${escapeHtml(connectedText)}</strong>`
    : `○ ${escapeHtml(missingText)}`;
  target.style.color = ok ? '#80dfa0' : '#b3b6bf';
}

function setAnimationForm(settings) {
  const merged = { ...DEFAULT_EVENT_ANIMATION, ...(settings || {}) };
  animationInputs.fps.value = String(merged.fps);
  animationInputs.trailLength.value = String(merged.trailLength);
  animationInputs.orbitDuration.value = String(merged.orbitDuration);
  animationInputs.orbSize.value = String(merged.orbSize);
  animationInputs.glowIntensity.value = String(Math.round(Number(merged.glowIntensity) * 100));
  animationInputs.eventDuration.value = String(merged.eventDuration);
  renderAnimationValues();
}

function getAnimationForm() {
  return {
    fps: Number(animationInputs.fps.value),
    trailLength: Number(animationInputs.trailLength.value),
    orbitDuration: Number(animationInputs.orbitDuration.value),
    orbSize: Number(animationInputs.orbSize.value),
    glowIntensity: Number(animationInputs.glowIntensity.value) / 100,
    eventDuration: Number(animationInputs.eventDuration.value)
  };
}

function renderAnimationValues() {
  const v = getAnimationForm();
  animationValueNodes.fps.textContent = `${v.fps} FPS`;
  animationValueNodes.trailLength.textContent = `${v.trailLength} px`;
  animationValueNodes.orbitDuration.textContent = `${(v.orbitDuration / 1000).toFixed(1)} s`;
  animationValueNodes.orbSize.textContent = `${v.orbSize.toFixed(1)} px`;
  animationValueNodes.glowIntensity.textContent = `${Math.round(v.glowIntensity * 100)} %`;
  animationValueNodes.eventDuration.textContent = `${Math.round(v.eventDuration / 1000)} s`;
}

function previewPost(type = 'settings') {
  if (!$('#animationPreviewEnabled').checked) return;
  const frame = $('#animationPreview');
  frame.contentWindow?.postMessage({ type, settings: getAnimationForm() }, '*');
}

function setPreviewEnabled(enabled) {
  const frame = $('#animationPreview');
  frame.hidden = !enabled;
  if (enabled) {
    if (!frame.src || frame.src === 'about:blank') frame.src = '/animation-preview.html';
    else previewPost('settings');
  } else {
    // Supprime complètement le document animé : aucune RAF/canvas ne reste actif.
    frame.src = 'about:blank';
  }
}

async function loadStatus({ syncForm = false, syncAnimation = false } = {}) {
  try {
    const data = await fetch('/api/status', { cache: 'no-store' }).then(r => r.json());
    const c = data.config;

    // Ne synchroniser les champs qu'au chargement : le polling 2,5 s ne doit jamais
    // écraser ce que l'utilisateur est en train de taper.
    if (syncForm) {
      $('#twitchEnabled').checked = c.twitch.enabled;
      $('#twitchClientId').value = c.twitch.clientId || '';
      $('#twitchChannel').value = c.twitch.channelLogin || '';
      $('#youtubeEnabled').checked = c.youtube.enabled;
      $('#youtubeVideoId').value = c.youtube.videoId || '';
      $('#youtubeOauthClientId').value = c.youtube.oauthClientId || '';
    }

    if (syncAnimation || !savedAnimation) {
      savedAnimation = { ...c.overlay.eventAnimation };
      setAnimationForm(savedAnimation);
    }

    $('#twitchClientSecret').placeholder = c.twitch.hasClientSecret ? 'secret enregistré — laisser vide pour le conserver' : 'Client Secret requis';
    $('#disconnectTwitch').disabled = !c.twitch.authenticated;
    $('#youtubeApiKey').placeholder = c.youtube.hasApiKey ? 'clé enregistrée — laisser vide pour la conserver' : 'Clé API requise';
    $('#youtubeOauthClientSecret').placeholder = c.youtube.hasOauthClientSecret ? 'secret OAuth enregistré — laisser vide pour le conserver' : 'Client Secret OAuth requis';
    $('#disconnectYouTube').disabled = !c.youtube.sendAuthenticated;

    renderStatus($('#twitchStatus'), data.statuses.twitch);
    renderStatus($('#youtubeStatus'), data.statuses.youtube);

    const twitchSend = Boolean(data.capabilities?.twitchSend);
    const youtubeSend = Boolean(data.capabilities?.youtubeSend);
    const twitchRewards = Boolean(data.capabilities?.twitchRewards);
    renderCapability($('#twitchSendAuth'), twitchSend, 'Envoi Twitch autorisé', 'Envoi Twitch non autorisé — reconnecte Twitch pour user:write:chat');
    renderCapability($('#twitchRewardAuth'), twitchRewards, 'Rewards Channel Points connectées', 'Rewards non autorisées — reconnecte Twitch pour channel:read:redemptions');
    renderCapability($('#youtubeSendAuth'), youtubeSend, 'Envoi YouTube autorisé', 'Envoi YouTube non autorisé — configure puis connecte OAuth');

    applyDashboardTargetCapabilities(twitchSend, youtubeSend);
    if (data.version) {
      $('#appVersion').textContent = `V${data.version}`;
      $('#eventsVersion').textContent = `V${data.version}`;
      document.title = `OBS Chat Prototype V${data.version}`;
    }
  } catch (error) {
    console.error(error);
  }
}

async function saveConfig(body) {
  const response = await fetch('/api/config', {
    method: 'POST',
    headers: {'content-type':'application/json'},
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Erreur de configuration');
  await loadStatus();
}

$('#saveTwitch').onclick = async () => {
  try {
    const secret = $('#twitchClientSecret').value.trim();
    await saveConfig({twitch:{
      enabled: $('#twitchEnabled').checked,
      clientId: $('#twitchClientId').value,
      clientSecret: secret,
      channelLogin: $('#twitchChannel').value
    }});
    $('#twitchClientSecret').value = '';
    flash('Configuration Twitch enregistrée.', 'success');
  } catch (e) { flash(e.message, 'errorbox'); }
};

$('#saveYouTube').onclick = async () => {
  try {
    const key = $('#youtubeApiKey').value.trim();
    const oauthSecret = $('#youtubeOauthClientSecret').value.trim();
    await saveConfig({youtube:{
      enabled: $('#youtubeEnabled').checked,
      apiKey: key,
      videoId: $('#youtubeVideoId').value,
      oauthClientId: $('#youtubeOauthClientId').value,
      oauthClientSecret: oauthSecret
    }});
    $('#youtubeApiKey').value = '';
    $('#youtubeOauthClientSecret').value = '';
    flash('Configuration YouTube enregistrée. Le lecteur de chat tente la connexion.', 'success');
  } catch (e) { flash(e.message, 'errorbox'); }
};

$('#disconnectTwitch').onclick = async () => {
  await fetch('/api/twitch/disconnect', {method:'POST'});
  flash('Autorisation Twitch locale supprimée.', 'notice');
  await loadStatus();
};

$('#disconnectYouTube').onclick = async () => {
  await fetch('/api/youtube/disconnect', {method:'POST'});
  flash('Autorisation OAuth YouTube pour l’envoi supprimée. La lecture via clé API reste configurée.', 'notice');
  await loadStatus();
};

function dashboardSelectedTargets() {
  const targets = [];
  if (!$('#sendTwitch').disabled && $('#sendTwitch').checked) targets.push('twitch');
  if (!$('#sendYouTube').disabled && $('#sendYouTube').checked) targets.push('youtube');
  return targets;
}
function dashboardSyncBoth() {
  $('#sendBoth').checked = !$('#sendBoth').disabled && $('#sendTwitch').checked && $('#sendYouTube').checked;
  sendNow.disabled = dashboardSelectedTargets().length === 0;
}
function applyDashboardTargetCapabilities(twitchOk, youtubeOk) {
  $('#sendTwitch').disabled = !twitchOk;
  $('#sendYouTube').disabled = !youtubeOk;
  $('#sendBoth').disabled = !(twitchOk && youtubeOk);
  if (!twitchOk) $('#sendTwitch').checked = false;
  if (!youtubeOk) $('#sendYouTube').checked = false;
  if (!dashboardTargetsInitialized) {
    if (!$('#sendTwitch').checked && !$('#sendYouTube').checked) {
      if (twitchOk) $('#sendTwitch').checked = true;
      else if (youtubeOk) $('#sendYouTube').checked = true;
    }
    dashboardTargetsInitialized = true;
  }
  dashboardSyncBoth();
}
$('#sendTwitch').addEventListener('change', dashboardSyncBoth);
$('#sendYouTube').addEventListener('change', dashboardSyncBoth);
$('#sendBoth').addEventListener('change', () => {
  if ($('#sendBoth').disabled) return;
  $('#sendTwitch').checked = $('#sendBoth').checked;
  $('#sendYouTube').checked = $('#sendBoth').checked;
  dashboardSyncBoth();
});

async function sendReal(targets) {
  const message = $('#outgoingText').value.trim();
  if (!message) return flash('Écris un message avant de l’envoyer.', 'warn');
  try {
    const response = await fetch('/api/send-chat', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({targets, message})
    });
    const data = await response.json();
    if (!response.ok && response.status !== 207) throw new Error(data.error || 'Erreur d’envoi');

    const details = targets.map(target => {
      const item = data.results?.[target];
      const name = target === 'twitch' ? 'Twitch' : 'YouTube';
      return `${name}: ${item?.ok ? 'OK' : (item?.detail || 'échec')}`;
    });
    const allOk = targets.every(target => data.results?.[target]?.ok);
    flash(details.join(' — '), allOk ? 'success' : 'warn');
    if (allOk) $('#outgoingText').value = '';
    await loadStatus();
  } catch (e) {
    flash(e.message, 'errorbox');
  }
}

sendNow.onclick = () => { const targets = dashboardSelectedTargets(); if (targets.length) sendReal(targets); };
$('#outgoingText').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const targets = dashboardSelectedTargets();
    if (targets.length) sendReal(targets);
  }
});

async function sendFake(platform, first) {
  await fetch('/api/test-message', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({platform,text:$('#text').value,first})});
}
document.querySelectorAll('[data-platform]').forEach(b => b.onclick = () => sendFake(b.dataset.platform));
$('#fakeFirstStream').onclick = () => sendFake('twitch','stream');
$('#fakeFirstEver').onclick = () => sendFake('twitch','ever');
$('#fakeEvent').onclick = () => fetch('/api/test-event', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({style:$('#eventStyle').value,text:$('#text').value})});
$('#fakeReward').onclick = () => fetch('/api/test-reward', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:$('#text').value})});
$('#fakeBits').onclick = () => fetch('/api/test-bits', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:$('#text').value,bits:Number($('#fakeBitsAmount').value)})});
$('#random').onclick = () => sendFake(undefined);
$('#startAuto').onclick = () => fetch('/api/auto/start', {method:'POST'});
$('#stopAuto').onclick = () => fetch('/api/auto/stop', {method:'POST'});
$('#text').addEventListener('keydown', e => { if (e.key === 'Enter') sendFake(undefined); });

for (const input of Object.values(animationInputs)) {
  input.addEventListener('input', () => {
    renderAnimationValues();
    previewPost('settings');
  });
}

$('#animationPreviewEnabled').addEventListener('change', (event) => setPreviewEnabled(event.target.checked));
$('#animationPreview').addEventListener('load', () => previewPost('settings'));
$('#restartAnimationPreview').onclick = () => {
  if (!$('#animationPreviewEnabled').checked) {
    $('#animationPreviewEnabled').checked = true;
    setPreviewEnabled(true);
    return;
  }
  previewPost('restart');
};

$('#saveAnimation').onclick = async () => {
  try {
    const eventAnimation = getAnimationForm();
    const response = await fetch('/api/overlay-settings', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ eventAnimation })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Impossible de sauvegarder les réglages animation');
    savedAnimation = { ...data.eventAnimation };
    setAnimationForm(savedAnimation);
    previewPost('settings');
    flash('Réglages d’animation sauvegardés et appliqués à /feed, /chat et aux aperçus ouverts.', 'success');
  } catch (e) { flash(e.message, 'errorbox'); }
};

$('#resetAnimation').onclick = async () => {
  try {
    const response = await fetch('/api/overlay-settings', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ reset: true })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Impossible de restaurer les valeurs');
    savedAnimation = { ...data.eventAnimation };
    setAnimationForm(savedAnimation);
    previewPost('settings');
    flash('Valeurs d’animation par défaut restaurées.', 'success');
  } catch (e) { flash(e.message, 'errorbox'); }
};

$('#overlayPreviewAnimations').addEventListener('change', (event) => {
  setOverlayPreviewAnimations(event.target.checked);
});
$('#preview').addEventListener('load', () => {
  setOverlayPreviewAnimations($('#overlayPreviewAnimations').checked);
});

// L’aperçu overlay principal et l’aperçu de réglage sont explicitement OFF
// au chargement pour ne consommer aucune ressource d’animation inutile.
$('#overlayPreviewAnimations').checked = false;
$('#animationPreviewEnabled').checked = false;
setPreviewEnabled(false);
void loadStatus({ syncForm: true, syncAnimation: true });
setInterval(() => loadStatus(), 2500);
