/**
 * Leads, pesquisa de qualificação e atribuição por anúncio.
 *
 * Fluxo:
 *   1. Página de captação envia POST /api/trafego/lead com { telefone, nome, email, ad_id, adset_id, campaign_id,
 *      fbclid, fbp, utm_*, respostas: { pergunta: resposta } } (ou a pesquisa chega depois em /api/trafego/pesquisa).
 *   2. Cada lead recebe um score (0-100) pela pesquisa + bônus de comportamento (grupo, aula, clique).
 *   3. Leads com score >= metas.lancamento.score_minimo_qualificado viram evento "LeadQualificado" na Conversions API,
 *      uma única vez, e contam como lead qualificado no anúncio de origem.
 *
 * Persistência: data/trafego-leads.json (ignorado pelo git, sobrevive a deploy).
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const LEADS_PATH = join(DATA_DIR, 'trafego-leads.json');

let cache = null;
let fila = Promise.resolve();

async function ler() {
  if (cache) return cache;
  try { cache = JSON.parse(await readFile(LEADS_PATH, 'utf-8')); } catch { cache = { leads: [] }; }
  if (!Array.isArray(cache.leads)) cache.leads = [];
  return cache;
}

async function salvar(db) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(LEADS_PATH, JSON.stringify(db, null, 2), 'utf-8');
  cache = db;
}

/** Serializa escritas para não corromper o JSON com requisições simultâneas. */
function comLock(fn) {
  const p = fila.then(fn, fn);
  fila = p.catch(() => {});
  return p;
}

export function normalizarTelefone(t) {
  let d = String(t || '').replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  return d;
}

function normalizarTexto(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Score da pesquisa (0-100) segundo metas.pesquisa.perguntas.
 * Perguntas sem resposta não entram na média. Resposta desconhecida vale 0 e é registrada em `desconhecidas`.
 */
export function pontuarPesquisa(respostas = {}, cfgPesquisa) {
  const perguntas = cfgPesquisa?.perguntas || {};
  let somaPesos = 0;
  let soma = 0;
  const desconhecidas = [];
  for (const [chave, cfg] of Object.entries(perguntas)) {
    const respostaBruta = respostas[chave] ?? respostas[normalizarTexto(chave)];
    if (respostaBruta === undefined || respostaBruta === null || respostaBruta === '') continue;
    const resp = normalizarTexto(respostaBruta);
    const mapa = {};
    for (const [k, v] of Object.entries(cfg.respostas || {})) mapa[normalizarTexto(k)] = Number(v);
    let valor = mapa[resp];
    if (valor === undefined) {
      // tenta match parcial (resposta contém a chave ou vice-versa)
      const hit = Object.keys(mapa).find((k) => resp.includes(k) || k.includes(resp));
      valor = hit !== undefined ? mapa[hit] : 0;
      if (hit === undefined) desconhecidas.push(`${chave}=${respostaBruta}`);
    }
    const peso = Number(cfg.peso || 1);
    somaPesos += peso;
    soma += peso * valor;
  }
  const score = somaPesos ? Math.round(soma / somaPesos) : null;
  return { score, desconhecidas, respondidas: somaPesos > 0 };
}

/** Score final = pesquisa + bônus de comportamento, limitado a 0-100. */
export function scoreFinal(lead, cfgPesquisa) {
  const base = lead.score_pesquisa ?? 0;
  const bonus = cfgPesquisa?.bonus || {};
  let extra = 0;
  for (const [ev, v] of Object.entries(bonus)) if (lead.eventos?.[ev]) extra += Number(v);
  return Math.max(0, Math.min(100, Math.round(base + extra)));
}

/**
 * Registra ou atualiza um lead. Chave: telefone (ou email se não houver telefone).
 */
export async function registrarLead(dados, metas) {
  return comLock(async () => {
    const db = await ler();
    const telefone = normalizarTelefone(dados.telefone);
    const email = dados.email ? normalizarTexto(dados.email) : '';
    if (!telefone && !email) throw new Error('telefone ou email obrigatório');
    let lead = db.leads.find((l) => (telefone && l.telefone === telefone) || (email && l.email === email));
    const agora = new Date().toISOString();
    if (!lead) {
      lead = {
        id: randomUUID(),
        telefone, email,
        nome: dados.nome || '',
        cliente: dados.cliente || null,
        criado_em: agora,
        eventos: {},
        respostas: {},
        score_pesquisa: null,
        score: 0,
        qualificado: false,
        qualificado_enviado_em: null,
        compra: null,
      };
      db.leads.push(lead);
    }
    // Atribuição: só grava se veio algo (nunca sobrescreve origem conhecida com vazio).
    for (const k of ['ad_id', 'adset_id', 'campaign_id', 'fbclid', 'fbp', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ip', 'user_agent', 'url']) {
      if (dados[k] && !lead[k]) lead[k] = dados[k];
    }
    // utm_content = {{ad.id}} é o padrão de etiqueta por anúncio.
    if (!lead.ad_id && lead.utm_content && /^\d{6,}$/.test(String(lead.utm_content))) lead.ad_id = String(lead.utm_content);
    if (dados.nome && !lead.nome) lead.nome = dados.nome;
    if (dados.cliente && !lead.cliente) lead.cliente = dados.cliente;

    if (dados.respostas && typeof dados.respostas === 'object') {
      lead.respostas = { ...lead.respostas, ...dados.respostas };
      const p = pontuarPesquisa(lead.respostas, metas.pesquisa);
      if (p.respondidas) lead.score_pesquisa = p.score;
      if (p.desconhecidas.length) lead.respostas_desconhecidas = p.desconhecidas;
      lead.pesquisa_em = agora;
    }
    for (const ev of dados.eventos || []) {
      lead.eventos[ev] = lead.eventos[ev] || agora;
    }
    lead.score = scoreFinal(lead, metas.pesquisa);
    lead.qualificado = lead.score >= Number(metas.lancamento?.score_minimo_qualificado ?? 60);
    lead.atualizado_em = agora;
    await salvar(db);
    return lead;
  });
}

/** Marca um evento de comportamento (entrou_no_grupo, ficou_24h, clicou_link, compareceu_aula, saiu_do_grupo). */
export async function marcarEvento(telefoneOuEmail, evento, metas, extra = {}) {
  return registrarLead({ telefone: telefoneOuEmail, email: extra.email, eventos: [evento], cliente: extra.cliente }, metas);
}

/** Registra compra (do webhook Hotmart/Utmify) e devolve o lead, para atribuição retroativa. */
export async function registrarCompra({ telefone, email, valor, moeda = 'BRL', pedido, quando }, metas) {
  return comLock(async () => {
    const db = await ler();
    const tel = normalizarTelefone(telefone);
    const em = email ? normalizarTexto(email) : '';
    let lead = db.leads.find((l) => (tel && l.telefone === tel) || (em && l.email === em));
    if (!lead) {
      lead = { id: randomUUID(), telefone: tel, email: em, nome: '', criado_em: new Date().toISOString(), eventos: {}, respostas: {}, score: 0, qualificado: false };
      db.leads.push(lead);
    }
    lead.compra = { valor: Number(valor || 0), moeda, pedido: pedido || null, quando: quando || new Date().toISOString() };
    lead.score = 100;
    lead.qualificado = true;
    await salvar(db);
    return lead;
  });
}

/** Leads qualificados ainda não enviados para a Conversions API. */
export async function pendentesCAPI() {
  const db = await ler();
  return db.leads.filter((l) => l.qualificado && !l.qualificado_enviado_em);
}

export async function marcarEnviadosCAPI(ids) {
  return comLock(async () => {
    const db = await ler();
    const agora = new Date().toISOString();
    for (const l of db.leads) if (ids.includes(l.id)) l.qualificado_enviado_em = agora;
    await salvar(db);
  });
}

/**
 * Contagem por anúncio na janela: { ad_id: { leads, qualificados, compras, receita } }.
 * Serve para enriquecer os insights do Meta com a verdade do funil.
 */
export async function contagemPorAd({ desde, cliente } = {}) {
  const db = await ler();
  const limite = desde ? new Date(desde).getTime() : 0;
  const mapa = {};
  for (const l of db.leads) {
    if (cliente && l.cliente && l.cliente !== cliente) continue;
    if (new Date(l.criado_em).getTime() < limite) continue;
    const chave = l.ad_id || l.utm_content || 'sem_atribuicao';
    mapa[chave] = mapa[chave] || { leads: 0, qualificados: 0, compras: 0, receita: 0, score_medio: 0, _soma: 0 };
    const m = mapa[chave];
    m.leads++;
    m._soma += Number(l.score || 0);
    if (l.qualificado) m.qualificados++;
    if (l.compra) { m.compras++; m.receita += Number(l.compra.valor || 0); }
  }
  for (const m of Object.values(mapa)) { m.score_medio = m.leads ? Math.round(m._soma / m.leads) : 0; delete m._soma; }
  return mapa;
}

export async function listarLeads({ limite = 200, cliente } = {}) {
  const db = await ler();
  return db.leads
    .filter((l) => !cliente || l.cliente === cliente)
    .slice(-limite)
    .reverse();
}

export async function resumoLeads({ desde } = {}) {
  const db = await ler();
  const limite = desde ? new Date(desde).getTime() : 0;
  const leads = db.leads.filter((l) => new Date(l.criado_em).getTime() >= limite);
  const total = leads.length;
  const comPesquisa = leads.filter((l) => l.score_pesquisa !== null && l.score_pesquisa !== undefined).length;
  const qualificados = leads.filter((l) => l.qualificado).length;
  const atribuidos = leads.filter((l) => l.ad_id).length;
  const compradores = leads.filter((l) => l.compra).length;
  return { total, com_pesquisa: comPesquisa, qualificados, atribuidos, compradores, taxa_qualificacao: total ? qualificados / total : 0 };
}
