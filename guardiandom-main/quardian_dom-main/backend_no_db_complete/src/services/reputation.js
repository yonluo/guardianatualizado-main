function calculateReputation({ communityPosts, cameras }) {
  const posts = Math.max(0, Number(communityPosts) || 0);
  const cameraCount = Math.max(0, Number(cameras) || 0);
  const score = Math.min(posts, 5) * 10 + Math.min(cameraCount, 2) * 15;
  const level =
    score >= 50 ? 'Destaque' : score >= 20 ? 'Ativo' : score > 0 ? 'Participante' : 'Começando';
  const achievements = [];

  if (posts >= 1) {
    achievements.push({
      id: 'first-post',
      title: 'Primeira contribuição',
      detail: 'Publicou uma atualização na comunidade.',
      icon: '✦',
    });
  }
  if (posts >= 5) {
    achievements.push({
      id: 'community-voice',
      title: 'Voz da comunidade',
      detail: 'Publicou cinco atualizações.',
      icon: '◎',
    });
  }
  if (cameraCount >= 1) {
    achievements.push({
      id: 'first-camera',
      title: 'Câmera cadastrada',
      detail: 'Cadastrou uma câmera com BO anexado.',
      icon: '▣',
    });
  }
  if (posts >= 10 && cameraCount >= 2) {
    achievements.push({
      id: 'active-guardian',
      title: 'Participação ativa',
      detail: 'Publicou dez atualizações e cadastrou duas câmeras.',
      icon: '♧',
    });
  }

  return { score, level, achievements, communityPosts: posts, cameras: cameraCount };
}

module.exports = { calculateReputation };
