/**
 * Cliente da Meta Marketing API + Conversions API.
 *
 * Env necessário:
 *   META_ACCESS_TOKEN   token de usuário do sistema (Business Manager) com ads_read + ads_management
 *   META_PIXEL_ID       pixel/dataset para receber eventos pela Conversions API
 *   META_API_VERSION    opcional, padrão v21.0
 *
 * Todas as funções de escrita respeitam TRAFEGO_DRY_RUN=1 (não chamam a API, só logam).
 */
import axios from 'axios';
import { createHash } from 'node:crypto';

const BASE = () => `https://graph.facebook.com/${process.env.META_API_VERSION || 'v21.0'}`;
const TOKEN = () => process.env.META_ACCESS_TOKEN;
const DRY = () => process.env.TRAFEGO_DRY_RUN === '1';

function exigirToken() {
  if (!TOKEN()) throw new Error('META_ACCESS_TOKEN não configurado no .env');
}

async function get(path, params = {}) {
  exigirToken();
  const res = await axios.get(`${BASE()}/${path}`, {
    params: { access_token: TOKEN(), ...params },
    timeout: 30000,
  });
  return res.data;
}

async function post(path, body = {}) {
  exigirToken();
  if (DRY()) {
    console.log(`[Meta DRY-RUN] POST ${path}`, JSON.stringify(body).slice(0, 300));
    return { dry_run: true, path, body };
  }
  const res = await axios.post(`${BASE()}/${path}`, null, {
    params: { access_token: TOKEN(), ...body },
    timeout: 30000,
  });
  return res.data;
}

/** Percorre paginação do Graph API. */
async function todasPaginas(path, params) {
  const itens = [];
  let data = await get(path, params);
  itens.push(...(data.data || []));
  while (data.paging?.next) {
    const res = await axios.get(data.paging.next, { timeout: 30000 });
    data = res.data;
    itens.push(...(data.data || []));
  }
  return itens;
}

const CAMPOS_INSIGHTS = [
  'campaign_id', 'campaign_name', 'adset_id', 'adset_name', 'ad_id', 'ad_name',
  'spend', 'impressions', 'clicks', 'inline_link_clicks', 'ctr', 'inline_link_click_ctr', 'cpm', 'frequency', 'reach',
  'actions', 'action_values', 'purchase_roas', 'date_start', 'date_stop',
].join(',');

function extrairAcao(actions, tipo) {
  if (!Array.isArray(actions)) return 0;
  const a = actions.find((x) => x.action_type === tipo);
  return a ? Number(a.value) : 0;
}

function normalizarInsight(row, nivel) {
  const id = nivel === 'ad' ? row.ad_id : nivel === 'adset' ? row.adset_id : row.campaign_id;
  const nome = nivel === 'ad' ? row.ad_name : nivel === 'adset' ? row.adset_name : row.campaign_name;
  return {
    id,
    nome,
    nivel,
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    adset_id: row.adset_id,
    adset_name: row.adset_name,
    spend: Number(row.spend || 0),
    impressoes: Number(row.impressions || 0),
    cliques: Number(row.inline_link_clicks || row.clicks || 0),
    ctr: Number(row.inline_link_click_ctr || row.ctr || 0),
    cpm: Number(row.cpm || 0),
    frequencia: Number(row.frequency || 0),
    alcance: Number(row.reach || 0),
    leads_meta: extrairAcao(row.actions, 'lead') + extrairAcao(row.actions, 'onsite_conversion.lead_grouped'),
    compras_meta: extrairAcao(row.actions, 'purchase') + extrairAcao(row.actions, 'offsite_conversion.fb_pixel_purchase'),
    receita_meta: extrairAcao(row.action_values, 'purchase') + extrairAcao(row.action_values, 'offsite_conversion.fb_pixel_purchase'),
    roas_meta: Array.isArray(row.purchase_roas) && row.purchase_roas[0] ? Number(row.purchase_roas[0].value) : 0,
    date_start: row.date_start,
    date_stop: row.date_stop,
  };
}

/**
 * Insights agregados de uma conta, por nível, para uma janela de dias terminando ontem.
 * Também devolve o período anterior (mesmo tamanho) para comparar CTR e CPM.
 */
export async function insights(adAccountId, { nivel = 'ad', dias = 7 } = {}) {
  const hoje = new Date();
  const fim = new Date(hoje); fim.setDate(fim.getDate() - 1);
  const ini = new Date(fim); ini.setDate(ini.getDate() - (dias - 1));
  const fimAnt = new Date(ini); fimAnt.setDate(fimAnt.getDate() - 1);
  const iniAnt = new Date(fimAnt); iniAnt.setDate(iniAnt.getDate() - (dias - 1));
  const iso = (d) => d.toISOString().slice(0, 10);

  const base = {
    level: nivel,
    fields: CAMPOS_INSIGHTS,
    limit: 500,
    filtering: JSON.stringify([{ field: `${nivel}.effective_status`, operator: 'IN', value: ['ACTIVE'] }]),
  };
  const atual = await todasPaginas(`${adAccountId}/insights`, { ...base, time_range: JSON.stringify({ since: iso(ini), until: iso(fim) }) });
  const anterior = await todasPaginas(`${adAccountId}/insights`, { ...base, time_range: JSON.stringify({ since: iso(iniAnt), until: iso(fimAnt) }) });
  const antPorId = new Map(anterior.map((r) => { const n = normalizarInsight(r, nivel); return [n.id, n]; }));

  // Dias com entrega: consulta diária para saber há quantos dias o objeto entrega.
  const diario = await todasPaginas(`${adAccountId}/insights`, {
    ...base, fields: `${nivel}_id,spend`, time_increment: 1,
    time_range: JSON.stringify({ since: iso(ini), until: iso(fim) }),
  });
  const diasPorId = new Map();
  for (const r of diario) {
    const id = r[`${nivel}_id`];
    if (Number(r.spend) > 0) diasPorId.set(id, (diasPorId.get(id) || 0) + 1);
  }

  return atual.map((r) => {
    const n = normalizarInsight(r, nivel);
    const ant = antPorId.get(n.id);
    return {
      ...n,
      dias: diasPorId.get(n.id) || 0,
      ctr_anterior: ant ? ant.ctr : null,
      cpm_anterior: ant ? ant.cpm : null,
      spend_anterior: ant ? ant.spend : 0,
    };
  });
}

/**
 * Status, budget e fase de aprendizado dos conjuntos ativos.
 */
export async function adsets(adAccountId) {
  const lista = await todasPaginas(`${adAccountId}/adsets`, {
    fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,learning_stage_info,campaign_id,optimization_goal,promoted_object',
    limit: 500,
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
  });
  return lista.map((a) => ({
    id: a.id,
    nome: a.name,
    campaign_id: a.campaign_id,
    budget_diario: a.daily_budget ? Number(a.daily_budget) / 100 : null,
    budget_total: a.lifetime_budget ? Number(a.lifetime_budget) / 100 : null,
    em_aprendizado: a.learning_stage_info?.status === 'LEARNING',
    status_aprendizado: a.learning_stage_info?.status || null,
    objetivo: a.optimization_goal,
  }));
}

/**
 * Campanhas ativas com budget (CBO).
 */
export async function campanhas(adAccountId) {
  const lista = await todasPaginas(`${adAccountId}/campaigns`, {
    fields: 'id,name,status,effective_status,daily_budget,lifetime_budget,objective',
    limit: 500,
    filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
  });
  return lista.map((c) => ({
    id: c.id,
    nome: c.name,
    budget_diario: c.daily_budget ? Number(c.daily_budget) / 100 : null,
    budget_total: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
    objetivo: c.objective,
  }));
}

/** Pausa um ad, adset ou campanha. */
export async function pausar(objetoId) {
  return post(objetoId, { status: 'PAUSED' });
}

/** Reativa um ad, adset ou campanha. */
export async function ativar(objetoId) {
  return post(objetoId, { status: 'ACTIVE' });
}

/** Muda o orçamento diário (em BRL) de um adset ou campanha CBO. */
export async function mudarBudgetDiario(objetoId, valorBRL) {
  return post(objetoId, { daily_budget: Math.round(Number(valorBRL) * 100) });
}

/**
 * Duplica um adset vencedor com novo budget, pausado (para aprovação/ativação depois).
 * Usa o endpoint /copies do Graph API.
 */
export async function duplicarAdset(adsetId, { budgetDiarioBRL, sufixo = ' [ESCALA]' } = {}) {
  const r = await post(`${adsetId}/copies`, {
    deep_copy: true,
    status_option: 'PAUSED',
    rename_options: JSON.stringify({ rename_strategy: 'ONLY_TOP_LEVEL_RENAME', rename_suffix: sufixo }),
  });
  const novoId = r?.copied_adset_id || r?.ad_object_ids?.[0]?.copied_id;
  if (novoId && budgetDiarioBRL) await mudarBudgetDiario(novoId, budgetDiarioBRL);
  return { ...r, novoId };
}

/**
 * Cria um anúncio novo dentro de um adset, PAUSADO, reaproveitando o criativo de um ad existente
 * com copy nova. Devolve o id do ad criado. Ativação é ação separada (com aprovação).
 */
export async function criarAdPausado(adAccountId, { adsetId, nome, adCreativeBaseId, copy, titulo, linkUrl, pageId }) {
  const criativo = await post(`${adAccountId}/adcreatives`, {
    name: `${nome} - criativo`,
    object_story_spec: JSON.stringify({
      page_id: pageId,
      link_data: { message: copy, name: titulo, link: linkUrl, call_to_action: { type: 'LEARN_MORE', value: { link: linkUrl } } },
    }),
    ...(adCreativeBaseId ? { source_creative_id: adCreativeBaseId } : {}),
  });
  const ad = await post(`${adAccountId}/ads`, {
    name: nome,
    adset_id: adsetId,
    creative: JSON.stringify({ creative_id: criativo.id }),
    status: 'PAUSED',
  });
  return { adId: ad.id, creativeId: criativo.id };
}

// ─── Conversions API ───

function sha256(v) {
  return createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
}

/**
 * Envia eventos para a Conversions API.
 * eventos: [{ nome: 'Lead'|'LeadQualificado'|'Purchase', quando: Date|ISO, telefone, email, fbclid, fbp, ip, userAgent, valor, moeda, eventId, url }]
 */
export async function enviarEventosCAPI(eventos) {
  const pixel = process.env.META_PIXEL_ID;
  if (!pixel) throw new Error('META_PIXEL_ID não configurado no .env');
  const data = eventos.map((e) => {
    const userData = {};
    if (e.telefone) userData.ph = [sha256(String(e.telefone).replace(/\D/g, ''))];
    if (e.email) userData.em = [sha256(e.email)];
    if (e.fbclid) {
      const ts = Math.floor(new Date(e.quando || Date.now()).getTime() / 1000);
      userData.fbc = e.fbclid.startsWith('fb.') ? e.fbclid : `fb.1.${ts}000.${e.fbclid}`;
    }
    if (e.fbp) userData.fbp = e.fbp;
    if (e.ip) userData.client_ip_address = e.ip;
    if (e.userAgent) userData.client_user_agent = e.userAgent;
    const ev = {
      event_name: e.nome,
      event_time: Math.floor(new Date(e.quando || Date.now()).getTime() / 1000),
      action_source: 'website',
      event_id: e.eventId || undefined,
      event_source_url: e.url || undefined,
      user_data: userData,
    };
    if (e.valor) ev.custom_data = { value: Number(e.valor), currency: e.moeda || 'BRL' };
    return ev;
  });
  if (DRY()) {
    console.log(`[Meta DRY-RUN] CAPI ${data.length} evento(s)`, JSON.stringify(data).slice(0, 400));
    return { dry_run: true, events_received: data.length };
  }
  exigirToken();
  const res = await axios.post(`${BASE()}/${pixel}/events`, { data, access_token: TOKEN() }, { timeout: 30000 });
  return res.data;
}

/** Testa o token: devolve nome e contas acessíveis. */
export async function testarConexao() {
  const me = await get('me', { fields: 'id,name' });
  const contas = await todasPaginas('me/adaccounts', { fields: 'id,name,account_status,currency', limit: 100 });
  return { usuario: me, contas };
}
