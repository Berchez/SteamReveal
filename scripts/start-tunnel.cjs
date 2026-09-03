#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Sobe um túnel Cloudflare (free tier / quick tunnel), captura a URL
 * *.trycloudflare.com gerada dinamicamente, atualiza LOCAL_PROXY_URL
 * no .env, abre o painel de env vars da Vercel (update manual lá)
 * e então inicia o script "start proxy local" do package.json.
 *
 * Uso: node scripts/start-tunnel.cjs
 * (ou adicione como script no package.json: "tunnel:dev": "node scripts/start-tunnel.cjs")
 *
 * Requisitos: cloudflared instalado e disponível no PATH.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ----------------------------------------------------------------------
// CONFIG — ajuste estes dois valores pro seu projeto
// ----------------------------------------------------------------------
const PORT = process.env.LOCAL_PROXY_PORT || 3001;
const PROXY_LOCAL_SCRIPT = 'start:proxy-local';
// ----------------------------------------------------------------------

const VERCEL_ENV_URL =
  process.env.VERCEL_ENV_URL ||
  'https://vercel.com/berchezs-projects/osint-steam/settings/environment-variables';
const ENV_FILE = path.join(process.cwd(), '.env');
const TUNNEL_URL_REGEX = /https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/;

const isWindows = process.platform === 'win32';

function updateEnvLocal(url) {
  let content = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8')
    : '';
  const newLine = `LOCAL_PROXY_URL="${url}"`;

  if (/^LOCAL_PROXY_URL=.*$/m.test(content)) {
    content = content.replace(/^LOCAL_PROXY_URL=.*$/m, newLine);
  } else {
    content =
      content.length > 0
        ? `${content.trimEnd()}\n${newLine}\n`
        : `${newLine}\n`;
  }

  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

function copyToClipboard(text) {
  let cmd;
  let args;

  if (isWindows) {
    cmd = 'clip';
    args = [];
  } else if (process.platform === 'darwin') {
    cmd = 'pbcopy';
    args = [];
  } else {
    cmd = 'xclip';
    args = ['-selection', 'clipboard'];
  }

  try {
    const proc = spawn(cmd, args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: isWindows,
    });
    proc.stdin.write(text);
    proc.stdin.end();
    proc.on('error', (err) => {
      console.warn(
        `⚠ Não consegui copiar pro clipboard automaticamente (${cmd} falhou):`,
        err.message,
      );
    });
  } catch (err) {
    console.warn(
      '⚠ Não consegui copiar pro clipboard automaticamente:',
      err.message,
    );
  }
}

function openBrowser(url) {
  let cmd;
  let args;

  if (isWindows) {
    cmd = 'cmd';
    args = ['/c', 'start', '""', url];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }

  spawn(cmd, args, {
    stdio: 'ignore',
    detached: true,
    shell: isWindows,
  }).unref();
}

console.log(`Abrindo túnel Cloudflare em http://localhost:${PORT} ...\n`);

const tunnel = spawn(
  'cloudflared',
  ['tunnel', '--url', `http://localhost:${PORT}`],
  {
    shell: isWindows,
  },
);

let urlCaptured = false;
let proxyProcess = null;

function shutdown(code) {
  if (proxyProcess) proxyProcess.kill();
  if (tunnel) tunnel.kill();
  process.exit(code ?? 0);
}

function handleTunnelOutput(data) {
  const text = data.toString();
  process.stdout.write(text); // eco cru pro terminal, útil se algo der errado

  if (urlCaptured) return;

  const match = text.match(TUNNEL_URL_REGEX);
  if (!match) return;

  urlCaptured = true;
  const url = match[0];

  console.log(`\n✔ URL do túnel capturada: ${url}`);

  updateEnvLocal(url);
  console.log(`✔ .env atualizado (LOCAL_PROXY_URL=${url})`);

  copyToClipboard(url);
  console.log(
    '✔ URL copiada pro clipboard — é só dar Ctrl+V no valor da env var na Vercel',
  );

  console.log('→ Abrindo painel de env vars da Vercel...');
  openBrowser(VERCEL_ENV_URL);

  console.log(
    `\n→ Iniciando proxy local (pnpm run ${PROXY_LOCAL_SCRIPT})...\n`,
  );
  proxyProcess = spawn('pnpm', ['run', PROXY_LOCAL_SCRIPT], {
    stdio: 'inherit',
    shell: true,
  });

  proxyProcess.on('exit', (code) => {
    console.log(`\nProxy local encerrado (code ${code}). Encerrando túnel...`);
    shutdown(code);
  });
}

tunnel.stdout.on('data', handleTunnelOutput);
tunnel.stderr.on('data', handleTunnelOutput);

tunnel.on('error', (err) => {
  console.error(
    'Erro ao iniciar o cloudflared. Ele está instalado e disponível no PATH?',
    err,
  );
  process.exit(1);
});

tunnel.on('exit', (code) => {
  if (!urlCaptured) {
    console.error(
      `\ncloudflared encerrou antes de gerar a URL do túnel (code ${code}).`,
    );
    process.exit(code ?? 1);
  }
});

process.on('SIGINT', () => {
  console.log('\nCtrl+C recebido — encerrando túnel e proxy local...');
  shutdown(0);
});
