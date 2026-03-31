import 'dotenv/config';
import { Client } from '@notionhq/client';
import axios from 'axios';

const REQUIRED = [
  'NOTION_TOKEN',
  'NOTION_DATABASE_AGENDAMENTOS',
  'NOTION_DATABASE_CAMPANHAS',
  'SENDFLOW_API_TOKEN',
  'SENDFLOW_API_URL',
  'SENDFLOW_ACCOUNT_ID',
  'SENDFLOW_NUMBER',
  'WEBHOOK_PORT',
  'WEBHOOK_SECRET',
];

let allOk = true;

function check(label, ok, detail) {
  const tag = ok ? '\x1b[32mOK\x1b[0m' : '\x1b[31mERRO\x1b[0m';
  console.log(`  [${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) allOk = false;
}

console.log('\n=== Verificação de variáveis de ambiente ===\n');

for (const key of REQUIRED) {
  const val = process.env[key];
  check(key, !!val && val.trim() !== '', !val || val.trim() === '' ? 'vazio ou ausente' : '');
}

console.log('\n=== Teste de conexão: Notion ===\n');

try {
  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const res = await notion.databases.retrieve({
    database_id: process.env.NOTION_DATABASE_AGENDAMENTOS,
  });
  check('Banco Agendamentos', true, `"${res.title?.[0]?.plain_text || res.id}"`);
} catch (err) {
  check('Banco Agendamentos', false, err.message);
}

try {
  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const res = await notion.databases.retrieve({
    database_id: process.env.NOTION_DATABASE_CAMPANHAS,
  });
  check('Banco Campanhas', true, `"${res.title?.[0]?.plain_text || res.id}"`);
} catch (err) {
  check('Banco Campanhas', false, err.message);
}

console.log('\n=== Teste de conexão: Sendflow ===\n');

try {
  const baseUrl = process.env.SENDFLOW_API_URL?.replace(/\/$/, '');
  const res = await axios.get(`${baseUrl}/sendapi/accounts`, {
    headers: { Authorization: `Bearer ${process.env.SENDFLOW_API_TOKEN}` },
    timeout: 10000,
  });
  const contas = res.data || [];
  const conectadas = contas.filter((c) => c.status === 'connected').length;
  check('Sendflow API', true, `${contas.length} conta(s), ${conectadas} conectada(s)`);

  // Verificar se o ACCOUNT_ID existe na lista
  const accountId = process.env.SENDFLOW_ACCOUNT_ID;
  const conta = contas.find((c) => c.id === accountId);
  if (conta) {
    check(
      'SENDFLOW_ACCOUNT_ID',
      true,
      `"${conta.name}" (${conta.status})`
    );
  } else {
    check(
      'SENDFLOW_ACCOUNT_ID',
      false,
      `ID "${accountId}" não encontrado. IDs disponíveis: ${contas.map((c) => c.id).join(', ')}`
    );
  }
} catch (err) {
  const status = err.response?.status;
  if (status === 401 || status === 403) {
    check('Sendflow API', false, `HTTP ${status} — token inválido ou sem permissão`);
  } else {
    check('Sendflow API', false, err.message);
  }
}

console.log('');
if (allOk) {
  console.log('\x1b[32mTudo certo! Pode iniciar com: node index.js\x1b[0m\n');
} else {
  console.log('\x1b[31mCorrija os erros acima antes de iniciar.\x1b[0m\n');
  process.exit(1);
}
