import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
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
import { listarCampanhas as _listarCampanhasSendflow, enviarMensagemDireta, enviarImagemDireta, atualizarRelease, criarGrupoWebinario, obterCampanha } from './sendflow.js';

// Cache de 2 minutos para listarCampanhasSendflow — evita rate limit
let _sfCampanhasCache = null;
let _sfCampanhasCacheAt = 0;
const SF_CAMPANHAS_TTL = 2 * 60 * 1000;
async function listarCampanhasSendflow() {
  const now = Date.now();
  if (_sfCampanhasCache && (now - _sfCampanhasCacheAt) < SF_CAMPANHAS_TTL) return _sfCampanhasCache;
  const result = await _listarCampanhasSendflow();
  _sfCampanhasCache = result;
  _sfCampanhasCacheAt = now;
  return result;
}
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
import { sincronizarComNotion, lerCache, salvarCache, salvarConfigUrl, lerConfigUrl, lerConfig, salvarConfig, listarCampanhasConfig, removerConfigCampanha, limparCache } from './wz-notion.js';
import { aplicarVariaveis, formatarDataBR } from './wz-variaveis.js';
import { validarSequencia } from './wz-validar.js';
import { listarHistorico } from './wz-historico.js';
import { agendarAcoes, listarAgendados, executarPendentes, cancelarAgendado, forcarExecucao, retentarAgendado, lerBloqueio } from './wz-agendador.js';
import { testarConexao as testarSwitchy, listarLinks as listarLinksSwitchy, atualizarDestinoLink } from './switchy.js';
import {
  lerEverWebinarios,
  lerEverWebinario,
  salvarEverWebinario,
  criarEverWebinario,
  deletarEverWebinario,
  listarLeads,
  listarSessoes,
  registrarLead,
  reenviarConfirmacao,
  dispararLembretes,
} from './everwebinar.js';

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

const wzCronState = {
  ultimaExec: null,
  executadas: 0,
  falhas: 0,
  bloqueadoAte: null,
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

// ─── Sessão por cookie assinado (HMAC) — login persistente de 30 dias ───
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'sf_session';
function sessionSecret() {
  // Deriva o segredo das credenciais — muda a senha, invalida sessões antigas.
  return `${DASH_PASS || ''}::${DASH_USER || ''}::sf-session-v1`;
}
function assinarSessao(expMs) {
  const data = String(expMs);
  const sig = crypto.createHmac('sha256', sessionSecret()).update(data).digest('hex');
  return `${data}.${sig}`;
}
function sessaoValida(token) {
  if (!token || typeof token !== 'string') return false;
  const idx = token.indexOf('.');
  if (idx < 0) return false;
  const data = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const exp = parseInt(data, 10);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const esperado = crypto.createHmac('sha256', sessionSecret()).update(data).digest('hex');
  if (sig.length !== esperado.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado)); } catch { return false; }
}
function lerCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setCookieSessao(res) {
  const exp = Date.now() + SESSION_TTL_MS;
  const token = assinarSessao(exp);
  res.set('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

// ─── Middleware de autenticação (cookie de sessão OU Basic Auth) ───
// Rotas públicas: /webhook (x-webhook-secret), /health, /img/*, /login, /api/login
function requireDashAuth(req, res, next) {
  // Se DASHBOARD_USER/PASSWORD não definidos, desabilita auth (dev local)
  if (!DASH_USER || !DASH_PASS) return next();

  const rotasPublicas = ['/webhook', '/health', '/sala', '/inscrever', '/login', '/api/login'];
  const isEwPublic = (req.path.startsWith('/api/everwebinar/') && req.path.endsWith('/public'))
    || req.path.match(/^\/api\/everwebinar\/[^/]+\/registrar$/);
  if (rotasPublicas.includes(req.path) || req.path.startsWith('/img/') || isEwPublic) {
    return next();
  }

  // 1) Cookie de sessão (caminho normal — login persistente)
  const cookies = lerCookies(req);
  if (sessaoValida(cookies[SESSION_COOKIE])) return next();

  // 2) Basic Auth (compatibilidade — chamadas de API externas/scripts)
  const header = req.headers.authorization || '';
  const [scheme, creds] = header.split(' ');
  if (scheme === 'Basic' && creds) {
    try {
      const decoded = Buffer.from(creds, 'base64').toString('utf-8');
      const sep = decoded.indexOf(':');
      if (decoded.slice(0, sep) === DASH_USER && decoded.slice(sep + 1) === DASH_PASS) return next();
    } catch {}
  }

  // Navegação no browser → manda pra tela de login. API → 401 JSON.
  const querHtml = (req.headers.accept || '').includes('text/html');
  if (querHtml && req.method === 'GET') return res.redirect(302, '/login');
  return res.status(401).json({ error: 'Não autenticado' });
}

// Aplica auth globalmente (antes das rotas)
app.use(requireDashAuth);

// ─── Login / Logout ───
app.get('/login', (_req, res) => {
  res.sendFile(join(__dirname, 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { user, pass } = req.body || {};
  if (user === DASH_USER && pass === DASH_PASS) {
    setCookieSessao(res);
    return res.json({ ok: true });
  }
  return res.status(401).json({ error: 'Usuário ou senha incorretos' });
});

app.post('/api/logout', (_req, res) => {
  res.set('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`);
  res.json({ ok: true });
});

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
    wzCron: wzCronState,
  });
});

// ─── Config: chave API Sendflow ───────────────────────────────────────────
const KEY_FILE = join(__dirname, 'data', 'sendflow-key.json');

app.get('/api/config/sendflow-key', async (_req, res) => {
  try {
    let key = null;
    try { key = JSON.parse(await readFile(KEY_FILE, 'utf-8')).key; } catch {}
    const active = key || process.env.SENDFLOW_API_TOKEN || '';
    const masked = active.length > 8 ? active.slice(0, 8) + '…' + active.slice(-4) : '(não configurada)';
    res.json({ temOverride: !!key, masked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/config/sendflow-key', async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!key || key.trim().length < 10) return res.status(400).json({ error: 'Chave inválida' });
    const { mkdir: mkdirFs } = await import('node:fs/promises');
    await mkdirFs(dirname(KEY_FILE), { recursive: true });
    await writeFile(KEY_FILE, JSON.stringify({ key: key.trim() }), 'utf-8');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/config/sendflow-key', async (_req, res) => {
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(KEY_FILE).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/agendamentos', async (_req, res) => {
  try {
    const data = await buscarTodosAgendamentos();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extrai "DD.MM" ou "DD/MM" do nome da campanha (ex: "Aula 19.08 às 20h") e devolve "MM.DD" pra ordenar.
// Sem ano no nome — serve só como aproximação de recência dentro do calendário, não cronologia exata entre anos.
function extrairDataDoNome(nome) {
  const m = String(nome || '').match(/\b(\d{1,2})[.\/](\d{1,2})\b/);
  if (!m) return null;
  const dia = m[1].padStart(2, '0');
  const mes = m[2].padStart(2, '0');
  if (Number(mes) > 12 || Number(dia) > 31) return null;
  return `${mes}.${dia}`;
}

app.get('/api/campanhas', async (_req, res) => {
  try {
    const data = await buscarCampanhas();
    // Mais recente primeiro: 1) data extraída do nome, quando existe; 2) posição do Sendflow como aproximação
    // (mais negativo = mais recente, a julgar pelo padrão observado); 3) createdTime do Notion como último recurso.
    data.sort((a, b) => {
      const da = extrairDataDoNome(a.nome);
      const db = extrairDataDoNome(b.nome);
      if (da && db && da !== db) return db.localeCompare(da);
      if (da && !db) return -1;
      if (!da && db) return 1;
      if (typeof a.posicaoSendflow === 'number' && typeof b.posicaoSendflow === 'number' && a.posicaoSendflow !== b.posicaoSendflow) {
        return a.posicaoSendflow - b.posicaoSendflow;
      }
      return (b.createdTime || '').localeCompare(a.createdTime || '');
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agendamentos', async (req, res) => {
  try {
    const { nome, dataHora, tipoAcao, campanhaId, parametro, midiaUrl } = req.body;
    if (!nome || !dataHora || !tipoAcao || !campanhaId || !parametro) {
      return res.status(400).json({ error: 'Campos obrigatórios: nome, dataHora, tipoAcao, campanhaId, parametro' });
    }
    const id = await criarAgendamento({ nome, dataHora, tipoAcao, campanhaId, parametro, midiaUrl });
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
      midiaUrl: ag.midiaUrl,
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

app.get('/api/sendflow/release/:id', async (req, res) => {
  try {
    const r = await obterCampanha(req.params.id);
    res.status(r.status).json(r.data);
  } catch (err) {
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
    const cfg = await lerWebinario(req.params.id);
    const [workspaces, links] = await Promise.allSettled([
      testarSwitchy(),
      cfg?.switchy_domain ? listarLinksSwitchy(cfg.switchy_domain) : Promise.resolve([]),
    ]);
    res.json({
      ok: workspaces.status === 'fulfilled',
      workspaces: workspaces.value ?? [],
      links: links.value ?? [],
      linkId: cfg?.switchy_link_id || null,
      domain: cfg?.switchy_domain || null,
      error: workspaces.reason?.message,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/webinario/:id/retentar-switchy', async (req, res) => {
  try {
    const { linkGrupo } = req.body || {};
    if (!linkGrupo) return res.status(400).json({ error: 'linkGrupo obrigatório' });
    const cfg = await lerWebinario(req.params.id);
    if (!cfg?.switchy_link_id) return res.status(400).json({ error: 'switchy_link_id não configurado neste webinário' });
    const resultado = await atualizarDestinoLink(cfg.switchy_link_id, linkGrupo, cfg.switchy_domain);
    res.json({ ok: true, resultado });
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
  const dataWebinario = req.query.dataWebinario || req.query.dataReferencia || null;
  const { releaseId } = req.query;
  // Modo livre (mensagens com `absoluto`) não precisa de data. Só valida formato quando fornecida.
  if (dataWebinario && !/^\d{4}-\d{2}-\d{2}$/.test(dataWebinario)) {
    return res.status(400).json({ error: 'dataReferencia deve estar no formato YYYY-MM-DD' });
  }
  try {
    // Se não passou data, checa se a sequência é 100% absoluta (modo livre)
    if (!dataWebinario) {
      const seq = await getSequencia(releaseId);
      const precisaData = seq.some((w) => !w.absoluto);
      if (precisaData) return res.status(400).json({ error: 'dataReferencia obrigatório — há mensagens sem data absoluta no Notion' });
    }
    const items = await wzPreview(dataWebinario, releaseId);
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Retorna a lista de mensagens WZ (sem agendar)
app.get('/api/wz/mensagens', async (req, res) => {
  try {
    const seq = await getSequencia(req.query.releaseId);
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
    const { dataWebinario, dataReferencia, nomeOverride, descricaoInicial, fotoUrl, accountId, releaseId: releaseIdExistente } = req.body || {};
    const dataRef = dataReferencia || dataWebinario || null;

    // ── Vincular campanha já existente no Sendflow ──
    if (releaseIdExistente) {
      const cfg = await lerConfig();
      const patch = {};
      if (dataRef) patch.dataWebinario = dataRef;
      if (cfg.notionUrl) patch.notionUrl = cfg.notionUrl;
      if (cfg.nomeBase) patch.nomeBase = cfg.nomeBase;
      if (cfg.linkInscricao) patch.linkInscricao = cfg.linkInscricao;
      if (cfg.horaWebinario !== undefined) patch.horaWebinario = cfg.horaWebinario;
      await salvarConfig(patch, releaseIdExistente);
      try { const sf = await listarCampanhasSendflow(); await sincronizarCampanhas(sf.data); } catch {}
      console.log(`[Nova Campanha] ✅ vinculada: ${releaseIdExistente}`);
      return res.json({ ok: true, releaseId: releaseIdExistente, vinculado: true });
    }

    // ── Criar novo release no Sendflow ──
    const cfg = await lerConfig();
    const nomeBase = cfg.nomeBase || 'Campanha';
    let nome;
    if (nomeOverride) {
      nome = nomeOverride;
    } else if (dataRef && /^\d{4}-\d{2}-\d{2}$/.test(dataRef)) {
      const [, isoMes, isoDia] = dataRef.split('-');
      const hora = String(cfg.horaWebinario ?? 20).padStart(2, '0');
      nome = `${nomeBase} • ${isoDia}/${isoMes} às ${hora}h`;
    } else {
      nome = nomeBase;
    }

    const r = await criarGrupoWebinario({
      accountId: accountId || process.env.SENDFLOW_ACCOUNT_ID,
      nome,
      descricao: descricaoInicial || '',
      fotoUrl: fotoUrl || null,
    });

    try {
      const sf = await listarCampanhasSendflow();
      await sincronizarCampanhas(sf.data);
    } catch (err) {
      console.error('[Nova Campanha] erro ao sincronizar Notion:', err.message);
    }

    const patch = {};
    if (dataRef) patch.dataWebinario = dataRef;
    if (cfg.notionUrl) patch.notionUrl = cfg.notionUrl;
    if (cfg.nomeBase) patch.nomeBase = cfg.nomeBase;
    if (cfg.linkInscricao) patch.linkInscricao = cfg.linkInscricao;
    if (cfg.horaWebinario !== undefined) patch.horaWebinario = cfg.horaWebinario;
    await salvarConfig(patch, r.data.id);

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
// Se releaseId é passado, retorna config/cache específico daquela campanha
// (merged com defaults). Sem releaseId, retorna os defaults.
app.get('/api/wz/sync-status', async (req, res) => {
  try {
    const releaseId = req.query.releaseId || null;
    const cache = await lerCache(releaseId);
    const cfg = await lerConfig(releaseId);
    res.json({
      releaseId,
      notionUrl: cfg.notionUrl || null,
      nomeBase: cfg.nomeBase || '',
      linkInscricao: cfg.linkInscricao || '',
      horaWebinario: cfg.horaWebinario || 20,
      dataWebinario: cfg.dataWebinario || null,
      syncedAt: cache?.syncedAt || null,
      totalMensagens: cache?.mensagens?.length || 0,
      sourceUrl: cache?.sourceUrl || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista todas as campanhas que têm config salva (pra UI de cards)
app.get('/api/wz/campanhas', async (_req, res) => {
  try {
    const lista = await listarCampanhasConfig();
    // Busca nomes no Sendflow (melhor esforço — se falhar, devolve sem nome)
    let nomePorId = {};
    try {
      const sf = await listarCampanhasSendflow();
      const releases = Array.isArray(sf.data) ? sf.data : (sf.data?.data || sf.data?.releases || []);
      for (const r of releases) {
        if (r?.id && r?.name) nomePorId[r.id] = r.name;
      }
    } catch (e) {
      console.warn('[WZ-Campanhas] Sendflow list falhou:', e.message);
    }
    const resposta = lista.map((c) => {
      const msgs = c.cache?.mensagens || [];
      const modoLivre = msgs.length > 0 && msgs.every((m) => !!m.absoluto);
      return {
        releaseId: c.releaseId,
        nome: nomePorId[c.releaseId] || null,
        notionUrl: c.notionUrl || null,
        notionUrls: c.notionUrls || (c.notionUrl ? [c.notionUrl] : []),
        nomeBase: c.nomeBase || '',
        linkInscricao: c.linkInscricao || '',
        horaWebinario: c.horaWebinario ?? null,
        horaEvento: c.horaEvento ?? c.horaWebinario ?? null,
        dataReferencia: c.dataReferencia || c.dataWebinario || null,
        dataWebinario: c.dataWebinario || null,
        syncedAt: c.cache?.syncedAt || null,
        totalMensagens: msgs.length,
        modoLivre,
      };
    });
    // Mais recente primeiro — por data real da campanha; sem data fica no fim (desempate por syncedAt)
    resposta.sort((a, b) => {
      const da = a.dataReferencia || a.dataWebinario || '';
      const db = b.dataReferencia || b.dataWebinario || '';
      if (da !== db) return db.localeCompare(da);
      return (b.syncedAt || '').localeCompare(a.syncedAt || '');
    });
    res.json(resposta);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a config de uma campanha (reset). Não mexe nos agendados já criados.
app.delete('/api/wz/campanhas/:releaseId', async (req, res) => {
  try {
    await removerConfigCampanha(req.params.releaseId);
    await limparCache(req.params.releaseId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualiza UMA mensagem no cache: hora/min/absoluto, texto, imagem.
app.patch('/api/wz/mensagem', async (req, res) => {
  try {
    const { releaseId, id, hora, min, absoluto, mensagem, imageUrl, label } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id é obrigatório' });
    const cache = await lerCache(releaseId);
    if (!cache?.mensagens) return res.status(404).json({ error: 'Cache não encontrado pra campanha' });
    const msg = cache.mensagens.find((m) => m.id === id);
    if (!msg) return res.status(404).json({ error: `Mensagem ${id} não encontrada` });

    if (absoluto) {
      let iso;
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(absoluto)) {
        const [datePart, timePart] = absoluto.split('T');
        const [y, m, d] = datePart.split('-').map(Number);
        const [hh, mi] = timePart.split(':').map(Number);
        iso = new Date(Date.UTC(y, m - 1, d, hh + 3, mi)).toISOString();
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(absoluto)) {
        const prev = msg.absoluto ? new Date(msg.absoluto) : new Date();
        const h = hora != null ? Number(hora) : prev.getUTCHours() - 3;
        const mm = min != null ? Number(min) : prev.getUTCMinutes();
        const [y, m, d] = absoluto.split('-').map(Number);
        iso = new Date(Date.UTC(y, m - 1, d, h + 3, mm)).toISOString();
      } else {
        return res.status(400).json({ error: 'Formato de `absoluto` inválido (use YYYY-MM-DDTHH:MM)' });
      }
      msg.absoluto = iso;
      const local = new Date(iso);
      msg.hora = local.getUTCHours() - 3;
      if (msg.hora < 0) msg.hora += 24;
      msg.min = local.getUTCMinutes();
    } else {
      if (hora != null) msg.hora = Number(hora);
      if (min != null) msg.min = Number(min);
    }

    if (mensagem !== undefined) msg.mensagem = String(mensagem);
    if (imageUrl !== undefined) {
      msg.imageUrl = imageUrl || null;
      msg.tipo = imageUrl ? 'imagem' : 'texto';
    }
    if (label !== undefined) msg.label = String(label);

    await salvarCache(cache.mensagens, cache.sourceUrls || cache.sourceUrl, releaseId);
    res.json({ ok: true, mensagem: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cria uma ação manual (RN, DS, WZ ou LV) direto no cache — não precisa do Notion.
// Campos: releaseId, tipoAcao (enviar_mensagem|renomear_grupo|atualizar_descricao),
// absoluto (YYYY-MM-DDTHH:MM em Brasília), mensagem, imageUrl, label.
app.post('/api/wz/mensagem', async (req, res) => {
  try {
    const { releaseId, tipoAcao = 'enviar_mensagem', absoluto, mensagem = '', imageUrl = null, label = '' } = req.body || {};
    if (!absoluto || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(absoluto)) {
      return res.status(400).json({ error: 'absoluto obrigatório no formato YYYY-MM-DDTHH:MM (Brasília)' });
    }
    const cache = (await lerCache(releaseId)) || { mensagens: [], sourceUrls: [], sourceUrl: null };
    const mensagens = cache.mensagens || [];

    // Converte Brasília → UTC
    const [datePart, timePart] = absoluto.split('T');
    const [y, mo, d] = datePart.split('-').map(Number);
    const [hh, mi] = timePart.split(':').map(Number);
    const iso = new Date(Date.UTC(y, mo - 1, d, hh + 3, mi)).toISOString();

    // Prefixo e id — numera sequencialmente dentro do prefixo
    const prefixo =
      tipoAcao === 'renomear_grupo' ? 'RN' :
      tipoAcao === 'atualizar_descricao' ? 'DS' : 'LV';
    const prefixados = mensagens.filter((m) => (m.prefixo || '') === prefixo);
    const nums = prefixados.map((m) => parseInt(String(m.id).replace(prefixo, ''), 10)).filter(Number.isFinite);
    const nextNum = (nums.length ? Math.max(...nums) : 0) + 1;
    const id = `${prefixo}${nextNum}`;

    const novo = {
      id,
      prefixo,
      tipoAcao,
      dia: '',
      offset: null,
      absoluto: iso,
      label: label || (tipoAcao === 'renomear_grupo' ? 'Renomear grupo' : tipoAcao === 'atualizar_descricao' ? 'Atualizar descrição' : 'Mensagem manual'),
      tipo: imageUrl ? 'imagem' : 'texto',
      mensagem: String(mensagem),
      imageUrl: imageUrl || null,
      hora: hh,
      min: mi,
      origem: 'manual',
    };
    mensagens.push(novo);
    // Mantém a ordem cronológica
    mensagens.sort((a, b) => {
      const ta = a.absoluto ? new Date(a.absoluto).getTime() : 0;
      const tb = b.absoluto ? new Date(b.absoluto).getTime() : 0;
      return ta - tb;
    });

    await salvarCache(mensagens, cache.sourceUrls || cache.sourceUrl || [], releaseId);
    res.json({ ok: true, mensagem: novo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove uma mensagem do cache (qualquer origem).
app.delete('/api/wz/mensagem', async (req, res) => {
  try {
    const { releaseId, id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id é obrigatório' });
    const cache = await lerCache(releaseId);
    if (!cache?.mensagens) return res.status(404).json({ error: 'Cache não encontrado' });
    const antes = cache.mensagens.length;
    const filtradas = cache.mensagens.filter((m) => m.id !== id);
    if (filtradas.length === antes) return res.status(404).json({ error: `Mensagem ${id} não encontrada` });
    await salvarCache(filtradas, cache.sourceUrls || cache.sourceUrl || [], releaseId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Salva config das variáveis (nome_base, link_inscricao, hora_webinario, notionUrl,
// dataWebinario). Se releaseId for passado no body, salva só pra essa campanha.
app.post('/api/wz/config', async (req, res) => {
  try {
    const patch = {};
    const { nomeBase, linkInscricao, horaWebinario, horaEvento, notionUrl, dataWebinario, dataReferencia, releaseId } = req.body || {};
    if (nomeBase !== undefined) patch.nomeBase = nomeBase;
    if (linkInscricao !== undefined) patch.linkInscricao = linkInscricao;
    const hora = horaEvento ?? horaWebinario;
    if (hora !== undefined && hora !== '') patch.horaEvento = Number(hora);
    if (notionUrl !== undefined) patch.notionUrl = notionUrl;
    const dataRef = dataReferencia ?? dataWebinario;
    if (dataRef !== undefined) patch.dataWebinario = dataRef;
    const novo = await salvarConfig(patch, releaseId || undefined);
    res.json({ ok: true, config: novo, releaseId: releaseId || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lista agendamentos locais (RN e DS), opcionalmente filtra por status/releaseId
app.get('/api/wz/agendados', async (req, res) => {
  try {
    const { status, releaseId } = req.query;
    let lista = await listarAgendados({ status });
    if (releaseId) lista = lista.filter((e) => e.releaseId === releaseId);
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

// Reseta agendamento com erro para pendente (retry)
app.post('/api/wz/agendados/:id/retentar', async (req, res) => {
  try {
    const entrada = await retentarAgendado(req.params.id);
    res.json({ ok: true, entrada });
  } catch (err) {
    res.status(400).json({ error: err.message });
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
  const { numero, wzId, accountId, releaseId } = req.body || {};
  if (!numero) return res.status(400).json({ error: 'numero obrigatório (ex: 5511999999999)' });
  const numeroLimpo = String(numero).replace(/\D/g, '');
  if (numeroLimpo.length < 10) return res.status(400).json({ error: 'numero inválido' });

  try {
    const seq = await getSequencia(releaseId);
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
// Se releaseId for passado, grava cache/URL na campanha; senão no default.
app.post('/api/wz/sync-notion', async (req, res) => {
  const { notionUrl, notionUrls, releaseId } = req.body || {};
  // Normaliza pra array. Aceita: notionUrls: [] ou notionUrl: string
  let urls = Array.isArray(notionUrls) ? notionUrls.filter(Boolean) : [];
  if (!urls.length && notionUrl) urls = [notionUrl];
  if (!urls.length) {
    // Fallback: lê config salva (pode ser array ou string)
    const cfg = await lerConfig(releaseId);
    if (Array.isArray(cfg.notionUrls) && cfg.notionUrls.length) urls = cfg.notionUrls.filter(Boolean);
    else if (cfg.notionUrl) urls = [cfg.notionUrl];
  }
  if (!urls.length) return res.status(400).json({ error: 'notionUrl(s) obrigatório(s) (ou salve um padrão antes)' });
  try {
    const cache = await sincronizarComNotion(urls, releaseId);
    // Salva lista de URLs na config (+ mantém notionUrl como back-compat = primeira)
    await salvarConfig({ notionUrls: urls, notionUrl: urls[0] }, releaseId);
    const ignorados = cache.ignorados || [];
    console.log(`[WZ-Sync] ${cache.mensagens.length} mensagens sincronizadas de ${urls.length} Notion(s)${releaseId ? ` (campanha ${releaseId})` : ''}${ignorados.length ? ` · ${ignorados.length} cabeçalhos ignorados` : ''}`);
    res.json({
      ok: true,
      releaseId: releaseId || null,
      syncedAt: cache.syncedAt,
      totalMensagens: cache.mensagens.length,
      notionUrl: urls[0],
      notionUrls: urls,
      ignorados,
      mensagens: cache.mensagens.map(({ id, prefixo, label, tipo, dia, hora, min, offset, imageUrl, absoluto }) => ({
        id, prefixo, label, tipo, dia, hora, min, offset, imageUrl, absoluto,
      })),
    });
  } catch (err) {
    console.error('[WZ-Sync] Erro:', err.message);
    const status = err.code === 'notion_not_shared' ? 403
      : err.code === 'notion_unauthorized' ? 401
      : err.code === 'notion_invalid_url' ? 400
      : err.code === 'notion_rate_limit' ? 429
      : 500;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// Histórico das sequências já agendadas (aceita filtro por releaseId)
app.get('/api/wz/historico', async (req, res) => {
  try {
    const { releaseId } = req.query;
    let h = await listarHistorico(100);
    if (releaseId) h = h.filter((e) => e.releaseId === releaseId);
    res.json(h.slice(0, 20));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Valida a sequência sem agendar (usado pelo dashboard antes de apertar "Agendar")
app.get('/api/wz/validar', async (req, res) => {
  const dataWebinario = req.query.dataWebinario || req.query.dataReferencia;
  const { releaseId } = req.query;
  if (!dataWebinario) return res.status(400).json({ error: 'dataReferencia obrigatório' });
  try {
    const seq = await getSequencia(releaseId);
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
  const { releaseId, accountId, fases, ids, ignorarValidacao } = req.body;
  const dataWebinario = req.body.dataWebinario || req.body.dataReferencia || null;
  if (!releaseId) {
    return res.status(400).json({ error: 'releaseId é obrigatório' });
  }
  if (dataWebinario && !/^\d{4}-\d{2}-\d{2}$/.test(dataWebinario)) {
    return res.status(400).json({ error: 'dataReferencia deve estar no formato YYYY-MM-DD' });
  }
  // Modo livre: se não há dataWebinario, todas as mensagens alvo precisam ter `absoluto`
  if (!dataWebinario) {
    const seqCheck = await getSequencia(releaseId);
    const fasesCheck = fases?.length ? fases : null;
    const idsCheck = ids?.length ? ids : null;
    const alvo = seqCheck.filter((w) => {
      if (fasesCheck && !fasesCheck.includes(w.prefixo)) return false;
      if (idsCheck && !idsCheck.includes(w.id)) return false;
      return true;
    });
    const precisaData = alvo.some((w) => !w.absoluto);
    if (precisaData) return res.status(400).json({ error: 'dataReferencia obrigatório — há mensagens sem data absoluta' });
  }
  const fasesAlvo = fases?.length ? fases : ['WZ', 'RN', 'DS', 'DC', 'IN', 'LV'];
  try {
    // 1. Validação pré-agendamento — só quando há dataWebinario (modo webinar).
    // No modo livre (LV) as datas vêm do Notion, validação não se aplica.
    const seq = await getSequencia(releaseId);
    let validacao = { ok: true, erros: [], avisos: [] };
    if (dataWebinario) {
      validacao = await validarSequencia({ mensagens: seq.filter((w) => w.prefixo !== 'LV'), dataWebinario });
      if (!validacao.ok && !ignorarValidacao) {
        return res.status(400).json({
          error: 'Validação falhou. Corrija os erros ou re-envie com ignorarValidacao=true.',
          validacao,
        });
      }
    }

    // 2. Agendamento unificado — tudo via Sendflow nativo (WZ/IN/LV como mensagem,
    // RN como PUT release group.name + scheduled, DS como group.fixedDescription + scheduled).
    const r = await agendarSequenciaWZ({
      releaseId,
      accountId: accountId || process.env.SENDFLOW_ACCOUNT_ID,
      dataWebinario,
      fases: fasesAlvo,
      ids,
    });
    const resultadosMensagens = r.filter((x) => x.tipoAcao === 'enviar_mensagem' || !x.tipoAcao);
    const resultadosLocais = r.filter((x) => x.tipoAcao === 'renomear_grupo' || x.tipoAcao === 'atualizar_descricao');
    const puladosPassado = r.filter((x) => x.pulado).map((x) => ({ id: x.id, scheduledTo: x.scheduledTo }));

    const totalResultados = r;
    const ok = totalResultados.filter((r) => r.ok).length;
    const falhas = totalResultados.filter((r) => !r.ok).length;
    console.log(`[WZ] ${ok} agendadas, ${falhas} falhas | fases ${fasesAlvo.join(',')} | campanha ${releaseId} | webinário ${dataWebinario}`);
    if (falhas) {
      for (const f of totalResultados.filter((x) => !x.ok && !x.pulado)) {
        console.log(`  ✗ ${f.id} (${f.prefixo}/${f.tipoAcao || 'enviar_mensagem'}): ${f.erro || '(sem motivo)'}`);
      }
    }

    // Salva WZ/IN/LV no cache local para que o status "agendado" seja visível na UI
    const wzOk = resultadosMensagens.filter((x) => x.ok && x.scheduledTo);
    if (wzOk.length) {
      try {
        await agendarAcoes(wzOk.map((x) => ({
          id: x.id,
          prefixo: x.prefixo || 'WZ',
          tipoAcao: 'enviar_mensagem',
          scheduledTo: x.scheduledTo,
          releaseId,
          accountId: accountId || process.env.SENDFLOW_ACCOUNT_ID,
          mensagem: '',
          label: x.label || '',
        })));
      } catch {}
    }

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

// ─── EverWebinar ───

app.get('/api/everwebinar', async (_req, res) => {
  try { res.json(await lerEverWebinarios()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/everwebinar', async (req, res) => {
  try {
    const id = await criarEverWebinario(req.body);
    res.json({ ok: true, id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/everwebinar/:id/config', async (req, res) => {
  try {
    const cfg = await lerEverWebinario(req.params.id);
    if (!cfg) return res.status(404).json({ error: 'Não encontrado' });
    res.json(cfg);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/everwebinar/:id/config', async (req, res) => {
  try {
    await salvarEverWebinario(req.params.id, req.body);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/everwebinar/:id', async (req, res) => {
  try {
    await deletarEverWebinario(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Endpoint público (sem auth) — usado pela sala e pela página de inscrição
app.get('/api/everwebinar/:id/public', async (req, res) => {
  try {
    const cfg = await lerEverWebinario(req.params.id);
    if (!cfg) return res.status(404).json({ error: 'Não encontrado' });
    res.json({
      nome_cliente: cfg.nome_cliente || '',
      horario: cfg.horario || '20:00',
      duracao_minutos: cfg.duracao_minutos || 90,
      vturb_player_url: cfg.vturb_player_url || '',
      ativo: cfg.ativo || false,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Registro de lead (público — chamado pela página de inscrição ou webhook futuro)
app.post('/api/everwebinar/:id/registrar', async (req, res) => {
  try {
    const resultado = await registrarLead(req.params.id, req.body);
    res.json(resultado);
  } catch (err) {
    console.error('[EverWebinar] Registro falhou:', err.message);
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/everwebinar/:id/leads', async (req, res) => {
  try {
    const leads = await listarLeads(req.params.id, { data: req.query.data });
    res.json(leads);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/everwebinar/:id/sessoes', async (req, res) => {
  try {
    res.json(await listarSessoes(req.params.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/everwebinar/:id/reenviar/:leadId', async (req, res) => {
  try {
    const r = await reenviarConfirmacao(req.params.id, req.params.leadId);
    res.json(r);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── Páginas públicas EverWebinar ───

app.get('/sala', (_req, res) => {
  res.sendFile(join(__dirname, 'sala.html'));
});

app.get('/inscrever', (_req, res) => {
  res.sendFile(join(__dirname, 'inscricao.html'));
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
app.get('/agendamento', (_req, res) => {
  res.sendFile(join(__dirname, 'agendamento.html'));
});

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

// ─── Cron: lembretes EverWebinar (a cada minuto) ───
cron.schedule('* * * * *', async () => {
  try { await dispararLembretes(); } catch (err) { console.error('[Cron EverWebinar] Erro:', err.message); }
});

// ─── Cron: dispara renames e descrições agendados (a cada minuto) ───
cron.schedule('* * * * *', async () => {
  // Respeita bloqueio persistido em disco (sobrevive a restarts)
  const bloqDisco = await lerBloqueio();
  if (bloqDisco) { wzCronState.bloqueadoAte = bloqDisco; return; }
  if (wzCronState.bloqueadoAte && new Date(wzCronState.bloqueadoAte) > new Date()) return;
  try {
    const r = await executarPendentes();
    wzCronState.ultimaExec = new Date().toISOString();
    wzCronState.executadas = r.executadas;
    wzCronState.falhas = r.falhas;
    if (r.bloqueadoAte) {
      wzCronState.bloqueadoAte = r.bloqueadoAte;
      console.warn(`[Cron WZ-Agendador] ⛔ API bloqueada até ${r.bloqueadoAte} — cron pausado`);
    } else if (wzCronState.bloqueadoAte && new Date(wzCronState.bloqueadoAte) < new Date()) {
      wzCronState.bloqueadoAte = null;
    }
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
