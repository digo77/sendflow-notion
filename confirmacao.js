import { enviarMensagemDireta } from './sendflow.js';

/**
 * Map de aprovações pendentes.
 * Chave: shortId (6 chars), Valor: { pageId, nome, tipoAcao, releaseId, accountId, parametro, criadoEm }
 */
export const pendentes = new Map();

let counter = 0;

function gerarShortId() {
  counter++;
  const ts = Date.now().toString(36).slice(-4);
  const seq = counter.toString(36).padStart(2, '0');
  return `${ts}${seq}`.toUpperCase();
}

/**
 * Registra um agendamento pendente e envia WhatsApp pedindo confirmação.
 */
export async function pedirConfirmacao(agendamento, campanhaNome, releaseId, accountId) {
  const shortId = gerarShortId();

  pendentes.set(shortId, {
    pageId: agendamento.id,
    nome: agendamento.nome,
    tipoAcao: agendamento.tipoAcao,
    releaseId,
    accountId,
    parametro: agendamento.parametro,
    criadoEm: Date.now(),
  });

  const acaoLabel =
    agendamento.tipoAcao === 'renomear_grupo'
      ? 'Renomear grupo'
      : 'Enviar mensagem';

  const hora = agendamento.dataHora
    ? new Date(agendamento.dataHora).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'sem horário';

  const texto = [
    `*Agendamento pendente* — ${shortId}`,
    ``,
    `*Nome:* ${agendamento.nome}`,
    `*Campanha:* ${campanhaNome}`,
    `*Ação:* ${acaoLabel}`,
    `*Parâmetro:* ${agendamento.parametro}`,
    `*Horário:* ${hora}`,
    ``,
    `Responda:`,
    `✅ *SIM ${shortId}* para confirmar`,
    `❌ *NAO ${shortId}* para cancelar`,
  ].join('\n');

  await enviarMensagemDireta(process.env.SENDFLOW_NUMBER, texto);

  return shortId;
}

/**
 * Resolve uma resposta recebida. Retorna { acao: 'sim'|'nao', dados } ou null.
 */
export function resolverResposta(texto) {
  const match = texto.trim().match(/^(SIM|NAO|NÃO)\s+([A-Z0-9]+)$/i);
  if (!match) return null;

  const acao = match[1].toUpperCase().startsWith('S') ? 'sim' : 'nao';
  const shortId = match[2].toUpperCase();
  const dados = pendentes.get(shortId);

  if (!dados) return null;

  pendentes.delete(shortId);
  return { acao, shortId, dados };
}

/**
 * Cancela aprovações expiradas (mais de 60 minutos).
 * Retorna array de dados removidos.
 */
export function limparExpirados() {
  const limite = Date.now() - 60 * 60 * 1000;
  const expirados = [];

  for (const [shortId, dados] of pendentes) {
    if (dados.criadoEm < limite) {
      expirados.push(dados);
      pendentes.delete(shortId);
    }
  }

  return expirados;
}
