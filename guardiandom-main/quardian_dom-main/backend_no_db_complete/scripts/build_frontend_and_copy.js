const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');

// Possíveis caminhos para o projeto frontend (ajuste se necessário)
const candidates = [];
// 1) Caminho relativo anterior (caso o usuário tenha movido a pasta)
candidates.push(
  path.resolve(__dirname, '..', '..', 'Downloads', 'Design Script for Angel Guardian')
);
// também tentar a variação com sufixo (1)
candidates.push(
  path.resolve(__dirname, '..', '..', 'Downloads', 'Design Script for Angel Guardian (1)')
);
// 2) Pasta Downloads do usuário
if (process.env.USERPROFILE) {
  candidates.push(
    path.join(process.env.USERPROFILE, 'Downloads', 'Design Script for Angel Guardian')
  );
  candidates.push(
    path.join(process.env.USERPROFILE, 'Downloads', 'Design Script for Angel Guardian (1)')
  );
}
// 3) Caminho direto (se o projeto já estiver dentro do workspace)
candidates.push(path.resolve(__dirname, '..', 'frontend'));

let frontendPath = null;
for (const c of candidates) {
  if (fs.existsSync(c)) {
    frontendPath = c;
    break;
  }
}
const publicPath = path.resolve(__dirname, '..', 'public');

async function run() {
  try {
    if (!frontendPath) {
      console.error(
        'Frontend folder não encontrada. Tente mover o projeto frontend para um destes locais:'
      );
      console.error(candidates.join('\n'));
      process.exit(1);
    }

    console.log('Instalando dependências do frontend... (pode demorar)');
    execSync('npm install --legacy-peer-deps', { cwd: frontendPath, stdio: 'inherit' });

    console.log('Gerando build do frontend...');
    execSync('npm run build', { cwd: frontendPath, stdio: 'inherit' });

    const distPath = path.join(frontendPath, 'dist');
    if (!fs.existsSync(distPath)) {
      console.error('Pasta dist não encontrada após build:', distPath);
      process.exit(1);
    }

    console.log('Copiando build para', publicPath);
    await fs.remove(publicPath);
    await fs.copy(distPath, publicPath);

    console.log('Build copiado com sucesso para', publicPath);
  } catch (err) {
    console.error('Erro:', err.message || err);
    process.exit(1);
  }
}

run();
