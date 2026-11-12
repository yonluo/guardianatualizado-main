const crypto = require('node:crypto');
const net = require('node:net');

function configurationError(message) {
  const error = new Error(message);
  error.status = 503;
  return error;
}

function parseEncryptionKey(encoded, variableName) {
  if (typeof encoded !== 'string' || !encoded) {
    throw configurationError(`${variableName} is required to protect camera credentials.`);
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw configurationError(`${variableName} must be a base64-encoded 32-byte key.`);
  }
  return key;
}

function getEncryptionKey() {
  return parseEncryptionKey(process.env.CAMERA_ENCRYPTION_KEY, 'CAMERA_ENCRYPTION_KEY');
}

function validateEncryptionKey() {
  getEncryptionKey();
}

function encryptSecretWithKey(value, key) {
  if (typeof value !== 'string') throw new TypeError('Camera secret must be a string.');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

function encryptSecret(value) {
  return encryptSecretWithKey(value, getEncryptionKey());
}

function decryptSecretWithKey(value, key) {
  const [version, encodedIv, encodedTag, encodedData, ...extra] = String(value).split(':');
  if (version !== 'v1' || !encodedIv || !encodedTag || !encodedData || extra.length) {
    throw new Error('Invalid encrypted camera credential.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(encodedIv, 'base64'));
  decipher.setAuthTag(Buffer.from(encodedTag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedData, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

function decryptSecret(value) {
  return decryptSecretWithKey(value, getEncryptionKey());
}

function migrateSecret(value, legacyKey) {
  const stored = String(value ?? '');
  if (!/^v\d+:/.test(stored)) return encryptSecret(stored);
  if (!stored.startsWith('v1:')) {
    throw configurationError('Stored camera credentials use an unsupported encryption version.');
  }
  try {
    decryptSecret(stored);
    return stored;
  } catch (currentKeyError) {
    if (!legacyKey) {
      throw configurationError(
        'Existing encrypted camera data cannot be opened with CAMERA_ENCRYPTION_KEY. Configure the previous key as CAMERA_LEGACY_ENCRYPTION_KEY for migration.'
      );
    }
    try {
      return encryptSecretWithKey(decryptSecretWithKey(stored, legacyKey), getEncryptionKey());
    } catch {
      throw configurationError(
        'Existing encrypted camera data cannot be migrated. Verify CAMERA_ENCRYPTION_KEY and CAMERA_LEGACY_ENCRYPTION_KEY.'
      );
    }
  }
}

async function migrateStoredCameraSecrets({ all, run }) {
  getEncryptionKey();
  const legacyEncoded =
    process.env.CAMERA_LEGACY_ENCRYPTION_KEY || process.env.CAMERA_CREDENTIALS_KEY || '';
  const legacyKey = legacyEncoded
    ? parseEncryptionKey(
        legacyEncoded,
        process.env.CAMERA_LEGACY_ENCRYPTION_KEY
          ? 'CAMERA_LEGACY_ENCRYPTION_KEY'
          : 'CAMERA_CREDENTIALS_KEY'
      )
    : null;

  const cameras = await all(
    `SELECT id, encrypted_source, encrypted_report_number
     FROM managed_cameras`
  );
  for (const camera of cameras) {
    const encryptedSource = migrateSecret(camera.encrypted_source, legacyKey);
    const encryptedReportNumber = migrateSecret(camera.encrypted_report_number, legacyKey);
    if (
      encryptedSource !== camera.encrypted_source ||
      encryptedReportNumber !== camera.encrypted_report_number
    ) {
      await run(
        `UPDATE managed_cameras
         SET encrypted_source = ?, encrypted_report_number = ? WHERE id = ?`,
        [encryptedSource, encryptedReportNumber, camera.id]
      );
    }
  }

  const evidenceFiles = await all(`SELECT camera_id, encrypted_data FROM camera_report_evidence`);
  for (const evidence of evidenceFiles) {
    const encryptedData = migrateSecret(evidence.encrypted_data, legacyKey);
    if (encryptedData !== evidence.encrypted_data) {
      await run(`UPDATE camera_report_evidence SET encrypted_data = ? WHERE camera_id = ?`, [
        encryptedData,
        evidence.camera_id,
      ]);
    }
  }
}

function ipv4ToNumber(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function isPrivateIPv4(address) {
  const ip = ipv4ToNumber(address);
  if (ip === null) return false;
  const privateRanges = [
    { network: ipv4ToNumber('10.0.0.0'), mask: 0xff000000 },
    { network: ipv4ToNumber('172.16.0.0'), mask: 0xfff00000 },
    { network: ipv4ToNumber('192.168.0.0'), mask: 0xffff0000 },
    { network: ipv4ToNumber('100.64.0.0'), mask: 0xffc00000 },
  ];
  return privateRanges.some(({ network, mask }) => (ip & mask) >>> 0 === network);
}

function parseAllowedNetworks() {
  const configured = process.env.CAMERA_ALLOWED_NETWORKS || '';
  return configured
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address, prefixText, ...extra] = entry.split('/');
      const ip = ipv4ToNumber(address);
      const prefix = prefixText === undefined ? 32 : Number(prefixText);
      if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32 || extra.length) {
        throw configurationError('CAMERA_ALLOWED_NETWORKS must contain valid IPv4 CIDR ranges.');
      }
      const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
      return { network: (ip & mask) >>> 0, mask };
    });
}

function assertAllowedRtspUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Informe um endereço de stream da câmera válido.');
  }

  const supportedProtocols = new Set(['rtsp:', 'rtsps:', 'http:', 'https:']);

  if (
    !supportedProtocols.has(url.protocol) ||
    url.hash ||
    net.isIP(url.hostname) !== 4
  ) {
    throw new Error(
      'Use RTSP/RTSPS ou HTTP/HTTPS com endereço IPv4; nomes de host e outros protocolos não são aceitos.'
    );
  }

  if (['rtsp:', 'rtsps:'].includes(url.protocol) && (!url.pathname || url.pathname === '/')) {
    throw new Error('O endereço RTSP/RTSPS precisa apontar para um fluxo específico da câmera.');
  }

  const target = ipv4ToNumber(url.hostname);
  const allowedNetworks = parseAllowedNetworks();
  if (allowedNetworks.length === 0) {
    throw configurationError(
      'CAMERA_ALLOWED_NETWORKS is required to authorize camera connections.'
    );
  }
  if (
    !isPrivateIPv4(url.hostname) ||
    !allowedNetworks.some(({ network, mask }) => (target & mask) >>> 0 === network)
  ) {
    throw new Error(
      'O endereço da câmera não pertence a uma rede privada autorizada pelo servidor.'
    );
  }

  const defaultPortByProtocol = {
    'rtsp:': 554,
    'rtsps:': 322,
    'http:': 80,
    'https:': 443,
  };
  const port = Number(url.port || defaultPortByProtocol[url.protocol]);
  const allowedPorts = (process.env.CAMERA_ALLOWED_RTSP_PORTS || '554,8554,322,80,81,443,8000,8080')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535);
  if (allowedPorts.length === 0) {
    throw configurationError('CAMERA_ALLOWED_RTSP_PORTS contains no valid ports.');
  }
  if (!Number.isInteger(port) || !allowedPorts.includes(port)) {
    throw new Error('A porta RTSP não está permitida pelo servidor.');
  }

  return url.toString();
}

module.exports = {
  assertAllowedRtspUrl,
  decryptSecret,
  encryptSecret,
  getEncryptionKey,
  isPrivateIPv4,
  migrateSecret,
  migrateStoredCameraSecrets,
  parseAllowedNetworks,
  validateEncryptionKey,
};
