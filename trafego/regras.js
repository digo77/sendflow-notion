/**
 * Motor de regras da otimização de tráfego.
 *
 * Puro: recebe métricas já agregadas e devolve vereditos e ações.
 * Não chama API nenhuma, então é testável sem rede (ver regras.test.js).
 *
 * Entrada (por anúncio ou conjunto):
 * {
 *   id, nome, nivel: 'ad'|'adset'|'campaign', tipo: 'lancamento'|'perpetuo',
 *   dias: número de dias com entrega,
 *   spend, impressoes, cliques, ctr (%), cpm, frequencia,
 *   leads, leads_qualificados, receita, compras,
 *   ctr_anterior (%), cpm_anterior, budget_diario, em_aprendizado (bool),
 *   ultima_escala_em (ISO | null)
 * }
 */

export const VEREDITO = {
  MATAR: 'MATAR',
  ESCALAR: 'ESCALAR',
  AJUSTAR: 'AJUSTAR',
  OBSERVAR: 'OBSERVAR',
};

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

/**
 * Lucro estimado de uma linha no perpétuo, descontando taxa e imposto.
 */
export function lucroEstimado(m, metas) {
  const p = metas.perpetuo;
  const receitaLiquida = num(m.receita) * (1 - num(p.taxa_plataforma)) * (1 - num(p.imposto));
  return receitaLiquida - num(m.spend);
}

/**
 * Métricas derivadas usadas em todos os vereditos.
 */
export function derivar(m, metas) {
  const spend = num(m.spend);
  const leads = num(m.leads);
  const leadsQ = num(m.leads_qualificados);
  const receita = num(m.receita);
  const compras = num(m.compras);
  return {
    cpl: leads ? spend / leads : null,
    cpl_qualificado: leadsQ ? spend / leadsQ : null,
    taxa_qualificacao: leads ? leadsQ / leads : null,
    roas: spend ? receita / spend : null,
    cpa: compras ? spend / compras : null,
    lucro: lucroEstimado(m, metas),
    queda_ctr_pct: m.ctr_anterior ? -pct(num(m.ctr), num(m.ctr_anterior)) : 0,
    alta_cpm_pct: m.cpm_anterior ? pct(num(m.cpm), num(m.cpm_anterior)) : 0,
  };
}

/**
 * Sinais de fadiga. Devolve lista de strings (vazia = sem fadiga).
 */
export function sinaisFadiga(m, metas) {
  const f = metas.fadiga;
  const d = derivar(m, metas);
  const sinais = [];
  if (num(m.frequencia) > num(f.frequencia_maxima_frio)) {
    sinais.push(`frequência ${num(m.frequencia).toFixed(1)} acima de ${f.frequencia_maxima_frio}`);
  }
  if (d.queda_ctr_pct > num(f.queda_ctr_pct)) {
    sinais.push(`CTR caiu ${d.queda_ctr_pct.toFixed(0)}% vs período anterior`);
  }
  if (d.alta_cpm_pct > num(f.alta_cpm_pct)) {
    sinais.push(`CPM subiu ${d.alta_cpm_pct.toFixed(0)}% vs período anterior`);
  }
  return sinais;
}

/**
 * Veredito de uma linha de LANÇAMENTO (captação). Otimiza por custo por lead qualificado.
 */
function vereditoLancamento(m, metas, cfgCliente) {
  const L = { ...metas.lancamento, ...(cfgCliente?.lancamento || {}) };
  const d = derivar(m, metas);
  const spend = num(m.spend);
  const leads = num(m.leads);
  const leadsQ = num(m.leads_qualificados);
  const fadiga = sinaisFadiga(m, metas);
  const motivos = [];

  // Dados insuficientes: só observar.
  if (num(m.dias) < num(metas.min_dias_para_decidir)) {
    return { veredito: VEREDITO.OBSERVAR, motivos: [`só ${num(m.dias)} dia(s) de dado`], fadiga, derivadas: d };
  }

  // MATAR: gastou N vezes o CPL qualificado alvo e não trouxe lead qualificado nenhum.
  const tetoSemResultado = num(L.cpl_qualificado_alvo) * num(L.multiplo_spend_para_matar);
  if (spend >= tetoSemResultado && leadsQ === 0) {
    motivos.push(`gastou R$${spend.toFixed(0)} (≥ ${L.multiplo_spend_para_matar}x CPL qualificado alvo) sem nenhum lead qualificado`);
    return { veredito: VEREDITO.MATAR, motivos, fadiga, derivadas: d };
  }

  // MATAR: CPL qualificado muito acima do alvo com volume relevante.
  if (leads >= 20 && d.cpl_qualificado !== null && d.cpl_qualificado > num(L.cpl_qualificado_alvo) * num(L.tolerancia_cpl) * 1.5) {
    motivos.push(`CPL qualificado R$${d.cpl_qualificado.toFixed(2)} muito acima do alvo R$${L.cpl_qualificado_alvo}`);
    if (d.cpl !== null && d.cpl <= num(L.cpl_alvo)) motivos.push('CPL bruto barato: o anúncio atrai curioso, não comprador');
    return { veredito: VEREDITO.MATAR, motivos, fadiga, derivadas: d };
  }

  // ESCALAR: CPL qualificado abaixo do alvo, com volume e sem fadiga.
  if (leadsQ >= 10 && d.cpl_qualificado !== null && d.cpl_qualificado <= num(L.cpl_qualificado_alvo) && fadiga.length === 0) {
    motivos.push(`CPL qualificado R$${d.cpl_qualificado.toFixed(2)} dentro do alvo R$${L.cpl_qualificado_alvo} com ${leadsQ} qualificados`);
    return { veredito: VEREDITO.ESCALAR, motivos, fadiga, derivadas: d };
  }

  // AJUSTAR: CPL bruto bom mas qualidade ruim = problema de público/ângulo, não de entrega.
  if (d.cpl !== null && d.cpl <= num(L.cpl_alvo) && d.taxa_qualificacao !== null && d.taxa_qualificacao < 0.2 && leads >= 20) {
    motivos.push(`CPL bruto R$${d.cpl.toFixed(2)} bom, mas só ${(d.taxa_qualificacao * 100).toFixed(0)}% qualificam: atrai curioso`);
    return { veredito: VEREDITO.AJUSTAR, motivos, fadiga, derivadas: d };
  }

  // AJUSTAR: CPL acima do tolerado.
  if (d.cpl !== null && d.cpl > num(L.cpl_alvo) * num(L.tolerancia_cpl)) {
    motivos.push(`CPL R$${d.cpl.toFixed(2)} acima do tolerado (alvo R$${L.cpl_alvo})`);
    return { veredito: VEREDITO.AJUSTAR, motivos, fadiga, derivadas: d };
  }

  if (fadiga.length) {
    return { veredito: VEREDITO.OBSERVAR, motivos: ['fadiga chegando'], fadiga, derivadas: d };
  }
  return { veredito: VEREDITO.OBSERVAR, motivos: ['dentro do esperado'], fadiga, derivadas: d };
}

/**
 * Veredito de uma linha de PERPÉTUO. Otimiza por ROAS real (receita Utmify ÷ spend Meta).
 */
function vereditoPerpetuo(m, metas, cfgCliente) {
  const P = { ...metas.perpetuo, ...(cfgCliente?.perpetuo || {}) };
  const d = derivar(m, metas);
  const spend = num(m.spend);
  const compras = num(m.compras);
  const fadiga = sinaisFadiga(m, metas);
  const motivos = [];
  const ticket = num(cfgCliente?.ticket_medio) || 0;
  const cpaAlvo = ticket ? ticket / num(P.roas_minimo) : null;

  if (num(m.dias) < num(metas.min_dias_para_decidir)) {
    return { veredito: VEREDITO.OBSERVAR, motivos: [`só ${num(m.dias)} dia(s) de dado`], fadiga, derivadas: d };
  }

  // MATAR: gastou N vezes o CPA alvo e não vendeu nada.
  if (cpaAlvo && spend >= cpaAlvo * num(P.multiplo_cpa_para_matar) && compras === 0) {
    motivos.push(`gastou R$${spend.toFixed(0)} (≥ ${P.multiplo_cpa_para_matar}x CPA alvo R$${cpaAlvo.toFixed(0)}) sem venda`);
    return { veredito: VEREDITO.MATAR, motivos, fadiga, derivadas: d };
  }

  // MATAR: ROAS abaixo de 1 com volume (pelo menos 3 compras ou spend alto).
  if (d.roas !== null && d.roas < 1.0 && (compras >= 3 || (cpaAlvo && spend >= cpaAlvo * 5))) {
    motivos.push(`ROAS real ${d.roas.toFixed(2)} abaixo de 1.0 com spend relevante`);
    return { veredito: VEREDITO.MATAR, motivos, fadiga, derivadas: d };
  }

  // ESCALAR: ROAS acima da meta de escala, com compras suficientes e sem fadiga.
  if (d.roas !== null && d.roas >= num(P.roas_escala) && compras >= 3 && fadiga.length === 0) {
    const forte = d.roas >= num(P.roas_escala_forte);
    motivos.push(`ROAS real ${d.roas.toFixed(2)} ${forte ? 'muito ' : ''}acima da meta de escala ${P.roas_escala}`);
    return { veredito: VEREDITO.ESCALAR, forte, motivos, fadiga, derivadas: d };
  }

  // AJUSTAR: entre 1.0 e o mínimo.
  if (d.roas !== null && d.roas < num(P.roas_minimo)) {
    motivos.push(`ROAS real ${d.roas.toFixed(2)} abaixo do mínimo ${P.roas_minimo}`);
    if (num(m.ctr) >= 1.0) motivos.push('CTR bom: problema é pós-clique (página/VSL/oferta)');
    else motivos.push('CTR baixo: problema é o criativo');
    return { veredito: VEREDITO.AJUSTAR, motivos, fadiga, derivadas: d };
  }

  if (fadiga.length) {
    return { veredito: VEREDITO.OBSERVAR, motivos: ['fadiga chegando'], fadiga, derivadas: d };
  }
  return { veredito: VEREDITO.OBSERVAR, motivos: ['dentro do esperado'], fadiga, derivadas: d };
}

/**
 * Veredito de uma linha. Escolhe a regra pelo tipo do cliente.
 */
export function veredito(m, metas, cfgCliente = {}) {
  const tipo = m.tipo || cfgCliente.tipo || 'perpetuo';
  const r = tipo === 'lancamento' ? vereditoLancamento(m, metas, cfgCliente) : vereditoPerpetuo(m, metas, cfgCliente);
  return { ...r, id: m.id, nome: m.nome, nivel: m.nivel || 'ad', tipo, spend: num(m.spend) };
}

/**
 * Converte vereditos em ações concretas, respeitando os guardrails.
 *
 * Devolve { autonomas: [...], aprovacao: [...], alertas: [...] }.
 * Cada ação: { tipo, alvo: {id, nome, nivel}, parametros, motivo }.
 */
export function planejarAcoes(vereditos, metas, contexto = {}) {
  const G = metas.guardrails;
  const autonomas = [];
  const aprovacao = [];
  const alertas = [];
  const pausasHoje = num(contexto.pausas_hoje);
  let pausasRestantes = Math.max(0, num(G.max_pausas_por_dia_por_conta) - pausasHoje);
  const agora = contexto.agora ? new Date(contexto.agora) : new Date();

  for (const v of vereditos) {
    const alvo = { id: v.id, nome: v.nome, nivel: v.nivel };
    const emAprendizado = !!v.em_aprendizado;

    if (v.fadiga?.length) {
      alertas.push({ tipo: 'alerta', alvo, motivo: `Fadiga: ${v.fadiga.join('; ')}. Preparar criativo novo.` });
    }

    if (v.veredito === VEREDITO.MATAR) {
      if (G.nunca_mexer_em_aprendizado && emAprendizado) {
        alertas.push({ tipo: 'alerta', alvo, motivo: `Candidato a pausa, mas em aprendizado: ${v.motivos.join('; ')}` });
        continue;
      }
      const acao = { tipo: v.nivel === 'ad' ? 'pausar_ad_sem_resultado' : `pausar_${v.nivel}`, alvo, parametros: {}, motivo: v.motivos.join('; ') };
      const podeSozinho = (G.acoes_autonomas || []).includes(acao.tipo) && pausasRestantes > 0 && !G.modo_sombra;
      if (podeSozinho) {
        autonomas.push(acao);
        pausasRestantes--;
      } else {
        aprovacao.push(acao);
      }
      continue;
    }

    if (v.veredito === VEREDITO.ESCALAR) {
      if (G.nunca_mexer_em_aprendizado && emAprendizado) {
        alertas.push({ tipo: 'alerta', alvo, motivo: 'Vencedor em aprendizado: aguardar sair da fase antes de escalar' });
        continue;
      }
      if (v.ultima_escala_em) {
        const horas = (agora - new Date(v.ultima_escala_em)) / 36e5;
        if (horas < num(G.min_horas_entre_escalas)) {
          alertas.push({ tipo: 'alerta', alvo, motivo: `Vencedor, mas escalado há ${horas.toFixed(0)}h (mínimo ${G.min_horas_entre_escalas}h)` });
          continue;
        }
      }
      const pctMax = v.forte ? num(G.max_variacao_budget_pct_escala_forte) : num(G.max_variacao_budget_pct);
      const budgetAtual = num(v.budget_diario);
      const novoBudget = budgetAtual ? Math.round(budgetAtual * (1 + pctMax / 100) * 100) / 100 : null;
      aprovacao.push({
        tipo: 'escalar',
        alvo,
        parametros: { budget_atual: budgetAtual || null, novo_budget: novoBudget, variacao_pct: pctMax, duplicar: !!v.forte },
        motivo: v.motivos.join('; '),
      });
      continue;
    }

    if (v.veredito === VEREDITO.AJUSTAR) {
      const budgetAtual = num(v.budget_diario);
      const pctMax = num(G.max_variacao_budget_pct);
      const novoBudget = budgetAtual ? Math.round(budgetAtual * (1 - pctMax / 100) * 100) / 100 : null;
      aprovacao.push({
        tipo: 'reduzir',
        alvo,
        parametros: { budget_atual: budgetAtual || null, novo_budget: novoBudget, variacao_pct: -pctMax },
        motivo: v.motivos.join('; '),
      });
    }
  }

  return { autonomas, aprovacao, alertas };
}

/**
 * Mapa de alocação: quanto do spend está em cada veredito. Serve para o resumo em dinheiro.
 */
export function mapaAlocacao(vereditos) {
  const total = vereditos.reduce((s, v) => s + num(v.spend), 0) || 1;
  const porVeredito = {};
  for (const v of vereditos) {
    porVeredito[v.veredito] = porVeredito[v.veredito] || { spend: 0, itens: 0 };
    porVeredito[v.veredito].spend += num(v.spend);
    porVeredito[v.veredito].itens++;
  }
  for (const k of Object.keys(porVeredito)) {
    porVeredito[k].share_pct = Math.round((porVeredito[k].spend / total) * 100);
  }
  return { total_spend: total, por_veredito: porVeredito };
}
