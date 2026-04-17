/**
 * wz-sequencia.js
 * Agendamento da sequência de aquecimento WhatsApp.
 *
 * A sequência vem do cache local (populado pelo /api/wz/sync-notion).
 * Se não houver cache ainda, retorna lista vazia e o usuário é orientado
 * a sincronizar com o Notion.
 *
 * Todas as horas são em Brasília (UTC-3).
 */
import { agendarMensagemTexto, agendarMensagemImagem } from './sendflow.js';
import { lerCache } from './wz-notion.js';

// ─── Carrega a sequência do cache ────────────────────────────────────────
export async function getSequencia() {
  const cache = await lerCache();
  return cache?.mensagens || [];
}

// ─── Calcula horário UTC a partir da data local Brasília ─────────────────
// dataWebinario: "YYYY-MM-DD" (dia do webinário, terça-feira)
function scheduledTo(dataWebinario, offsetDias, hora, min) {
  const [y, m, d] = dataWebinario.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + offsetDias, hora + 3, min));
  return base.toISOString();
}

// ─── Preview (sem agendar) ───────────────────────────────────────────────
export async function wzPreview(dataWebinario) {
  const seq = await getSequencia();
  return seq.map((wz) => {
    const at = scheduledTo(dataWebinario, wz.offset, wz.hora ?? 0, wz.min ?? 0);
    const horaLocal = new Date(at).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    });
    return {
      id: wz.id,
      prefixo: wz.prefixo || 'WZ',
      tipoAcao: wz.tipoAcao || 'enviar_mensagem',
      label: wz.label,
      tipo: wz.tipo,
      dia: wz.dia,
      scheduledTo: at,
      horaLocal,
      mensagem: wz.mensagem,
      imageUrl: wz.imageUrl || null,
    };
  });
}

// ─── Agendar toda a sequência ────────────────────────────────────────────
// Só agenda itens do tipo 'enviar_mensagem' (WZ e IN) via Sendflow nativo.
// Renames (RN) e mudanças de descrição (DS) precisam de outro fluxo (próxima
// versão usa cron/agendamentos do Notion).
//
// @param {string[]} [opts.fases] - Filtrar por prefixo ['WZ','IN']. Omite = todas
export async function agendarSequenciaWZ({ releaseId, accountId, dataWebinario, fases }) {
  const seq = await getSequencia();
  if (!seq.length) {
    throw new Error('Sequência vazia. Sincronize com o Notion primeiro.');
  }

  // Só processa itens que viram mensagem no Sendflow (enviar_mensagem)
  let alvo = seq.filter((w) => w.tipoAcao === 'enviar_mensagem' || !w.tipoAcao);
  if (fases?.length) alvo = alvo.filter((w) => fases.includes(w.prefixo));

  const resultados = [];
  for (const wz of alvo) {
    const at = scheduledTo(dataWebinario, wz.offset, wz.hora ?? 0, wz.min ?? 0);
    try {
      let res;
      if (wz.tipo === 'imagem' && wz.imageUrl) {
        res = await agendarMensagemImagem({
          releaseId,
          accountId,
          imageUrl: wz.imageUrl,
          caption: wz.mensagem,
          scheduledTo: at,
          shippingSpeed: 'none',
        });
      } else {
        res = await agendarMensagemTexto({
          releaseId,
          accountId,
          mensagem: wz.mensagem,
          scheduledTo: at,
          shippingSpeed: 'none',
        });
      }
      resultados.push({ id: wz.id, prefixo: wz.prefixo || 'WZ', ok: true, actionId: res.data?.actionId, scheduledTo: at });
    } catch (err) {
      const erro = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      resultados.push({ id: wz.id, prefixo: wz.prefixo || 'WZ', ok: false, erro, scheduledTo: at });
    }
    // pausa entre requisições
    await new Promise((r) => setTimeout(r, 400));
  }

  return resultados;
}
