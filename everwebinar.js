import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { enviarMensagemDireta } from './sendflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, 'config.json');

// ─── Config helpers ───

async function lerConfigRaw() {
  try { return JSON.parse(await readFile(CONFIG_PATH, 'utf-8')); } catch { return {}; }
}

async function salvarConfigRaw(cfg) {
  await writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ─── CRUD ───

export async function lerEverWebinarios() {
  const cfg = await lerConfigRaw();
  return cfg.everwebinarios || [];
}

export async function lerEverWebinario(id) {
  const lista = await lerEverWebinarios();
  return lista.find(w => w.id === id) || null;
}

export async function salvarEverWebinario(id, dados) {
  const cfg = await lerConfigRaw();
  const lista = cfg.everwebinarios || [];
  const idx = lista.findIndex(w => w.id === id);
  if (idx >= 0) {
    lista[idx] = { ...lista[idx], ...dados, id };
  } else {
    lista.push({ ativo: false, ...dados, id });
  }
  cfg.everwebinarios = lista;
  await salvarConfigRaw(cfg);
}

export async function criarEverWebinario(dados) {
  const cfg = await lerConfigRaw();
  const lista = cfg.everwebinarios || [];
  const id = `ew-${Date.now()}`;
  lista.push({ ativo: false, ...dados, id });
  cfg.everwebinarios = lista;
  await salvarConfigRaw(cfg);
  return id;
}

export async function deletarEverWebinario(id) {
  const cfg = await lerConfigRaw();
  cfg.everwebinarios = (cfg.everwebinarios || []).filter(w => w.id !== id);
  await salvarConfigRaw(cfg);
}

// ─── Leads ───

function leadsPath(id) {
  return join(__dirname, 'data', `ew-leads-${id}.json`);
}

async function lerLeads(id) {
  try { return JSON.parse(await readFile(leadsPath(id), 'utf-8')); } catch { return []; }
}

async function salvarLeads(id, leads) {
  await writeFile(leadsPath(id), JSON.stringify(leads, null, 2), 'utf-8');
}

export async function listarLeads(id, { data } = {}) {
  const leads = await lerLeads(id);
  const filtrados = data ? leads.filter(l => l.sessao_data === data) : leads;
  return filtrados.sort((a, b) => b.registrado_em.localeCompare(a.registrado_em));
}

export async function listarSessoes(id) {
  const leads = await lerLeads(id);
  const map = {};
  for (const l of leads) {
    if (!map[l.sessao_data]) map[l.sessao_data] = { data: l.sessao_data, hora: l.sessao_hora, inscritos: 0 };
    map[l.sessao_data].inscritos++;
  }
  return Object.values(map).sort((a, b) => b.data.localeCompare(a.data)).slice(0, 60);
}

// ─── Lógica de sessão ───

function agoraSP() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
}

export function calcularSessao(horario) {
  const agora = agoraSP();
  const [hh, mm] = (horario || '20:00').split(':').map(Number);

  const sessaoHoje = new Date(agora);
  sessaoHoje.setHours(hh, mm, 0, 0);

  const base = agora < sessaoHoje ? agora : (() => {
    const d = new Date(agora);
    d.setDate(d.getDate() + 1);
    return d;
  })();

  const sessao_data = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
  return { sessao_data, sessao_hora: horario || '20:00' };
}

function baseUrl() {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  if (process.env.CLOUDFLARE_TUNNEL_DOMAIN) return `https://${process.env.CLOUDFLARE_TUNNEL_DOMAIN}`;
  return `http://localhost:${process.env.WEBHOOK_PORT || 3001}`;
}

// ─── Registrar lead ───

export async function registrarLead(ewId, { nome, telefone, accountId } = {}) {
  const cfg = await lerEverWebinario(ewId);
  if (!cfg) throw new Error(`EverWebinário "${ewId}" não encontrado`);

  const tel = String(telefone || '').replace(/\D/g, '');
  if (!tel) throw new Error('Telefone obrigatório');

  const { sessao_data, sessao_hora } = calcularSessao(cfg.horario);
  const link_sala = `${baseUrl()}/sala?ew=${ewId}&s=${sessao_data}T${sessao_hora}`;

  const lead = {
    id: randomUUID(),
    nome: nome || '',
    telefone: tel,
    sessao_data,
    sessao_hora,
    link_sala,
    registrado_em: new Date().toISOString(),
    lembrete_1h_enviado: false,
    lembrete_10min_enviado: false,
    confirmacao_enviada: false,
  };

  const leads = await lerLeads(ewId);
  leads.push(lead);
  await salvarLeads(ewId, leads);

  if (cfg.mensagem_confirmacao && tel) {
    const dataFmt = sessao_data.split('-').reverse().join('/');
    const msg = cfg.mensagem_confirmacao
      .replace(/\{nome\}/g, nome || '')
      .replace(/\{link_sala\}/g, link_sala)
      .replace(/\{data\}/g, dataFmt)
      .replace(/\{hora\}/g, sessao_hora);
    try {
      await enviarMensagemDireta(tel, msg, accountId || process.env.SENDFLOW_ACCOUNT_ID);
      lead.confirmacao_enviada = true;
      await salvarLeads(ewId, leads);
    } catch (err) {
      console.error(`[EverWebinar:${ewId}] Confirmação falhou:`, err.message);
    }
  }

  console.log(`[EverWebinar:${ewId}] Lead registrado: ${tel} → sessão ${sessao_data} ${sessao_hora}`);
  return { ok: true, lead_id: lead.id, link_sala, sessao_data, sessao_hora, confirmacao_enviada: lead.confirmacao_enviada };
}

// ─── Reenviar confirmação ───

export async function reenviarConfirmacao(ewId, leadId) {
  const cfg = await lerEverWebinario(ewId);
  if (!cfg) throw new Error('EverWebinário não encontrado');

  const leads = await lerLeads(ewId);
  const lead = leads.find(l => l.id === leadId);
  if (!lead) throw new Error('Lead não encontrado');

  const msg = (cfg.mensagem_confirmacao || '')
    .replace(/\{nome\}/g, lead.nome || '')
    .replace(/\{link_sala\}/g, lead.link_sala || '')
    .replace(/\{data\}/g, lead.sessao_data.split('-').reverse().join('/'))
    .replace(/\{hora\}/g, lead.sessao_hora);

  await enviarMensagemDireta(lead.telefone, msg, process.env.SENDFLOW_ACCOUNT_ID);
  return { ok: true };
}

// ─── Lembretes (chamado pelo cron a cada minuto) ───

export async function dispararLembretes() {
  const lista = await lerEverWebinarios();
  const ativos = lista.filter(w => w.ativo);

  for (const ew of ativos) {
    const leads = await lerLeads(ew.id);
    let alterado = false;
    const agora = new Date();

    for (const lead of leads) {
      const sessaoDate = new Date(`${lead.sessao_data}T${lead.sessao_hora}:00-03:00`);
      const diffMin = (sessaoDate - agora) / 60000;

      if (!lead.lembrete_1h_enviado && diffMin >= 57 && diffMin <= 63 && ew.mensagem_lembrete_1h) {
        const msg = ew.mensagem_lembrete_1h
          .replace(/\{nome\}/g, lead.nome || '')
          .replace(/\{link_sala\}/g, lead.link_sala || '')
          .replace(/\{hora\}/g, lead.sessao_hora);
        try {
          await enviarMensagemDireta(lead.telefone, msg, process.env.SENDFLOW_ACCOUNT_ID);
          lead.lembrete_1h_enviado = true;
          alterado = true;
          console.log(`[EverWebinar:${ew.id}] Lembrete 1h → ${lead.telefone}`);
        } catch (err) {
          console.error(`[EverWebinar:${ew.id}] Lembrete 1h falhou (${lead.telefone}):`, err.message);
        }
      }

      if (!lead.lembrete_10min_enviado && diffMin >= 8 && diffMin <= 14 && ew.mensagem_lembrete_10min) {
        const msg = ew.mensagem_lembrete_10min
          .replace(/\{nome\}/g, lead.nome || '')
          .replace(/\{link_sala\}/g, lead.link_sala || '')
          .replace(/\{hora\}/g, lead.sessao_hora);
        try {
          await enviarMensagemDireta(lead.telefone, msg, process.env.SENDFLOW_ACCOUNT_ID);
          lead.lembrete_10min_enviado = true;
          alterado = true;
          console.log(`[EverWebinar:${ew.id}] Lembrete 10min → ${lead.telefone}`);
        } catch (err) {
          console.error(`[EverWebinar:${ew.id}] Lembrete 10min falhou (${lead.telefone}):`, err.message);
        }
      }
    }

    if (alterado) await salvarLeads(ew.id, leads);
  }
}
