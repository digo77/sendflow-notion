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
export async function agendarSequenciaWZ({ releaseId, accountId, dataWebinario }) {
  const seq = await getSequencia();
  if (!seq.length) {
    throw new Error('Sequência vazia. Sincronize com o Notion primeiro.');
  }

  const resultados = [];
  for (const wz of seq) {
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
      resultados.push({ id: wz.id, ok: true, actionId: res.data?.actionId, scheduledTo: at });
    } catch (err) {
      const erro = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      resultados.push({ id: wz.id, ok: false, erro, scheduledTo: at });
    }
    // pausa entre requisições
    await new Promise((r) => setTimeout(r, 400));
  }

  return resultados;
}
