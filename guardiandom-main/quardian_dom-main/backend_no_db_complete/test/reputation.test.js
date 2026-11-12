const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateReputation } = require('../src/services/reputation');

test('calculates activity levels and achievements from server-side counts', () => {
  assert.deepEqual(calculateReputation({ communityPosts: 0, cameras: 0 }), {
    score: 0,
    level: 'Começando',
    achievements: [],
    communityPosts: 0,
    cameras: 0,
  });

  const reputation = calculateReputation({ communityPosts: 5, cameras: 1 });
  assert.equal(reputation.score, 65);
  assert.equal(reputation.level, 'Destaque');
  assert.deepEqual(
    reputation.achievements.map((achievement) => achievement.id),
    ['first-post', 'community-voice', 'first-camera']
  );
});

test('caps contribution scores and does not include feedback in reputation', () => {
  const reputation = calculateReputation({ communityPosts: 100, cameras: 100, feedback: 'great' });
  assert.equal(reputation.score, 80);
  assert.equal(reputation.level, 'Destaque');
});
