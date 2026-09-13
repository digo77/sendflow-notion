/**
 * Aprovações de ações de tráfego pelo WhatsApp.
 *
 * Mesmo padrão do confirmacao.js dos agendamentos, mas com ids prefixados por "T"
 * para não colidir, e com validade de 24h (decisão de tráfego pode esperar o dia).
 *
 * Resposta esperada: "SIM T1A2B" ou "NAO T1A2B".
 */
import { enviarMensagemDireta } from '../sendflow.js';

export const pendentesTrafego = new Map();
let counter = 0;

function gerarId() {
  counter++;
  const ts = Date.now().toString(36).slice(-3);
  const seq = counter.toString(36).padStart(2, '0');
  return `T${ts}${seq}`.toUpperCase();
}

function brl(v) {
  return v === null || v === undefined ? '-' : `R$${Number(v).toFixed(2)}`;
}

export function descreverAcao(acao) {
  const { tipo, alvo, parametros = {} } = acao;
  switch (tipo) {
    case 'pausar_ad_sem_resultado':
    case 'pausar_ad': return `Pausar anúncio *${alvo.nome}*`;
    case 'pausar_adset': return `Pausar conjunto *${alvo.nome}*`;
    case 'pausar_campaign': return `Pausar campanha *${alvo.nome}*`;
    case 'escalar':
      return parametros.duplicar
        ? `Duplicar conjunto *${alvo.nome}* com ${brl(parametros.novo_budget)}/dia (original intocado)`
        : `Escalar *${alvo.nome}* de ${brl(parametros.budget_atual)} para ${brl(parametros.novo_budget)}/dia (+${parametros.variacao_pct}%)`;
    case 'reduzir': return `Reduzir *${alvo.nome}* de ${brl(parametros.budget_atual)} para ${brl(parametros.novo_budget)}/dia (${parametros.variacao_pct}%)`;
    case 'criar_ad': return `Criar anúncio novo *${parametros.nome_sugerido}* no conjunto *${alvo.nome}* (fica PAUSADO até você ativar)`;
    case 'ativar_ad': return `Ativar anúncio *${alvo.nome}*`;
    default: return `${tipo} em *${alvo?.nome}*`;
  }
}

/**
 * Registra a ação e manda a pergunta no WhatsApp. Devolve o id curto.
 */
export async function pedirAprovacao(acao, { cliente, enviar = true } = {}) {
  const id = gerarId();
  pendentesTrafego.set(id, { ...acao, cliente, criadoEm: Date.now() });
  const linhas = [
    `*Tráfego · ${cliente?.nome || 'conta'}* — ${id}`,
    ``,
    descreverAcao(acao),
    ``,
    `*Por quê:* ${acao.motivo}`,
  ];
  if (acao.tipo === 'criar_ad') {
    const p = acao.parametros;
    linhas.push(``, `*Ângulo:* ${p.angulo}`, `*Hook:* ${p.hook}`, `*Headline:* ${p.headline}`, `*Copy:*`, p.copy_primaria);
  }
  linhas.push(``, `✅ *SIM ${id}* para executar`, `❌ *NAO ${id}* para descartar`);
  if (enviar) await enviarMensagemDireta(process.env.SENDFLOW_NUMBER, linhas.join('\n'));
  return id;
}

/**
 * Tenta resolver uma resposta de WhatsApp como aprovação de tráfego.
 * Devolve { acao: 'sim'|'nao', id, dados } ou null se não for um id de tráfego.
 */
export function resolverRespostaTrafego(texto) {
  const match = String(texto || '').trim().match(/^(SIM|NAO|NÃO)\s+(T[A-Z0-9]+)$/i);
  if (!match) return null;
  const id = match[2].toUpperCase();
  const dados = pendentesTrafego.get(id);
  if (!dados) return null;
  pendentesTrafego.delete(id);
  return { acao: match[1].toUpperCase().startsWith('S') ? 'sim' : 'nao', id, dados };
}

/** Remove aprovações com mais de 24h. */
export function limparExpiradosTrafego() {
  const limite = Date.now() - 24 * 60 * 60 * 1000;
  const removidos = [];
  for (const [id, d] of pendentesTrafego) {
    if (d.criadoEm < limite) { removidos.push({ id, ...d }); pendentesTrafego.delete(id); }
  }
  return removidos;
}

export function listarPendentesTrafego() {
  return [...pendentesTrafego.entries()].map(([id, d]) => ({
    id, tipo: d.tipo, alvo: d.alvo, parametros: d.parametros, motivo: d.motivo,
    cliente: d.cliente?.nome || null, descricao: descreverAcao(d), criadoEm: new Date(d.criadoEm).toISOString(),
  }));
}
