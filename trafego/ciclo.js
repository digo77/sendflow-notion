/**
 * Orquestrador da otimização de tráfego.
 *
 *   cicloHorario()  → coleta Meta + funil, aplica regras, envia leads qualificados/compras à CAPI,
 *                     executa ações autônomas (fora do modo sombra) e guarda os vereditos.
 *   cicloDiario()   → roda o cérebro (IA), manda o resumo em dinheiro no WhatsApp e pede aprovação
 *                     das ações que precisam de "SIM".
 *   executarAcaoTrafego(dados) → executa uma ação aprovada.
 */
import { readFile } from 'node:fs/promises';
import { enviarMensagemDireta } from '../sendflow.js';
import * as meta from './meta.js';
import * as leads from './leads.js';
import * as estado from './estado.js';
import { veredito, planejarAcoes, mapaAlocacao } from './regras.js';
import { pensar } from './cerebro.js';
import { pedirAprovacao, limparExpiradosTrafego, descreverAcao } from './aprovacao.js';

const METAS_URL = new URL('./metas.json', import.meta.url);

export async function lerMetas() {
  return JSON.parse(await readFile(METAS_URL, 'utf-8'));
}

export function clientesAtivos(metas) {
  return Object.entries(metas.clientes || {})
    .filter(([k, c]) => !k.startsWith('_') && c && c.ativo && c.meta_ad_account_id)
    .map(([k, c]) => ({ chave: k, ...c }));
}

const brl = (v) => `R$${Number(v || 0).toFixed(0)}`;

/**
 * Coleta e cruza: insights por anúncio + budget/aprendizado do conjunto + funil real (leads/compras por ad).
 */
export async function coletar(cliente, metas) {
  const conta = cliente.meta_ad_account_id;
  const janela = Number(metas.janela_dias || 7);
  const [ads, adsets, campanhas] = await Promise.all([
    meta.insights(conta, { nivel: 'ad', dias: janela }),
    meta.adsets(conta),
    meta.campanhas(conta),
  ]);
  const desde = new Date(); desde.setDate(desde.getDate() - janela);
  const funil = await leads.contagemPorAd({ desde: desde.toISOString(), cliente: cliente.chave });
  const adsetPorId = new Map(adsets.map((a) => [a.id, a]));
  const campPorId = new Map(campanhas.map((c) => [c.id, c]));

  const linhas = [];
  for (const ad of ads) {
    const conj = adsetPorId.get(ad.adset_id) || {};
    const camp = campPorId.get(ad.campaign_id) || {};
    const f = funil[ad.id] || {};
    const receitaReal = Number(f.receita || 0);
    linhas.push({
      ...ad,
      tipo: cliente.tipo,
      budget_diario: conj.budget_diario || camp.budget_diario || null,
      budget_nivel: conj.budget_diario ? 'adset' : camp.budget_diario ? 'campaign' : null,
      em_aprendizado: !!conj.em_aprendizado,
      leads: Number(f.leads || ad.leads_meta || 0),
      leads_qualificados: Number(f.qualificados || 0),
      score_medio: f.score_medio || null,
      compras: Number(f.compras || ad.compras_meta || 0),
      receita: receitaReal || Number(ad.receita_meta || 0),
      receita_fonte: receitaReal ? 'funil' : ad.receita_meta ? 'meta' : 'nenhuma',
      ultima_escala_em: await estado.ultimaEscala(ad.adset_id),
    });
  }
  return { linhas, adsets, campanhas, funil };
}

/** Aplica regras a uma coleta e monta o plano. */
export async function analisar(cliente, metas, coleta) {
  const vereditos = coleta.linhas.map((l) => ({ ...veredito(l, metas, cliente), ...pick(l, ['adset_id', 'adset_name', 'campaign_id', 'campaign_name', 'budget_diario', 'budget_nivel', 'em_aprendizado', 'ultima_escala_em', 'ctr', 'frequencia', 'leads', 'leads_qualificados', 'receita', 'receita_fonte', 'compras', 'dias', 'score_medio']) }));
  const pausasHoje = await estado.pausasHoje(cliente.meta_ad_account_id);
  const plano = planejarAcoes(vereditos, metas, { pausas_hoje: pausasHoje });
  const alocacao = mapaAlocacao(vereditos);
  return { vereditos, plano, alocacao };
}

function pick(o, keys) {
  const r = {};
  for (const k of keys) if (o[k] !== undefined) r[k] = o[k];
  return r;
}

/** Envia leads qualificados pendentes para a Conversions API (uma vez por lead). */
export async function relayCAPI() {
  if (!process.env.META_PIXEL_ID || !process.env.META_ACCESS_TOKEN) return { enviados: 0, motivo: 'CAPI não configurada' };
  const pend = await leads.pendentesCAPI();
  if (!pend.length) return { enviados: 0 };
  const eventos = pend.map((l) => ({
    nome: l.compra ? 'Purchase' : 'LeadQualificado',
    quando: l.compra?.quando || l.pesquisa_em || l.atualizado_em || l.criado_em,
    telefone: l.telefone, email: l.email, fbclid: l.fbclid, fbp: l.fbp, ip: l.ip, userAgent: l.user_agent, url: l.url,
    valor: l.compra?.valor, moeda: l.compra?.moeda, eventId: `${l.compra ? 'purchase' : 'leadq'}-${l.id}`,
  }));
  const r = await meta.enviarEventosCAPI(eventos);
  await leads.marcarEnviadosCAPI(pend.map((l) => l.id));
  await estado.registrar({ tipo: 'capi', quantidade: pend.length, resultado: r });
  return { enviados: pend.length, resultado: r };
}

/**
 * Executa uma ação (aprovada ou autônoma). Nunca chamada sem passar pelos guardrails de planejarAcoes.
 */
export async function executarAcaoTrafego(dados) {
  const { tipo, alvo, parametros = {}, cliente } = dados;
  const conta = cliente?.meta_ad_account_id;
  let resultado;
  try {
    switch (tipo) {
      case 'pausar_ad_sem_resultado':
      case 'pausar_ad':
      case 'pausar_adset':
      case 'pausar_campaign':
        resultado = await meta.pausar(alvo.id);
        if (conta) await estado.contarPausaHoje(conta);
        break;
      case 'escalar': {
        const objetoId = dados.budget_nivel === 'campaign' ? alvo.campaign_id || alvo.id : alvo.adset_id || alvo.id;
        if (parametros.duplicar) {
          resultado = await meta.duplicarAdset(alvo.adset_id || alvo.id, { budgetDiarioBRL: parametros.novo_budget });
          if (resultado?.novoId) resultado.ativacao = await meta.ativar(resultado.novoId);
        } else {
          resultado = await meta.mudarBudgetDiario(objetoId, parametros.novo_budget);
        }
        await estado.marcarEscala(alvo.adset_id || alvo.id);
        break;
      }
      case 'reduzir': {
        const objetoId = dados.budget_nivel === 'campaign' ? alvo.campaign_id || alvo.id : alvo.adset_id || alvo.id;
        resultado = await meta.mudarBudgetDiario(objetoId, parametros.novo_budget);
        break;
      }
      case 'criar_ad':
        resultado = await meta.criarAdPausado(conta, {
          adsetId: alvo.id,
          nome: parametros.nome_sugerido,
          copy: parametros.copy_primaria,
          titulo: parametros.headline,
          linkUrl: parametros.link_url || cliente?.link_url,
          pageId: parametros.page_id || cliente?.page_id,
          adCreativeBaseId: parametros.creative_base_id,
        });
        break;
      case 'ativar_ad':
        resultado = await meta.ativar(alvo.id);
        break;
      default:
        throw new Error(`Ação desconhecida: ${tipo}`);
    }
    await estado.registrar({ tipo: 'acao', acao: tipo, alvo, parametros, motivo: dados.motivo, cliente: cliente?.nome, ok: true, resultado });
    return { ok: true, resultado };
  } catch (err) {
    await estado.registrar({ tipo: 'acao', acao: tipo, alvo, parametros, motivo: dados.motivo, cliente: cliente?.nome, ok: false, erro: err.message });
    return { ok: false, erro: err.message };
  }
}

/**
 * Ciclo de hora em hora.
 */
export async function cicloHorario() {
  const metas = await lerMetas();
  const st = await estado.lerEstado();
  const saida = { clientes: [], capi: null, pausado_geral: st.pausado_geral };
  if (!process.env.META_ACCESS_TOKEN) {
    saida.aviso = 'META_ACCESS_TOKEN ausente: só o funil de leads e a pesquisa estão ativos';
  }

  // CAPI independe de análise de conta.
  try { saida.capi = await relayCAPI(); } catch (err) { saida.capi = { erro: err.message }; }

  if (!process.env.META_ACCESS_TOKEN) { await estado.salvarCiclo({}); return saida; }

  for (const cliente of clientesAtivos(metas)) {
    try {
      const coleta = await coletar(cliente, metas);
      const analise = await analisar(cliente, metas, coleta);
      const executadas = [];
      if (!st.pausado_geral && !metas.guardrails.modo_sombra) {
        for (const acao of analise.plano.autonomas) {
          const r = await executarAcaoTrafego({ ...acao, cliente });
          executadas.push({ ...acao, ...r });
        }
      } else {
        for (const acao of analise.plano.autonomas) {
          await estado.registrar({ tipo: 'sombra', acao: acao.tipo, alvo: acao.alvo, motivo: acao.motivo, cliente: cliente.nome });
        }
      }
      saida.clientes.push({ cliente: cliente.nome, itens: analise.vereditos.length, alocacao: analise.alocacao, autonomas: analise.plano.autonomas.length, executadas, aprovacao: analise.plano.aprovacao.length, alertas: analise.plano.alertas.length });
      ultimaAnalise.set(cliente.chave, { em: new Date().toISOString(), cliente, coleta, analise });
    } catch (err) {
      saida.clientes.push({ cliente: cliente.nome, erro: err.message });
      await estado.registrar({ tipo: 'erro', fase: 'horario', cliente: cliente.nome, erro: err.message });
    }
  }
  limparExpiradosTrafego();
  await estado.salvarCiclo({});
  return saida;
}

/** Última análise por cliente, em memória, para o painel e o ciclo diário. */
export const ultimaAnalise = new Map();

function formatarRelatorio(cliente, analise, cerebro, idsAprovacao) {
  const a = analise.alocacao.por_veredito;
  const linha = (k, rot) => a[k] ? `${rot}: ${a[k].itens} (${brl(a[k].spend)}, ${a[k].share_pct}% do gasto)` : null;
  const partes = [
    `*Tráfego · ${cliente.nome}* — resumo do dia`,
    ``,
    cerebro.resumo_dinheiro,
    ``,
    `🔥 Queimando: ${brl(cerebro.queimando_por_semana_brl)}/sem   💰 Na mesa: ${brl(cerebro.na_mesa_por_semana_brl)}/sem`,
    ``,
    linha('MATAR', '🔴 Matar'), linha('ESCALAR', '🟢 Escalar'), linha('AJUSTAR', '🟡 Ajustar'), linha('OBSERVAR', '⚪ Observar'),
    ``,
  ].filter((x) => x !== null);
  if (cerebro.acoes_do_dia?.length) {
    partes.push(`*Ações de hoje:*`);
    cerebro.acoes_do_dia.forEach((ac, i) => partes.push(`${i + 1}. ${ac.acao.toUpperCase()} ${ac.alvo_nome} (${brl(ac.impacto_brl_semana)}/sem): ${ac.por_que}`));
    partes.push(``);
  }
  if (cerebro.alertas?.length) {
    partes.push(`*Alertas:*`, ...cerebro.alertas.slice(0, 5).map((x) => `• ${x}`), ``);
  }
  if (idsAprovacao.length) partes.push(`${idsAprovacao.length} pedido(s) de aprovação chegam em seguida.`);
  return partes.join('\n');
}

/**
 * Ciclo diário: cérebro + relatório + pedidos de aprovação.
 */
export async function cicloDiario({ enviar = true } = {}) {
  const metas = await lerMetas();
  const saida = [];
  for (const cliente of clientesAtivos(metas)) {
    try {
      let ua = ultimaAnalise.get(cliente.chave);
      if (!ua || Date.now() - new Date(ua.em).getTime() > 2 * 3600e3) {
        const coleta = await coletar(cliente, metas);
        const analise = await analisar(cliente, metas, coleta);
        ua = { em: new Date().toISOString(), cliente, coleta, analise };
        ultimaAnalise.set(cliente.chave, ua);
      }
      const { analise } = ua;
      const desde = new Date(); desde.setDate(desde.getDate() - Number(metas.janela_dias || 7));
      const cerebro = await pensar({
        cliente: { nome: cliente.nome, tipo: cliente.tipo, ticket_medio: cliente.ticket_medio },
        metas,
        vereditos: analise.vereditos,
        plano: analise.plano,
        alocacao: analise.alocacao,
        resumo_leads: cliente.tipo === 'lancamento' ? await leads.resumoLeads({ desde: desde.toISOString() }) : undefined,
        historico: await estado.historicoRecente(20),
      });

      // Pedidos de aprovação: ações das regras + anúncios novos sugeridos pela IA.
      const ids = [];
      for (const acao of analise.plano.aprovacao) {
        const v = analise.vereditos.find((x) => x.id === acao.alvo.id) || {};
        ids.push(await pedirAprovacao({ ...acao, alvo: { ...acao.alvo, adset_id: v.adset_id, campaign_id: v.campaign_id }, budget_nivel: v.budget_nivel }, { cliente, enviar }));
      }
      // Anúncios novos sugeridos pela IA: sempre com aprovação, e a mensagem vai depois do resumo.
      const anunciosNovos = (cerebro.anuncios_novos || []).map((an) => ({
        tipo: 'criar_ad',
        alvo: { id: an.adset_id, nome: an.adset_nome, nivel: 'adset' },
        parametros: { nome_sugerido: an.nome_sugerido, angulo: an.angulo, hook: an.hook, copy_primaria: an.copy_primaria, headline: an.headline },
        motivo: an.por_que,
      }));
      const relatorio = formatarRelatorio(cliente, analise, cerebro, [...ids, ...anunciosNovos]);
      if (enviar) await enviarMensagemDireta(process.env.SENDFLOW_NUMBER, relatorio);
      for (const acao of anunciosNovos) ids.push(await pedirAprovacao(acao, { cliente, enviar }));
      await estado.salvarCiclo({ relatorio, cerebro });
      await estado.registrar({ tipo: 'relatorio', cliente: cliente.nome, queimando: cerebro.queimando_por_semana_brl, na_mesa: cerebro.na_mesa_por_semana_brl, acoes: cerebro.acoes_do_dia?.length || 0, aprovacoes: ids.length, sem_ia: !!cerebro.sem_ia });
      saida.push({ cliente: cliente.nome, relatorio, cerebro, aprovacoes: ids });
    } catch (err) {
      await estado.registrar({ tipo: 'erro', fase: 'diario', cliente: cliente.nome, erro: err.message });
      saida.push({ cliente: cliente.nome, erro: err.message });
      if (enviar) await enviarMensagemDireta(process.env.SENDFLOW_NUMBER, `*Tráfego · ${cliente.nome}*: erro no ciclo diário: ${err.message}`).catch(() => {});
    }
  }
  return saida;
}
