import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ciclo, executarAcao } from './executor.js';
import { resolverResposta, pendentes } from './confirmacao.js';
import {
  atualizarAgendamento,
  buscarTodosAgendamentos,
  buscarCampanhas,
  criarAgendamento,
  sincronizarCampanhas,
  listarWebinarios,
} from './notion.js';
import { listarCampanhas as listarCampanhasSendflow } from './sendflow.js';
import { runBackup } from './backup.js';
import {
  lerWebinarios,
  lerWebinario,
  salvarWebinario,
  criarNovoWebinario,
  deletarWebinario,
  lerHistoricoLocal,
  executarFluxoWebinario,
  reenviarNotificacao,
  iniciarCronsWebinario,
} from './webinario.js';
import { testarConexao as testarSwitchy } from './switchy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.WEBHOOK_PORT || 3001;
const SECRET = process.env.WEBHOOK_SECRET;

// Estado do sistema
const estado = {
  iniciadoEm: new Date().toISOString(),
  ultimoCiclo: null,
  ciclosExecutados: 0,
  erros: 0,
};

// ─── Middleware de autenticação para o webhook ───
function verificarSecret(req, res, next) {
  const header = req.headers['x-webhook-secret'];
  if (header !== SECRET) {
    console.warn(`[Webhook] Secret inválido de ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── POST /webhook ───
app.post('/webhook', verificarSecret, async (req, res) => {
  try {
    const texto = req.body?.message?.text || req.body?.texto || '';
    console.log(`[Webhook] Recebido: "${texto}"`);
    const resultado = resolverResposta(texto);
    if (!resultado) {
      return res.json({ ok: true, acao: 'ignorado', motivo: 'formato não reconhecido' });
    }
    if (resultado.acao === 'sim') {
      console.log(`[Webhook] Aprovado: ${resultado.dados.nome} [${resultado.shortId}]`);
      const exec = await executarAcao(resultado.dados);
      return res.json({ ok: true, acao: 'executado', resultado: exec });
    }
    if (resultado.acao === 'nao') {
      console.log(`[Webhook] Cancelado: ${resultado.dados.nome} [${resultado.shortId}]`);
      await atualizarAgendamento(resultado.dados.pageId, 'cancelado', 'Cancelado pelo usuário');
      return res.json({ ok: true, acao: 'cancelado' });
    }
    res.json({ ok: true, acao: 'ignorado' });
  } catch (err) {
    console.error('[Webhook] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── API para o Dashboard ───

app.get('/api/status', (_req, res) => {
  res.json({
    ...estado,
    uptime: process.uptime(),
    pendentesAprovacao: pendentes.size,
    account: process.env.SENDFLOW_ACCOUNT_ID,
    numero: process.env.SENDFLOW_NUMBER,
  });
});

app.get('/api/agendamentos', async (_req, res) => {
  try {
    const data = await buscarTodosAgendamentos();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/campanhas', async (_req, res) => {
  try {
    const data = await buscarCampanhas();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agendamentos', async (req, res) => {
  try {
    const { nome, dataHora, tipoAcao, campanhaId, parametro } = req.body;
    if (!nome || !dataHora || !tipoAcao || !campanhaId || !parametro) {
      return res.status(400).json({ error: 'Campos obrigatórios: nome, dataHora, tipoAcao, campanhaId, parametro' });
    }
    const id = await criarAgendamento({ nome, dataHora, tipoAcao, campanhaId, parametro });
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista aprovações pendentes (aguardando SIM/NAO)
app.get('/api/pendentes', (_req, res) => {
  const lista = [];
  for (const [shortId, dados] of pendentes) {
    lista.push({
      shortId,
      pageId: dados.pageId,
      nome: dados.nome,
      tipoAcao: dados.tipoAcao,
      parametro: dados.parametro,
      criadoEm: new Date(dados.criadoEm).toISOString(),
    });
  }
  res.json(lista);
});

// Aprovar ou cancelar pelo dashboard (via shortId em memória)
app.post('/api/aprovar/:shortId', async (req, res) => {
  try {
    const { shortId } = req.params;
    const { acao } = req.body;
    const dados = pendentes.get(shortId);
    if (!dados) {
      return res.status(404).json({ error: 'Aprovação não encontrada ou já expirada' });
    }
    pendentes.delete(shortId);

    if (acao === 'sim') {
      console.log(`[Dashboard] Aprovado: ${dados.nome} [${shortId}]`);
      const exec = await executarAcao(dados);
      return res.json({ ok: true, acao: 'executado', resultado: exec });
    } else {
      console.log(`[Dashboard] Cancelado: ${dados.nome} [${shortId}]`);
      await atualizarAgendamento(dados.pageId, 'cancelado', 'Cancelado pelo dashboard');
      return res.json({ ok: true, acao: 'cancelado' });
    }
  } catch (err) {
    console.error('[Dashboard] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Aprovar/cancelar direto pelo pageId do Notion (para aguardando_ok que sobreviveram restart)
app.post('/api/aprovar-direto/:pageId', async (req, res) => {
  try {
    const { pageId } = req.params;
    const { acao, tipoAcao, parametro, nome } = req.body;

    if (acao === 'nao') {
      await atualizarAgendamento(pageId, 'cancelado', 'Cancelado pelo dashboard');
      console.log(`[Dashboard] Cancelado direto: ${nome}`);
      return res.json({ ok: true, acao: 'cancelado' });
    }

    // Para executar, precisamos resolver a campanha
    const agendamentos = await buscarTodosAgendamentos();
    const ag = agendamentos.find((a) => a.id === pageId);
    if (!ag || !ag.campanhaRelation) {
      return res.status(400).json({ error: 'Campanha não vinculada' });
    }

    const { resolverCampanha } = await import('./notion.js');
    const campanha = await resolverCampanha(ag.campanhaRelation);
    if (!campanha.idSendflow) {
      return res.status(400).json({ error: 'ID Sendflow não encontrado na campanha' });
    }

    const dados = {
      pageId,
      nome: ag.nome,
      tipoAcao: ag.tipoAcao,
      releaseId: campanha.idSendflow,
      accountId: campanha.instancia || process.env.SENDFLOW_ACCOUNT_ID,
      parametro: ag.parametro,
    };

    console.log(`[Dashboard] Aprovado direto: ${ag.nome}`);
    const exec = await executarAcao(dados);
    return res.json({ ok: true, acao: 'executado', resultado: exec });
  } catch (err) {
    console.error('[Dashboard] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ciclo', async (_req, res) => {
  try {
    await ciclo();
    res.json({ ok: true, message: 'Ciclo executado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/backup', async (_req, res) => {
  try {
    await runBackup();
    res.json({ ok: true, message: 'Backup executado' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sync-campanhas', async (_req, res) => {
  try {
    const sf = await listarCampanhasSendflow();
    const result = await sincronizarCampanhas(sf.data);
    console.log(`[Sync] ${result.criadas} criadas, ${result.atualizadas} atualizadas de ${result.total} campanhas`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[Sync] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Webinário (multi-cliente) ───

app.get('/api/webinario', async (_req, res) => {
  try {
    res.json(await lerWebinarios());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webinario', async (req, res) => {
  try {
    const id = await criarNovoWebinario(req.body);
    await iniciarCronsWebinario();
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/webinario/:id/config', async (req, res) => {
  try {
    const cfg = await lerWebinario(req.params.id);
    if (!cfg) return res.status(404).json({ error: 'Não encontrado' });
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webinario/:id/config', async (req, res) => {
  try {
    await salvarWebinario(req.params.id, req.body);
    await iniciarCronsWebinario();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/webinario/:id', async (req, res) => {
  try {
    await deletarWebinario(req.params.id);
    await iniciarCronsWebinario();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/webinario/:id/historico', async (req, res) => {
  try {
    if (process.env.NOTION_DATABASE_WEBINARIOS) {
      const data = await listarWebinarios(10);
      return res.json(data);
    }
    res.json(await lerHistoricoLocal(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webinario/:id/executar', async (req, res) => {
  try {
    const resultado = await executarFluxoWebinario(req.params.id, { dataOverride: req.body?.dataOverride });
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/webinario/:id/testar-switchy', async (req, res) => {
  try {
    const workspaces = await testarSwitchy();
    res.json({ ok: true, workspaces });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/webinario/:id/reenviar-notificacao', async (req, res) => {
  try {
    const { campaignId } = req.body;
    if (!campaignId) return res.status(400).json({ error: 'campaignId obrigatório' });
    const resultado = await reenviarNotificacao(req.params.id, campaignId);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs', async (_req, res) => {
  try {
    const raw = await readFile(join(__dirname, 'logs', 'execucoes.json'), 'utf-8');
    const logs = JSON.parse(raw);
    res.json(logs.slice(-100).reverse());
  } catch {
    res.json([]);
  }
});

// ─── Health check ───
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Dashboard HTML ───
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'dashboard.html'));
});

// ─── Iniciar servidor ───
app.listen(PORT, () => {
  console.log(`\n[Sendflow-Notion] Dashboard: http://localhost:${PORT}`);
  console.log(`[Sendflow-Notion] Webhook: https://${process.env.CLOUDFLARE_TUNNEL_DOMAIN}/webhook`);
  console.log(`[Sendflow-Notion] Health: http://localhost:${PORT}/health\n`);
});

// ─── Cron: ciclo principal a cada 5 minutos ───
cron.schedule('*/5 * * * *', async () => {
  try {
    await ciclo();
    estado.ultimoCiclo = new Date().toISOString();
    estado.ciclosExecutados++;
  } catch (err) {
    estado.erros++;
    console.error('[Cron] Erro no ciclo:', err.message);
  }
});

// ─── Cron: sync campanhas a cada 2 horas ───
cron.schedule('0 */2 * * *', async () => {
  try {
    const sf = await listarCampanhasSendflow();
    const result = await sincronizarCampanhas(sf.data);
    console.log(`[Cron Sync] ${result.criadas} criadas, ${result.atualizadas} atualizadas`);
  } catch (err) {
    console.error('[Cron Sync] Erro:', err.message);
  }
});

// ─── Cron: backup todo dia à meia-noite ───
cron.schedule('0 0 * * *', () => {
  runBackup().catch((err) => console.error('[Cron] Erro no backup:', err.message));
});

// ─── Primeiro boot: sync campanhas + primeiro ciclo + cron webinário ───
iniciarCronsWebinario().catch((err) =>
  console.error('[Webinário] Erro ao iniciar crons:', err.message)
);

console.log('[Sendflow-Notion] Sincronizando campanhas...');
listarCampanhasSendflow()
  .then((sf) => sincronizarCampanhas(sf.data))
  .then((r) => console.log(`[Sync] ${r.criadas} criadas, ${r.atualizadas} atualizadas de ${r.total}`))
  .catch((err) => console.error('[Sync] Erro:', err.message))
  .finally(() => {
    console.log('[Sendflow-Notion] Executando primeiro ciclo...');
    ciclo()
      .then(() => {
        estado.ultimoCiclo = new Date().toISOString();
        estado.ciclosExecutados++;
      })
      .catch((err) => {
        estado.erros++;
        console.error('[Primeiro ciclo] Erro:', err.message);
      });
  });
