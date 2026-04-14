import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import cron from 'node-cron';
import { atualizarDestinoLink } from './switchy.js';
import { criarGrupoWebinario, enviarMensagemDireta } from './sendflow.js';
import {
  criarWebinario as criarWebinarioNotion,
  atualizarWebinario,
  buscarWebinarioPorData,
} from './notion.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');
const cronTasks = {}; // { [id]: ScheduledTask }

// ─── Config raw ───

async function lerConfigRaw() {
  try {
    return JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

async function salvarConfigRaw(cfg) {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ─── Migração automática (objeto único → array) ───

async function migrarSeNecessario() {
  const cfg = await lerConfigRaw();
  if (cfg.webinario && !cfg.webinarios) {
    cfg.webinarios = [{ id: 'default', nome_cliente: 'Principal', ...cfg.webinario }];
    delete cfg.webinario;
    await salvarConfigRaw(cfg);
    // Migrar state file
    try {
      const oldState = await readFile(join(__dirname, 'webinario-state.json'), 'utf-8');
      await writeFile(join(__dirname, 'webinario-state-default.json'), oldState, 'utf-8');
    } catch {}
    console.log('[Webinário] Config migrada para multi-cliente.');
  }
}

// ─── CRUD de webinários ───

export async function lerWebinarios() {
  await migrarSeNecessario();
  const cfg = await lerConfigRaw();
  return cfg.webinarios || [];
}

export async function lerWebinario(id) {
  const lista = await lerWebinarios();
  return lista.find(w => w.id === id) || null;
}

export async function salvarWebinario(id, novosDados) {
  await migrarSeNecessario();
  const cfg = await lerConfigRaw();
  const webinarios = cfg.webinarios || [];
  const idx = webinarios.findIndex(w => w.id === id);
  if (idx >= 0) {
    webinarios[idx] = { ...webinarios[idx], ...novosDados, id };
  } else {
    webinarios.push({ id, ...novosDados });
  }
  cfg.webinarios = webinarios;
  await salvarConfigRaw(cfg);
}

export async function criarNovoWebinario(dados) {
  await migrarSeNecessario();
  const cfg = await lerConfigRaw();
  const webinarios = cfg.webinarios || [];
  const id = dados.id || `webinario-${Date.now()}`;
  webinarios.push({ ativo: false, ...dados, id });
  cfg.webinarios = webinarios;
  await salvarConfigRaw(cfg);
  return id;
}

export async function deletarWebinario(id) {
  const cfg = await lerConfigRaw();
  cfg.webinarios = (cfg.webinarios || []).filter(w => w.id !== id);
  await salvarConfigRaw(cfg);
}

// ─── State por cliente ───

function statePath(id) {
  return join(__dirname, `webinario-state-${id}.json`);
}

async function lerEstadoLocal(id) {
  try {
    return JSON.parse(await readFile(statePath(id), 'utf-8'));
  } catch {
    return {};
  }
}

async function salvarEstadoLocal(id, data, dados) {
  const estado = await lerEstadoLocal(id);
  estado[data] = dados;
  await writeFile(statePath(id), JSON.stringify(estado, null, 2), 'utf-8');
}

export async function lerHistoricoLocal(id) {
  const estado = await lerEstadoLocal(id);
  return Object.entries(estado)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 10)
    .map(([data, d]) => ({
      dataWebinario: data,
      nome: d.nomeGrupo || '',
      linkGrupo: d.linkGrupo || null,
      campaignId: d.campaignId || '',
      status: 'criado',
      switchyAtualizado: d.switchyOk ?? false,
      observacoes: '',
    }));
}

// ─── Helpers ───

async function verificarCampanhaExiste(campaignId) {
  try {
    const res = await fetch(
      `${process.env.SENDFLOW_API_URL}/sendapi/releases/${campaignId}`,
      { headers: { Authorization: `Bearer ${process.env.SENDFLOW_API_TOKEN}` } }
    );
    return res.ok;
  } catch {
    return true;
  }
}

const DIAS_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

function proximaDataISO(diaSemana) {
  const spNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const diff = (diaSemana - spNow.getDay() + 7) % 7;
  const diasAte = diff + 7;
  const t = new Date(spNow);
  t.setDate(t.getDate() + diasAte);
  const y = t.getFullYear();
  const m = String(t.getMonth() + 1).padStart(2, '0');
  const d = String(t.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ─── Fluxo principal ───

export async function executarFluxoWebinario(id, { dataOverride } = {}) {
  const cfg = await lerWebinario(id);

  if (!cfg || !cfg.ativo) {
    console.log(`[Webinário:${id}] Inativo.`);
    return { ok: false, motivo: 'inativo' };
  }

  const dataISO = dataOverride || proximaDataISO(cfg.dia_semana);

  // Idempotência
  const estadoLocal = await lerEstadoLocal(id);
  if (estadoLocal[dataISO]) {
    const { campaignId: cid } = estadoLocal[dataISO];
    if (await verificarCampanhaExiste(cid)) {
      console.log(`[Webinário:${id}] Campanha ${cid} já existe para ${dataISO}.`);
      return { ok: false, motivo: 'duplicata', data: dataISO, ...estadoLocal[dataISO] };
    }
    console.log(`[Webinário:${id}] Campanha removida, recriando para ${dataISO}.`);
  }
  try {
    const existente = await buscarWebinarioPorData(dataISO);
    if (existente?.status === 'criado') {
      await salvarEstadoLocal(id, dataISO, { campaignId: existente.campaignId, linkGrupo: existente.linkGrupo });
      return { ok: false, motivo: 'duplicata', data: dataISO };
    }
  } catch {}

  const [, isoMes, isoDia] = dataISO.split('-');
  const horaWeb = cfg.hora_webinario.split(':')[0].padStart(2, '0');
  const nomeGrupo = `${cfg.nome_base} • Aula ${isoDia}.${isoMes} às ${horaWeb}h`;

  let pageId = null, linkGrupo = null, campaignId = null;

  // 6. Criar grupo SendFlow
  try {
    const r = await criarGrupoWebinario({
      accountId: process.env.SENDFLOW_ACCOUNT_ID,
      nome: nomeGrupo,
      descricao: cfg.descricao_grupo,
      fotoUrl: cfg.foto_grupo_url,
      adminNumero: cfg.numero_admin,
    });
    campaignId = r.data?.id;
    linkGrupo = r.data?.inviteLink;
    if (!campaignId || !linkGrupo) throw new Error(`Resposta inesperada: ${JSON.stringify(r.data)}`);
  } catch (err) {
    const obs = `Erro ao criar grupo: ${err.message}`;
    console.error(`[Webinário:${id}] ${obs}`);
    try { await criarWebinarioNotion({ nome: nomeGrupo, dataWebinario: `${dataISO}T${cfg.hora_webinario}:00-03:00`, status: 'erro', switchyAtualizado: false, observacoes: obs }); } catch {}
    try { await enviarMensagemDireta(cfg.numero_admin, `❌ Webinário\n\n${obs}`, process.env.SENDFLOW_ACCOUNT_ID); } catch {}
    return { ok: false, erro: obs };
  }

  await salvarEstadoLocal(id, dataISO, { campaignId, linkGrupo, nomeGrupo });

  // 7. Notion
  try {
    pageId = await criarWebinarioNotion({ nome: nomeGrupo, dataWebinario: `${dataISO}T${cfg.hora_webinario}:00-03:00`, linkGrupo, campaignId, status: 'criado', switchyAtualizado: false });
  } catch (err) {
    console.error(`[Webinário:${id}] Notion:`, err.message);
  }

  // 8. Switchy
  let switchyOk = false;
  try {
    await atualizarDestinoLink(cfg.switchy_link_id, linkGrupo, cfg.switchy_domain);
    switchyOk = true;
  } catch (err) {
    console.error(`[Webinário:${id}] Switchy:`, err.message);
    if (pageId) try { await atualizarWebinario(pageId, { observacoes: `Switchy falhou: ${err.message}` }); } catch {}
    try { await enviarMensagemDireta(cfg.numero_admin, `⚠️ Criado, mas Switchy falhou!\n\n*${nomeGrupo}*\n🔗 ${linkGrupo}\n\nErro: ${err.message}`, process.env.SENDFLOW_ACCOUNT_ID); } catch {}
  }

  if (switchyOk) await salvarEstadoLocal(id, dataISO, { campaignId, linkGrupo, nomeGrupo, switchyOk: true });
  if (switchyOk && pageId) try { await atualizarWebinario(pageId, { switchyAtualizado: true }); } catch {}

  // 10. WhatsApp
  const dataFormatada = `${DIAS_SEMANA[cfg.dia_semana]}, ${isoDia}/${isoMes} às ${horaWeb}h`;
  const mensagem = (cfg.mensagem_wpp || '')
    .replace('{nome_grupo}', nomeGrupo)
    .replace('{link_grupo}', linkGrupo)
    .replace('{data_webinario}', dataFormatada);
  try { await enviarMensagemDireta(cfg.numero_admin, mensagem, process.env.SENDFLOW_ACCOUNT_ID); } catch (err) { console.error(`[Webinário:${id}] WPP:`, err.message); }

  console.log(`[Webinário:${id}] ✅ ${nomeGrupo} | Switchy: ${switchyOk}`);
  return { ok: true, nomeGrupo, linkGrupo, campaignId, switchyOk };
}

// ─── Reenviar notificação ───

export async function reenviarNotificacao(id, campaignId) {
  const cfg = await lerWebinario(id);
  if (!cfg) throw new Error(`Webinário "${id}" não encontrado`);

  const estado = await lerEstadoLocal(id);
  const dataISO = Object.keys(estado).find(k => estado[k].campaignId === campaignId);
  if (!dataISO) throw new Error(`Campanha ${campaignId} não encontrada no histórico`);

  const { nomeGrupo, linkGrupo } = estado[dataISO];
  const [, isoMes, isoDia] = dataISO.split('-');
  const horaWeb = cfg.hora_webinario.split(':')[0].padStart(2, '0');
  const dataFormatada = `${DIAS_SEMANA[cfg.dia_semana]}, ${isoDia}/${isoMes} às ${horaWeb}h`;

  const mensagem = (cfg.mensagem_wpp || '')
    .replace('{nome_grupo}', nomeGrupo)
    .replace('{link_grupo}', linkGrupo)
    .replace('{data_webinario}', dataFormatada);

  await enviarMensagemDireta(cfg.numero_admin, mensagem, process.env.SENDFLOW_ACCOUNT_ID);
  return { ok: true };
}

// ─── Crons ───

export async function iniciarCronsWebinario() {
  for (const task of Object.values(cronTasks)) task.stop();
  Object.keys(cronTasks).forEach(k => delete cronTasks[k]);

  const webinarios = await lerWebinarios();
  const ativos = webinarios.filter(w => w.ativo);

  for (const w of ativos) {
    const [hora, min] = w.hora_corte.split(':').map(Number);
    const expressao = `${min} ${hora} * * ${w.dia_semana}`;
    cronTasks[w.id] = cron.schedule(expressao, async () => {
      console.log(`[Webinário:${w.id}] Cron disparado`);
      try { await executarFluxoWebinario(w.id); } catch (err) { console.error(`[Webinário:${w.id}] Erro cron:`, err.message); }
    }, { timezone: 'America/Sao_Paulo' });
    console.log(`[Webinário:${w.id}] Cron: "${expressao}" (SP)`);
  }

  if (!ativos.length) console.log('[Webinário] Nenhum cron registrado.');
}
