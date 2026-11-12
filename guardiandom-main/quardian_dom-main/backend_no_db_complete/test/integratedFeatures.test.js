const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const { once } = require('node:events');

async function startServer(handler, t) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}/`;
}

test('persists social workflows, settings, profile, comments, and explicit camera visibility', async (t) => {
  process.env.DB_TYPE = 'sqlite';
  process.env.DB_PATH = ':memory:';
  process.env.JWT_SECRET = 'integrated-features-test-secret-0123456789';
  process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.RECORDINGS_DIRECTORY = require('node:os').tmpdir();

  const { get, ready, run } = require('../src/db');
  await ready;
  const firstUser = await run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', ['First User', 'first@example.test', 'unused']);
  const secondUser = await run('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)', ['Second User', 'second@example.test', 'unused']);
  const firstToken = jwt.sign({ id: firstUser.lastID }, process.env.JWT_SECRET);
  const secondToken = jwt.sign({ id: secondUser.lastID }, process.env.JWT_SECRET);

  const app = express();
  const realtimeEvents = [];
  app.set('io', {
    to: (room) => ({
      emit: (event, payload) => realtimeEvents.push({ room, event, payload }),
    }),
  });
  app.use(express.json({ limit: '15mb' }));
  app.use('/api/social', require('../src/routes/socialRoutes'));
  app.use('/api/feed', require('../src/routes/feedRoutes'));
  app.use('/api/stories', require('../src/routes/storyRoutes'));
  app.use('/api/profile', require('../src/routes/profileRoutes'));
  app.use('/api/reputation', require('../src/routes/reputationRoutes'));
  app.use('/api/settings', require('../src/routes/settingsRoutes'));
  app.use('/api/notifications', require('../src/routes/notificationRoutes'));
  app.use('/api/requests', require('../src/routes/requestRoutes'));
  app.use('/api/cameras', require('../src/routes/cameraRoutes'));
  const url = await startServer(app, t);
  const request = (path, token, options = {}) => fetch(`${url}api/${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  });

  const normalStory = await request('stories', firstToken, {
    method: 'POST',
    body: JSON.stringify({
      content: 'Relato de trânsito perto da praça',
      category: 'Trânsito',
      media: {
        fileName: 'story.png',
        mimeType: 'image/png',
        data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'),
      },
    }),
  });
  assert.equal(normalStory.status, 201);
  const normalStoryData = await normalStory.json();
  assert.equal(normalStoryData.hasMedia, true);
  assert.ok(normalStoryData.expiresAt > Date.now());

  const alertStory = await request('stories', firstToken, {
    method: 'POST',
    body: JSON.stringify({
      content: 'Ocorrência registrada com documento anexado',
      category: 'Aviso',
      isAlert: true,
      reportNumber: 'E2E-BO-2026-1',
      reportDate: '2026-01-01',
      reportEvidence: {
        fileName: 'comprovante.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.7\nStory test').toString('base64'),
      },
    }),
  });
  assert.equal(alertStory.status, 201);
  const alertStoryData = await alertStory.json();
  assert.equal(alertStoryData.isAlert, true);
  assert.equal(alertStoryData.reportStatus, 'BO anexado · não verificado');
  assert.equal('reportNumber' in alertStoryData, false);

  const recipientStories = await (await request('stories', secondToken)).json();
  const visibleAlertStory = recipientStories.find((story) => story.id === alertStoryData.id);
  assert.ok(visibleAlertStory);
  assert.equal(visibleAlertStory.evidenceUrl, null);
  const privateEvidence = await request(`stories/${alertStoryData.id}/evidence`, secondToken);
  assert.equal(privateEvidence.status, 404);
  const ownerEvidence = await request(`stories/${alertStoryData.id}/evidence`, firstToken);
  assert.equal(ownerEvidence.status, 200);
  assert.equal(Buffer.from(await ownerEvidence.arrayBuffer()).toString(), '%PDF-1.7\nStory test');
  const sharedStoryMedia = await request(`stories/${normalStoryData.id}/media`, secondToken);
  assert.equal(sharedStoryMedia.status, 200);
  assert.equal(Buffer.from(await sharedStoryMedia.arrayBuffer()).subarray(0, 4).toString('hex'), '89504e47');
  await run('UPDATE community_stories SET expires_at = ? WHERE id = ?', [Date.now() - 1, normalStoryData.id]);
  const activeStories = await (await request('stories', secondToken)).json();
  assert.equal(activeStories.some((story) => story.id === normalStoryData.id), false);
  assert.ok(!(await get('SELECT id FROM community_stories WHERE id = ?', [normalStoryData.id])));

  const inviteResponse = await request('social/contacts', firstToken, { method: 'POST', body: JSON.stringify({ email: 'second@example.test' }) });
  assert.equal(inviteResponse.status, 201);
  const invite = await inviteResponse.json();
  const incoming = await (await request('social/contacts', secondToken)).json();
  assert.equal(incoming[0].direction, 'incoming');
  const inviteNotifications = await (await request('notifications', secondToken)).json();
  assert.equal(inviteNotifications[0].categoria, 'contact');
  assert.equal(inviteNotifications[0].lida, false);
  const markAllRead = await request('notifications/read-all', secondToken, { method: 'PUT' });
  assert.equal(markAllRead.status, 200);
  assert.equal((await (await request('notifications', secondToken)).json())[0].lida, true);
  await request(`social/contacts/${invite.id}`, secondToken, { method: 'PATCH', body: JSON.stringify({ status: 'accepted' }) });
  const communityAlert = await request('stories', firstToken, {
    method: 'POST',
    body: JSON.stringify({
      content: 'Alerta importante perto da praça',
      category: 'Segurança',
      isAlert: true,
      reportNumber: 'E2E-CONTACT-ALERT',
      reportDate: '2026-01-01',
      reportEvidence: {
        fileName: 'alert.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.7\nContact alert').toString('base64'),
      },
    }),
  });
  assert.equal(communityAlert.status, 201);
  const communityAlertNotification = await (await request('notifications', secondToken)).json();
  assert.equal(communityAlertNotification[0].categoria, 'alert');
  assert.match(communityAlertNotification[0].mensagem, /Alerta importante perto da praça/);

  const direct = await (await request('social/conversations/direct', firstToken, { method: 'POST', body: JSON.stringify({ userId: secondUser.lastID }) })).json();
  const sent = await request(`social/conversations/${direct.id}/messages`, firstToken, { method: 'POST', body: JSON.stringify({ content: 'Mensagem persistente', media: { fileName: 'photo.png', mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71]).toString('base64') } }) });
  assert.equal(sent.status, 201);
  const peerMessages = await (await request(`social/conversations/${direct.id}/messages`, secondToken)).json();
  assert.equal(peerMessages[0].text, 'Mensagem persistente');
  assert.equal(peerMessages[0].media.length, 1);
  const videoSent = await request(
    `social/conversations/${direct.id}/messages`,
    firstToken,
    {
      method: 'POST',
      body: JSON.stringify({
        content: '',
        media: {
          fileName: 'clip.mp4',
          mimeType: 'video/mp4',
          data: Buffer.from('video-test').toString('base64'),
        },
      }),
    }
  );
  assert.equal(videoSent.status, 201);
  const videoMessage = await videoSent.json();
  const videoMedia = await request(
    `social/messages/${videoMessage.id}/media/${videoMessage.media[0].id}`,
    secondToken
  );
  assert.equal(videoMedia.status, 200);
  assert.equal(Buffer.from(await videoMedia.arrayBuffer()).toString(), 'video-test');
  assert.ok(realtimeEvents.some((item) =>
    item.room === String(secondUser.lastID) &&
    item.event === 'message:received' &&
    item.payload.message.text === 'Mensagem persistente'
  ));
  assert.ok(realtimeEvents.some((item) =>
    item.room === String(secondUser.lastID) &&
    item.event === 'notification:new' &&
    item.payload.title === 'Nova mensagem'
  ));
  const incrementalMessages = await (await request(
    `social/conversations/${direct.id}/messages?after=${videoMessage.id}`,
    secondToken
  )).json();
  assert.equal(incrementalMessages.length, 0);
  const secondSent = await request(
    `social/conversations/${direct.id}/messages`,
    firstToken,
    { method: 'POST', body: JSON.stringify({ content: 'Nova mensagem em tempo real' }) }
  );
  assert.equal(secondSent.status, 201);
  const nextIncrementalMessages = await (await request(
    `social/conversations/${direct.id}/messages?after=${videoMessage.id}`,
    secondToken
  )).json();
  assert.equal(nextIncrementalMessages.length, 1);
  assert.equal(nextIncrementalMessages[0].text, 'Nova mensagem em tempo real');
  const outsiderToken = jwt.sign({ id: 99999 }, process.env.JWT_SECRET);
  assert.equal((await request(`social/conversations/${direct.id}/messages`, outsiderToken)).status, 404);
  const groupResponse = await request('social/groups', firstToken, { method: 'POST', body: JSON.stringify({ name: 'Neighborhood', members: [secondUser.lastID] }) });
  assert.equal(groupResponse.status, 201);
  const group = await groupResponse.json();
  const groupConversations = await (await request('social/conversations', firstToken)).json();
  assert.equal(groupConversations.filter((item) => item.type === 'group').length, 1);
  assert.equal((await request(`social/conversations/${group.conversationId}/messages`, secondToken)).status, 200);
  await request(`social/contacts/${invite.id}`, secondToken, { method: 'DELETE' });
  assert.equal((await request(`social/conversations/${direct.id}/messages`, firstToken)).status, 404);

  const post = await run('INSERT INTO community_posts (user_id, category, content) VALUES (?, ?, ?)', [firstUser.lastID, 'Comunidade', 'Teste']);
  const comment = await request(`feed/${post.lastID}/comments`, secondToken, { method: 'POST', body: JSON.stringify({ content: 'Comentário gravado' }) });
  assert.equal(comment.status, 201);
  const feed = await (await request('feed', firstToken)).json();
  assert.equal(feed[0].comments[0].text, 'Comentário gravado');

  const profile = await request('profile', firstToken, { method: 'PUT', body: JSON.stringify({ name: 'Updated User', email: 'first@example.test', bio: 'Persisted bio' }) });
  assert.equal(profile.status, 200);
  assert.equal((await get('SELECT bio FROM users WHERE id = ?', [firstUser.lastID])).bio, 'Persisted bio');
  const cookieProfile = await fetch(`${url}api/profile`, { headers: { Cookie: `token=${encodeURIComponent(firstToken)}` } });
  assert.equal(cookieProfile.status, 200);
  const cookieReputation = await fetch(`${url}api/reputation`, { headers: { Cookie: `token=${encodeURIComponent(firstToken)}` } });
  assert.equal(cookieReputation.status, 200);
  await request('settings', firstToken, { method: 'PUT', body: JSON.stringify({ settings: { notifications: false } }) });
  assert.equal((await (await request('settings', firstToken)).json()).notifications, false);

  await run(`INSERT INTO managed_cameras (id, owner_id, name, location, latitude, longitude, encrypted_report_number, report_date, encrypted_source, path_name, release_status, is_public)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 1)`, ['camera-public-1', firstUser.lastID, 'Entrance', 'Private address', 12.5, 23.5, 'unused', '2026-01-01', 'unused', 'path-test']);
  const publicCameras = await (await request('cameras/public', secondToken)).json();
  assert.equal(publicCameras.length, 1);
  assert.equal(publicCameras[0].location, 'Private address');
  assert.equal('path_name' in publicCameras[0], false);
  const accessRequest = await request('requests/solicitar', secondToken, { method: 'POST', body: JSON.stringify({ cameraId: 'camera-public-1' }) });
  assert.equal(accessRequest.status, 201);
  const requests = await (await request('requests', firstToken)).json();
  const pendingRequest = requests.find((item) => item.requesterId === secondUser.lastID);
  assert.ok(pendingRequest);
  const blockedRecordings = await request('cameras/camera-public-1/recordings', secondToken);
  assert.equal(blockedRecordings.status, 404);
  const unauthorizedApproval = await request(`requests/aprovar/${pendingRequest.id}`, secondToken, { method: 'PUT' });
  assert.equal(unauthorizedApproval.status, 403);
  const approval = await request(`requests/aprovar/${pendingRequest.id}`, firstToken, { method: 'PUT' });
  assert.equal(approval.status, 200);
  const accessibleRecordings = await request('cameras/camera-public-1/recordings', secondToken);
  assert.equal(accessibleRecordings.status, 200);
  const sharedCameras = await (await request('cameras/shared', secondToken)).json();
  assert.equal(sharedCameras[0].sharedAccess, true);
  const notifications = await (await request('notifications', secondToken)).json();
  assert.ok(notifications.some((item) => item.mensagem.includes('aprovou')));
  const revoked = await request(`requests/revogar/${pendingRequest.id}`, firstToken, { method: 'PUT' });
  assert.equal(revoked.status, 200);
  assert.equal((await request('cameras/camera-public-1/recordings', secondToken)).status, 404);
});
