/**
 * Cérebro diário: a camada de julgamento.
 *
 * Recebe os vereditos do motor de regras + contexto (metas, fadiga, histórico de decisões)
 * e devolve, em JSON estruturado:
 *   - resumo executivo em dinheiro (onde queima, onde deixa na mesa)
 *   - até 3 ações do dia, com impacto estimado em R$/semana
 *   - propostas de anúncios novos (copy + ângulo) para os conjuntos vencedores com fadiga
 *
 * Usa o SDK oficial da Anthropic. Env: ANTHROPIC_API_KEY. Modelo: claude-opus-5.
 * Se a chave não existir, devolve um resumo determinístico sem IA (o sistema não para).
 */
import Anthropic from '@anthropic-ai/sdk';

const MODELO = process.env.TRAFEGO_MODELO || 'claude-opus-5';

const SISTEMA = `Você é o gestor de tráfego sênior de uma operação de infoprodutos no Brasil.
Você recebe métricas já cruzadas (Meta Ads + receita real + qualidade de lead pela pesquisa) e vereditos de um motor de regras.
Seu trabalho é transformar isso em decisões em dinheiro, não em métrica. Regras inegociáveis:
- Fale em reais e em lucro por semana. Comece sempre pelo dinheiro: quanto está queimando e quanto está deixando na mesa.
- Nunca decida com menos de 3 dias de dado. Nunca sugira mexer em conjunto em fase de aprendizado.
- Escala é em degraus de 20 a 30% (50% só para vencedor muito acima da meta), duplicando o vencedor em conjunto novo quando for escala forte.
- Antes de condenar campanha com receita zero, lembre que UTM quebrada é a causa mais comum.
- No lançamento a métrica é custo por lead QUALIFICADO (pela pesquisa), não CPL bruto. Lead barato que não qualifica é curioso.
- Anúncio novo: proponha ângulo, hook, copy primária e headline em português do Brasil, direct response, sem promessa ilegal. Um por vencedor com fadiga, no máximo 3.
- Seja direto. Sem introdução, sem elogio, sem repetir os dados de entrada.`;

const SCHEMA = {
  type: 'object',
  properties: {
    resumo_dinheiro: { type: 'string', description: '3 a 5 linhas. Quanto queima, quanto deixa na mesa, lucro estimado da semana.' },
    queimando_por_semana_brl: { type: 'number' },
    na_mesa_por_semana_brl: { type: 'number' },
    acoes_do_dia: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          alvo_id: { type: 'string' },
          alvo_nome: { type: 'string' },
          acao: { type: 'string', enum: ['pausar', 'escalar', 'reduzir', 'duplicar', 'trocar_criativo', 'checar_utm', 'observar'] },
          impacto_brl_semana: { type: 'number' },
          por_que: { type: 'string' },
        },
        required: ['alvo_id', 'alvo_nome', 'acao', 'impacto_brl_semana', 'por_que'],
        additionalProperties: false,
      },
    },
    anuncios_novos: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          adset_id: { type: 'string' },
          adset_nome: { type: 'string' },
          nome_sugerido: { type: 'string' },
          angulo: { type: 'string' },
          hook: { type: 'string' },
          copy_primaria: { type: 'string' },
          headline: { type: 'string' },
          por_que: { type: 'string' },
        },
        required: ['adset_id', 'adset_nome', 'nome_sugerido', 'angulo', 'hook', 'copy_primaria', 'headline', 'por_que'],
        additionalProperties: false,
      },
    },
    alertas: { type: 'array', items: { type: 'string' } },
  },
  required: ['resumo_dinheiro', 'queimando_por_semana_brl', 'na_mesa_por_semana_brl', 'acoes_do_dia', 'anuncios_novos', 'alertas'],
  additionalProperties: false,
};

function fallbackSemIA(entrada) {
  const { vereditos = [], metas } = entrada;
  const janela = Number(metas?.janela_dias || 7);
  const matar = vereditos.filter((v) => v.veredito === 'MATAR');
  const escalar = vereditos.filter((v) => v.veredito === 'ESCALAR');
  const queimando = matar.reduce((s, v) => s + Number(v.spend || 0), 0) * (7 / janela);
  const naMesa = escalar.reduce((s, v) => s + Math.max(0, Number(v.derivadas?.lucro || 0)) * 0.3, 0) * (7 / janela);
  return {
    resumo_dinheiro: `Sem chave da Anthropic: resumo pelas regras. ${matar.length} item(ns) para matar queimando ~R$${queimando.toFixed(0)}/semana; ${escalar.length} vencedor(es) para escalar.`,
    queimando_por_semana_brl: Math.round(queimando),
    na_mesa_por_semana_brl: Math.round(naMesa),
    acoes_do_dia: [...matar.slice(0, 2).map((v) => ({ alvo_id: v.id, alvo_nome: v.nome, acao: 'pausar', impacto_brl_semana: Math.round(Number(v.spend || 0) * 7 / janela), por_que: v.motivos.join('; ') })),
      ...escalar.slice(0, 1).map((v) => ({ alvo_id: v.id, alvo_nome: v.nome, acao: 'escalar', impacto_brl_semana: Math.round(Math.max(0, Number(v.derivadas?.lucro || 0)) * 0.3 * 7 / janela), por_que: v.motivos.join('; ') }))].slice(0, 3),
    anuncios_novos: [],
    alertas: vereditos.filter((v) => v.fadiga?.length).map((v) => `${v.nome}: ${v.fadiga.join('; ')}`),
    sem_ia: true,
  };
}

/**
 * entrada: { cliente: {nome, tipo, ticket_medio}, metas, vereditos: [...], plano: {autonomas, aprovacao, alertas},
 *            alocacao, resumo_leads, historico: [{data, acao, resultado}] , anuncios_referencia: [{ad_id, nome, copy}] }
 */
export async function pensar(entrada) {
  if (!process.env.ANTHROPIC_API_KEY) return fallbackSemIA(entrada);
  const client = new Anthropic();

  // Só o necessário: vereditos sem OBSERVAR "dentro do esperado" para não gastar contexto.
  const relevantes = (entrada.vereditos || []).filter((v) => v.veredito !== 'OBSERVAR' || v.fadiga?.length);
  const payload = {
    cliente: entrada.cliente,
    metas: { lancamento: entrada.metas?.lancamento, perpetuo: entrada.metas?.perpetuo, fadiga: entrada.metas?.fadiga, guardrails: entrada.metas?.guardrails },
    janela_dias: entrada.metas?.janela_dias,
    alocacao: entrada.alocacao,
    resumo_leads: entrada.resumo_leads,
    vereditos: relevantes.map((v) => ({
      id: v.id, nome: v.nome, nivel: v.nivel, adset_id: v.adset_id, adset_nome: v.adset_name,
      veredito: v.veredito, forte: v.forte || false, motivos: v.motivos, fadiga: v.fadiga,
      spend: v.spend, budget_diario: v.budget_diario, em_aprendizado: v.em_aprendizado,
      derivadas: v.derivadas, ctr: v.ctr, frequencia: v.frequencia, leads: v.leads, leads_qualificados: v.leads_qualificados,
      receita: v.receita, compras: v.compras, dias: v.dias,
    })),
    total_itens_analisados: (entrada.vereditos || []).length,
    plano_regras: entrada.plano,
    historico_recente: (entrada.historico || []).slice(-20),
    anuncios_referencia: (entrada.anuncios_referencia || []).slice(0, 5),
  };

  const response = await client.messages.create({
    model: MODELO,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: SISTEMA, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Dados do dia (JSON):\n${JSON.stringify(payload)}` }],
  });

  if (response.stop_reason === 'refusal') {
    const r = fallbackSemIA(entrada);
    r.alertas.push(`IA recusou a análise: ${response.stop_details?.explanation || 'sem detalhe'}`);
    return r;
  }
  const texto = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return JSON.parse(texto);
  } catch {
    const r = fallbackSemIA(entrada);
    r.alertas.push('IA devolveu JSON inválido; usado resumo pelas regras');
    return r;
  }
}
