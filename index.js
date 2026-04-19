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
  marcarPushSendflow,
} from './notion.js';
import { listarCampanhas as listarCampanhasSendflow, enviarMensagemDireta, enviarImagemDireta, atualizarRelease, criarGrupoWebinario } from './sendflow.js';
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
import { wzPreview, agendarSequenciaWZ, getSequencia } from './wz-sequencia.js';
import { sincronizarComNotion, lerCache, salvarConfigUrl, lerConfigUrl, lerConfig, salvarConfig } from './wz-notion.js';
import { aplicarVariaveis, formatarDataBR } from './wz-variaveis.js';
import { validarSequencia } from './wz-validar.js';
import { listarHistorico } from './wz-historico.js';
import { agendarAcoes, listarAgendados, executarPendentes, cancelarAgendado, forcarExecucao } from './wz-agendador.js';
import { testarConexao as testarSwitchy } from './switchy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.WEBHOOK_PORT || 3001;
const SECRET = process.env.WEBHOOK_SECRET;
const DASH_USER = process.env.DASHBOARD_USER;
const DASH_PASS = process.env.DASHBOARD_PASSWORD;

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

// ─── Middleware de autenticação Basic Auth para o dashboard e API ───
// Rotas públicas: /webhook (tem x-webhook-secret), /health, /img/*
function requireDashAuth(req, res, next) {
  // Se DASHBOARD_USER/PASSWORD não definidos, desabilita auth (dev local)
  if (!DASH_USER || !DASH_PASS) return next();

  const rotasPublicas = ['/webhook', '/health'];
  if (rotasPublicas.includes(req.path) || req.path.startsWith('/img/')) {
    return next();
  }

  const header = req.headers.authorization || '';
  const [scheme, creds] = header.split(' ');
  if (scheme === 'Basic' && creds) {
    try {
      const decoded = Buffer.from(creds, 'base64').toString('utf-8');
      const sep = decoded.indexOf(':');
      const user = decoded.slice(0, sep);
      const pass = decoded.slice(sep + 1);
      if (user === DASH_USER && pass === DASH_PASS) return next();
    } catch {}
  }

  res.set('WWW-Authenticate', 'Basic realm="Sendflow-Notion Dashboard", charset="UTF-8"');
  return res.status(401).send('Autenticação necessária.');
}

// Aplica auth globalmente (antes das rotas)
app.use(requireDashAuth);

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

// Push Notion → Sendflow: aplica os campos Nome do Grupo / Descrição / Foto
// das linhas do Notion nas campanhas correspondentes do Sendflow.
// Body: { pageIds?: string[] }  (se omitido, faz em todas que têm ID Sendflow
// e algum dos campos preenchidos)
app.post('/api/campanhas/push-sendflow', async (req, res) => {
  const { pageIds } = req.body || {};
  try {
    const todas = await buscarCampanhas();
    let alvos = todas.filter((c) => c.idSendflow);
    if (pageIds?.length) alvos = alvos.filter((c) => pageIds.includes(c.id));
    alvos = alvos.filter((c) => c.nomeGrupo || c.descricaoGrupo || c.fotoUrl);

    const resultados = [];
    for (const c of alvos) {
      try {
        const r = await atualizarRelease({
          releaseId: c.idSendflow,
          nome: c.nome,
          nomeGrupo: c.nomeGrupo || undefined,
          descricao: c.descricaoGrupo !== '' ? c.descricaoGrupo : undefined,
          fotoUrl: c.fotoUrl || undefined,
        });
        await marcarPushSendflow(c.id);
        resultados.push({ id: c.id, nome: c.nome, idSendflow: c.idSendflow, ok: true, status: r.status });
      } catch (err) {
        const erro = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        resultados.push({ id: c.id, nome: c.nome, idSendflow: c.idSendflow, ok: false, erro });
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    const ok = resultados.filter((r) => r.ok).length;
    console.log(`[Push-Sendflow] ${ok}/${resultados.length} campanhas sincronizadas`);
    res.json({ ok: true, total: resultados.length, sucessos: ok, falhas: resultados.length - ok, resultados });
  } catch (err) {
    console.error('[Push-Sendflow] Erro:', err.message);
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

// ─── WZ Sequência de Aquecimento ───

// Retorna preview do agendamento sem executar
app.get('/api/wz/preview', async (req, res) => {
  const { dataWebinario } = req.query;
  if (!dataWebinario || !/^\d{4}-\d{2}-\d{2}$/.test(dataWebinario)) {
    return res.status(400).json({ error: 'dataWebinario obrigatório no formato YYYY-MM-DD' });
  }
  try {
    const items = await wzPreview(dataWebinario);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retorna a lista de mensagens WZ (sem agendar)
app.get('/api/wz/mensagens', async (_req, res) => {
  try {
    const seq = await getSequencia();
    res.json(seq.map(({ id, label, tipo, tipoAcao, prefixo, offset, hora, min, dia }) => ({
      id, label, tipo, tipoAcao: tipoAcao || 'enviar_mensagem', prefixo: prefixo || 'WZ', offset, hora, min, dia,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cria uma nova campanha (release) no Sendflow pra próxima semana de webinário
app.post('/api/wz/nova-campanha', async (req, res) => {
  try {
    const { dataWebinario, nomeOverride, descricaoInicial, fotoUrl, accountId } = req.body || {};
    if (!dataWebinario || !/^\d{4}-\d{2}-\d{2}$/.test(dataWebinario)) {
      return res.status(400).json({ error: 'dataWebinario obrigatório (YYYY-MM-DD)' });
    }

    // Nome default: "{nome_base} • Aula DD.MM às HHh"
    const cfg = await lerConfig();
    const [, isoMes, isoDia] = dataWebinario.split('-');
    const hora = String(cfg.horaWebinario ?? 20).padStart(2, '0');
    const nomeBase = cfg.nomeBase || 'Campanha';
    const nome = nomeOverride || `${nomeBase} • Aula ${isoDia}.${isoMes} às ${hora}h`;

    // Cria release + grupo no Sendflow
    const r = await criarGrupoWebinario({
      accountId: accountId || process.env.SENDFLOW_ACCOUNT_ID,
      nome,
      descricao: descricaoInicial || '',
      fotoUrl: fotoUrl || null,
    });

    // Re-sincroniza campanhas no Notion pra refletir a nova
    try {
      const sf = await listarCampanhasSendflow();
      await sincronizarCampanhas(sf.data);
    } catch (err) {
      console.error('[Nova Campanha] erro ao sincronizar Notion:', err.message);
    }

    console.log(`[Nova Campanha] ✅ ${nome} (${r.data.id})`);
    res.json({
      ok: true,
      releaseId: r.data.id,
      nome,
      inviteLink: r.data.inviteLink,
    });
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    console.error('[Nova Campanha] erro:', msg);
    res.status(500).json({ error: msg });
  }
});

// Estado atual da sincronização com Notion (cache + URL salva)
app.get('/api/wz/sync-status', async (_req, res) => {
  try {
    const cache = await lerCache();
    const cfg = await lerConfig();
    res.json({
      notionUrl: cfg.notionUrl || null,
      nomeBase: cfg.nomeBase || '',
      linkInscricao: cfg.linkInscricao || '',
      horaWebinario: cfg.horaWebinario || 20,
      syncedAt: cache?.syncedAt || null,
      totalMensagens: cache?.mensagens?.length || 0,
      sourceUrl: cache?.sourceUrl || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Salva config das variáveis (nome_base, link_inscricao, hora_webinario)
app.post('/api/wz/config', async (req, res) => {
  try {
    const patch = {};
    const { nomeBase, linkInscricao, horaWebinario, notionUrl } = req.body || {};
    if (nomeBase !== undefined) patch.nomeBase = nomeBase;
    if (linkInscricao !== undefined) patch.linkInscricao = linkInscricao;
    if (horaWebinario !== undefined) patch.horaWebinario = Number(horaWebinario);
    if (notionUrl !== undefined) patch.notionUrl = notionUrl;
    const novo = await salvarConfig(patch);
    res.json({ ok: true, config: novo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista agendamentos locais (RN e DS), opcionalmente filtra por status
app.get('/api/wz/agendados', async (req, res) => {
  try {
    const { status } = req.query;
    const lista = await listarAgendados({ status });
    res.json(lista);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancela um agendamento local pendente
app.delete('/api/wz/agendados/:id', async (req, res) => {
  try {
    const entrada = await cancelarAgendado(req.params.id);
    res.json({ ok: true, entrada });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Limpa todos os agendamentos já executados/cancelados (mantém só pendentes)
app.post('/api/wz/agendados/limpar', async (_req, res) => {
  try {
    const lista = await listarAgendados();
    const antes = lista.length;
    const pendentes = lista.filter((e) => e.status === 'pendente');
    const removidos = antes - pendentes.length;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(__dirname, 'data', 'wz-agendados.json'), JSON.stringify(pendentes, null, 2), 'utf-8');
    console.log(`[WZ-Agendador] ${removidos} entradas limpas (mantidas ${pendentes.length} pendentes)`);
    res.json({ ok: true, antes, depois: pendentes.length, removidos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Força execução imediata de um agendamento pendente (pra teste)
app.post('/api/wz/agendados/:id/executar', async (req, res) => {
  try {
    const r = await forcarExecucao(req.params.id);
    res.json(r);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Envia uma (ou todas) as mensagens WZ direto pra um número de teste,
// sem agendamento — pra validar texto, imagens e formatação antes de
// disparar em massa pra campanha.
app.post('/api/wz/testar', async (req, res) => {
  const { numero, wzId, accountId } = req.body || {};
  if (!numero) return res.status(400).json({ error: 'numero obrigatório (ex: 5511999999999)' });
  const numeroLimpo = String(numero).replace(/\D/g, '');
  if (numeroLimpo.length < 10) return res.status(400).json({ error: 'numero inválido' });

  try {
    const seq = await getSequencia();
    if (!seq.length) return res.status(400).json({ error: 'Sequência vazia. Sincronize com o Notion.' });

    const alvo = wzId ? seq.filter((m) => m.id === wzId) : seq;
    if (!alvo.length) return res.status(404).json({ error: `Mensagem ${wzId} não encontrada` });

    const acc = accountId || process.env.SENDFLOW_ACCOUNT_ID;
    const resultados = [];
    for (const m of alvo) {
      try {
        let r;
        if (m.tipo === 'imagem' && m.imageUrl) {
          r = await enviarImagemDireta(numeroLimpo, m.imageUrl, m.mensagem, acc);
        } else {
          r = await enviarMensagemDireta(numeroLimpo, m.mensagem, acc);
        }
        resultados.push({ id: m.id, ok: true, status: r.status });
      } catch (err) {
        const erro = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
        resultados.push({ id: m.id, ok: false, erro });
      }
      await new Promise((r) => setTimeout(r, 800)); // pausa entre envios diretos
    }
    const ok = resultados.filter((r) => r.ok).length;
    console.log(`[WZ-Teste] ${ok}/${resultados.length} enviadas para ${numeroLimpo}`);
    res.json({ ok: true, total: resultados.length, enviadas: ok, falhas: resultados.length - ok, resultados });
  } catch (err) {
    console.error('[WZ-Teste] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Sincroniza a sequência WZ lendo a página do Notion
app.post('/api/wz/sync-notion', async (req, res) => {
  const { notionUrl } = req.body || {};
  const url = notionUrl || (await lerConfigUrl());
  if (!url) return res.status(400).json({ error: 'notionUrl obrigatório (ou salve um padrão antes)' });
  try {
    const cache = await sincronizarComNotion(url);
    await salvarConfigUrl(url);
    console.log(`[WZ-Sync] ${cache.mensagens.length} mensagens sincronizadas do Notion`);
    res.json({
      ok: true,
      syncedAt: cache.syncedAt,
      totalMensagens: cache.mensagens.length,
      notionUrl: url,
      mensagens: cache.mensagens.map(({ id, label, tipo, dia, hora, min, offset, imageUrl }) => ({
        id, label, tipo, dia, hora, min, offset, imageUrl,
      })),
    });
  } catch (err) {
    console.error('[WZ-Sync] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Histórico das sequências já agendadas
app.get('/api/wz/historico', async (_req, res) => {
  try {
    res.json(await listarHistorico(20));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Valida a sequência sem agendar (usado pelo dashboard antes de apertar "Agendar")
app.get('/api/wz/validar', async (req, res) => {
  const { dataWebinario } = req.query;
  if (!dataWebinario) return res.status(400).json({ error: 'dataWebinario obrigatório' });
  try {
    const seq = await getSequencia();
    const r = await validarSequencia({ mensagens: seq, dataWebinario });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Agenda uma ou mais fases da sequência.
// Fases WZ/IN → Sendflow nativo (agendamento de mensagem)
// Fases RN/DS → agendador local (cron interno dispara no horário)
//
// Body: { releaseId, accountId, dataWebinario, fases: ['WZ','RN','DS','IN'], ignorarValidacao? }
app.post('/api/wz/agendar', async (req, res) => {
  const { releaseId, accountId, dataWebinario, fases, ignorarValidacao } = req.body;
  if (!releaseId || !dataWebinario) {
    return res.status(400).json({ error: 'releaseId e dataWebinario são obrigatórios' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataWebinario)) {
    return res.status(400).json({ error: 'dataWebinario deve estar no formato YYYY-MM-DD' });
  }
  const fasesAlvo = fases?.length ? fases : ['WZ', 'RN', 'DS', 'IN'];
  try {
    // 1. Validação pré-agendamento (só bloqueante se tiver fases de mensagem)
    const seq = await getSequencia();
    const validacao = await validarSequencia({ mensagens: seq, dataWebinario });
    if (!validacao.ok && !ignorarValidacao) {
      return res.status(400).json({
        error: 'Validação falhou. Corrija os erros ou re-envie com ignorarValidacao=true.',
        validacao,
      });
    }

    // 2. Divide por tipo de execução
    const fasesMensagens = fasesAlvo.filter((f) => ['WZ', 'IN'].includes(f));
    const fasesLocais = fasesAlvo.filter((f) => ['RN', 'DS'].includes(f));

    const resultadosMensagens = [];
    const resultadosLocais = [];

    // 2a. Mensagens (WZ/IN) via Sendflow
    if (fasesMensagens.length) {
      const r = await agendarSequenciaWZ({
        releaseId,
        accountId: accountId || process.env.SENDFLOW_ACCOUNT_ID,
        dataWebinario,
        fases: fasesMensagens,
      });
      resultadosMensagens.push(...r);
    }

    // 2b. Renames e Descrições via agendador local
    let puladosPassado = [];
    if (fasesLocais.length) {
      const cfg = await lerConfig();
      const vars = {
        data: formatarDataBR(dataWebinario),
        hora: cfg.horaWebinario ?? 20,
        nome_base: cfg.nomeBase || '',
        link_inscricao: cfg.linkInscricao || '',
      };
      const agora = Date.now();
      const todas = seq
        .filter((w) => fasesLocais.includes(w.prefixo))
        .map((w) => {
          const [y, m, d] = dataWebinario.split('-').map(Number);
          const at = new Date(Date.UTC(y, m - 1, d + w.offset, (w.hora ?? 0) + 3, w.min ?? 0)).toISOString();
          return {
            id: w.id,
            prefixo: w.prefixo,
            tipoAcao: w.tipoAcao,
            scheduledTo: at,
            releaseId,
            accountId: accountId || process.env.SENDFLOW_ACCOUNT_ID,
            mensagem: aplicarVariaveis(w.mensagem, vars),
            label: w.label,
          };
        });

      // Separa ações cujo horário já passou (não agendar, só reportar)
      const acoes = todas.filter((a) => new Date(a.scheduledTo).getTime() > agora);
      puladosPassado = todas.filter((a) => new Date(a.scheduledTo).getTime() <= agora)
        .map((a) => ({ id: a.id, label: a.label, scheduledTo: a.scheduledTo }));

      if (acoes.length) {
        const r = await agendarAcoes(acoes);
        resultadosLocais.push(...r);
      }
    }

    const totalResultados = [...resultadosMensagens, ...resultadosLocais];
    const ok = totalResultados.filter((r) => r.ok).length;
    const falhas = totalResultados.filter((r) => !r.ok).length;
    console.log(`[WZ] ${ok} agendadas, ${falhas} falhas | fases ${fasesAlvo.join(',')} | campanha ${releaseId} | webinário ${dataWebinario}`);

    // 3. Registra no histórico
    try {
      const { registrarHistorico } = await import('./wz-historico.js');
      await registrarHistorico({ releaseId, accountId, dataWebinario, resultados: totalResultados, validacao, fases: fasesAlvo });
    } catch {}

    res.json({
      ok: true,
      fases: fasesAlvo,
      total: totalResultados.length,
      agendadas: ok,
      falhas,
      puladosPassado: puladosPassado || [],
      mensagens: resultadosMensagens,
      locais: resultadosLocais,
      validacao,
    });
  } catch (err) {
    console.error('[WZ] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Proxy de imagens (para URLs sem extensão, ex: ImageKit) ───
// Sendflow exige extensão no caminho da URL (ex: .jpg). Este proxy serve
// imagens de qualquer origem com um path terminado em .jpg.
// Uso: GET /img/nome-qualquer.jpg?src=<URL-da-imagem-codificada>
app.get('/img/:name', async (req, res) => {
  const src = req.query.src;
  if (!src) return res.status(400).send('Missing src parameter');

  let srcUrl;
  try {
    srcUrl = decodeURIComponent(src);
    // Aceita apenas URLs do ImageKit para segurança
    if (!srcUrl.startsWith('https://ik.imagekit.io/')) {
      return res.status(403).send('Only ImageKit URLs are allowed');
    }
  } catch {
    return res.status(400).send('Invalid src parameter');
  }

  try {
    const response = await fetch(srcUrl);
    if (!response.ok) return res.status(502).send(`Upstream error: ${response.status}`);
    const ct = response.headers.get('content-type') || 'image/jpeg';
    res.set('Content-Type', ct);
    res.set('Cache-Control', 'public, max-age=86400');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[ImgProxy] Erro:', err.message);
    res.status(500).send(err.message);
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

// ─── Cron: dispara renames e descrições agendados (a cada minuto) ───
cron.schedule('* * * * *', async () => {
  try {
    const r = await executarPendentes();
    if (r.executadas > 0 || r.falhas > 0) {
      console.log(`[Cron WZ-Agendador] ${r.executadas} executadas, ${r.falhas} falhas`);
    }
  } catch (err) {
    console.error('[Cron WZ-Agendador] Erro:', err.message);
  }
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
