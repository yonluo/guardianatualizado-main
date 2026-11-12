const test = require('node:test');
const assert = require('node:assert/strict');
const { validateCameraReportEvidence } = require('../src/services/cameraReportEvidence');

function encoded(bytes) {
  return Buffer.from(bytes).toString('base64');
}

test('accepts supported document, image, and video signatures', () => {
  const samples = [
    { mimeType: 'application/pdf', fileName: 'bo.pdf', data: encoded('%PDF-1.7') },
    { mimeType: 'image/jpeg', fileName: 'bo.jpg', data: encoded([0xff, 0xd8, 0xff, 0x00]) },
    {
      mimeType: 'image/png',
      fileName: 'bo.png',
      data: encoded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    },
    { mimeType: 'image/webp', fileName: 'bo.webp', data: encoded('RIFF0000WEBP') },
    { mimeType: 'video/mp4', fileName: 'bo.mp4', data: encoded('0000ftypisom') },
    { mimeType: 'video/webm', fileName: 'bo.webm', data: encoded([0x1a, 0x45, 0xdf, 0xa3]) },
  ];

  for (const sample of samples) {
    assert.equal(validateCameraReportEvidence(sample).mimeType, sample.mimeType);
  }
});

test('rejects spoofed, mismatched, and oversized BO evidence', () => {
  assert.throws(
    () =>
      validateCameraReportEvidence({
        mimeType: 'application/pdf',
        fileName: 'bo.pdf',
        data: encoded('not a PDF'),
      }),
    /não corresponde/
  );
  assert.throws(
    () =>
      validateCameraReportEvidence({
        mimeType: 'image/png',
        fileName: 'bo.jpg',
        data: encoded('fake'),
      }),
    /formato/
  );
  assert.throws(
    () =>
      validateCameraReportEvidence({
        mimeType: 'application/pdf',
        fileName: 'bo.pdf',
        data: encoded(Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)])),
      }),
    /10 MB/
  );
});
