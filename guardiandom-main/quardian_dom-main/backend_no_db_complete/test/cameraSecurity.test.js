const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  assertAllowedRtspUrl,
  decryptSecret,
  encryptSecret,
  isPrivateIPv4,
  migrateStoredCameraSecrets,
  validateEncryptionKey,
} = require('../src/services/cameraSecurity');

const originalEnvironment = {
  CAMERA_ENCRYPTION_KEY: process.env.CAMERA_ENCRYPTION_KEY,
  CAMERA_LEGACY_ENCRYPTION_KEY: process.env.CAMERA_LEGACY_ENCRYPTION_KEY,
  CAMERA_CREDENTIALS_KEY: process.env.CAMERA_CREDENTIALS_KEY,
  CAMERA_ALLOWED_NETWORKS: process.env.CAMERA_ALLOWED_NETWORKS,
  CAMERA_ALLOWED_RTSP_PORTS: process.env.CAMERA_ALLOWED_RTSP_PORTS,
};

function restoreEnvironment() {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('encrypts credentials with authenticated encryption and decrypts them', () => {
  process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const secret = 'rtsp://camera-user:private-password@192.168.10.25:554/stream';
  const encrypted = encryptSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(encrypted.startsWith('v1:'), true);
  assert.equal(decryptSecret(encrypted), secret);
  restoreEnvironment();
});

test('rejects encrypted credentials changed after storage', () => {
  process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const encrypted = encryptSecret('rtsp://192.168.10.25:554/stream');
  const corrupted = `${encrypted.slice(0, -2)}AA`;
  assert.throws(() => decryptSecret(corrupted));
  restoreEnvironment();
});

test('requires a valid base64-encoded 32-byte encryption key', () => {
  delete process.env.CAMERA_ENCRYPTION_KEY;
  assert.throws(validateEncryptionKey, /CAMERA_ENCRYPTION_KEY is required/);
  assert.throws(() => encryptSecret('camera-secret'), /CAMERA_ENCRYPTION_KEY is required/);

  process.env.CAMERA_ENCRYPTION_KEY = 'not-a-valid-key';
  assert.throws(validateEncryptionKey, /32-byte key/);
  restoreEnvironment();
});

test('refuses to start the backend when the encryption key is missing', () => {
  const backendDirectory = path.resolve(__dirname, '..');
  const result = spawnSync(process.execPath, ['server.js'], {
    cwd: backendDirectory,
    env: { ...process.env, CAMERA_ENCRYPTION_KEY: '' },
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CAMERA_ENCRYPTION_KEY is required/);
});

test('accepts only configured private camera networks and RTSP ports', () => {
  process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.CAMERA_ALLOWED_NETWORKS = '192.168.10.0/24';
  process.env.CAMERA_ALLOWED_RTSP_PORTS = '554,8554';
  assert.equal(
    assertAllowedRtspUrl('rtsp://camera:secret@192.168.10.25:554/live/main'),
    'rtsp://camera:secret@192.168.10.25:554/live/main'
  );
  assert.throws(
    () => assertAllowedRtspUrl('rtsp://camera:secret@192.168.11.25:554/live/main'),
    /rede privada autorizada/
  );
  assert.throws(
    () => assertAllowedRtspUrl('rtsp://camera:secret@203.0.113.25:554/live/main'),
    /rede privada autorizada/
  );
  assert.throws(
    () => assertAllowedRtspUrl('rtsp://camera:secret@192.168.10.25:23/live/main'),
    /porta RTSP/
  );
  restoreEnvironment();
});

test('accepts standard HTTP/MJPEG camera streams from private networks', () => {
  process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  process.env.CAMERA_ALLOWED_NETWORKS = '192.168.10.0/24';
  process.env.CAMERA_ALLOWED_RTSP_PORTS = '554,8554,80,81,443,8000,8080';
  assert.equal(
    assertAllowedRtspUrl('http://192.168.10.25:80/cgi-bin/mjpeg'),
    'http://192.168.10.25/cgi-bin/mjpeg'
  );
  assert.equal(
    assertAllowedRtspUrl('https://192.168.10.25:443/video.cgi?stream=1'),
    'https://192.168.10.25/video.cgi?stream=1'
  );
  restoreEnvironment();
});

test('rejects hostnames and reports missing server allowlists', () => {
  process.env.CAMERA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  delete process.env.CAMERA_ALLOWED_NETWORKS;
  assert.throws(() => assertAllowedRtspUrl('rtsp://camera.local:554/live/main'), /IPv4/);
  process.env.CAMERA_ALLOWED_NETWORKS = '';
  assert.throws(
    () => assertAllowedRtspUrl('rtsp://192.168.10.25:554/live/main'),
    (error) => error.status === 503
  );
  assert.equal(isPrivateIPv4('192.168.10.25'), true);
  assert.equal(isPrivateIPv4('203.0.113.25'), false);
  restoreEnvironment();
});

test('migrates plaintext and legacy-encrypted camera records without losing values', async () => {
  const currentKey = crypto.randomBytes(32).toString('base64');
  const legacyKey = crypto.randomBytes(32).toString('base64');
  process.env.CAMERA_ENCRYPTION_KEY = legacyKey;
  const legacySource = encryptSecret('rtsp://legacy:password@192.168.10.25:554/live');
  const legacyReportNumber = encryptSecret('BO-LEGACY-1');
  const legacyEvidence = encryptSecret(Buffer.from('PDF evidence').toString('base64'));
  process.env.CAMERA_ENCRYPTION_KEY = currentKey;
  process.env.CAMERA_LEGACY_ENCRYPTION_KEY = legacyKey;
  delete process.env.CAMERA_CREDENTIALS_KEY;

  const cameraRows = [
    {
      id: 'legacy',
      encrypted_source: legacySource,
      encrypted_report_number: legacyReportNumber,
    },
    {
      id: 'plaintext',
      encrypted_source: 'rtsp://user:password@192.168.10.26:554/live',
      encrypted_report_number: 'BO-PLAINTEXT-1',
    },
  ];
  const evidenceRows = [{ camera_id: 'legacy', encrypted_data: legacyEvidence }];
  const updates = [];

  await migrateStoredCameraSecrets({
    all: async (sql) => (sql.includes('managed_cameras') ? cameraRows : evidenceRows),
    run: async (sql, params) => {
      updates.push({ sql, params });
      if (sql.includes('UPDATE managed_cameras')) {
        const row = cameraRows.find((camera) => camera.id === params[2]);
        row.encrypted_source = params[0];
        row.encrypted_report_number = params[1];
      } else {
        const row = evidenceRows.find((evidence) => evidence.camera_id === params[1]);
        row.encrypted_data = params[0];
      }
    },
  });

  assert.equal(updates.length, 3);
  assert.equal(
    decryptSecret(cameraRows[0].encrypted_source),
    'rtsp://legacy:password@192.168.10.25:554/live'
  );
  assert.equal(decryptSecret(cameraRows[0].encrypted_report_number), 'BO-LEGACY-1');
  assert.equal(
    decryptSecret(cameraRows[1].encrypted_source),
    'rtsp://user:password@192.168.10.26:554/live'
  );
  assert.equal(decryptSecret(cameraRows[1].encrypted_report_number), 'BO-PLAINTEXT-1');
  assert.equal(
    Buffer.from(decryptSecret(evidenceRows[0].encrypted_data), 'base64').toString(),
    'PDF evidence'
  );
  restoreEnvironment();
});
