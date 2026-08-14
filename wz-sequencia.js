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
import { agendarMensagemTexto, agendarMensagemImagem, agendarMensagemVideo } from './sendflow.js';
import { agendarAcoes } from './wz-agendador.js';
import { lerCache, lerConfig } from './wz-notion.js';
import { aplicarVariaveis, formatarDataBR } from './wz-variaveis.js';

// Sendflow rejeita URLs de mídia sem extensão no path ("Arquivo não fornecido
// ou formato inválido"). Arquivos do ImageKit salvos sem extensão (ex:
// `cookie-sandwich-010-mpay5`) passam pelo nosso proxy `/img/:name.jpg` que
// adiciona a extensão no path e entrega o conteúdo original.
function urlParaSendflow(url, tipo) {
  if (!url) return url;
  const semQuery = url.split('?')[0];
  if (/\.(jpe?g|png|webp|gif|mp4|mov|webm)$/i.test(semQuery)) return url;
  const dominio = process.env.CLOUDFLARE_TUNNEL_DOMAIN;
  if (!dominio) return url;
  const ext = tipo === 'video' ? 'mp4' : 'jpg';
  const nome = (semQuery.split('/').pop() || 'media') + '.' + ext;
  return `https://${dominio}/img/${encodeURIComponent(nome)}?src=${encodeURIComponent(url)}`;
}

// ─── Carrega a sequência do cache ────────────────────────────────────────
export async function getSequencia(releaseId) {
  const cache = await lerCache(releaseId);
  return cache?.mensagens || [];
}

// ─── Calcula horário UTC a partir da data local Brasília ─────────────────
// dataWebinario: "YYYY-MM-DD" (dia do webinário, terça-feira)
function scheduledTo(dataWebinario, offsetDias, hora, min) {
  const [y, m, d] = dataWebinario.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + offsetDias, hora + 3, min));
  return base.toISOString();
}

// Resolve o ISO agendado pra uma mensagem: usa `absoluto` (modo livre) ou
// calcula a partir da data do evento + offset (modo webinar).
//
// Se cair no passado, mantém o horário literal — o agendador pula com o
// motivo "horário já passou". Rolar +7 dias faria sentido só pra webinar
// recorrente semanal, mas nos webinars de data fixa isso joga mensagens
// pré-evento pra DEPOIS do evento (bug).
function resolverScheduledTo(wz, dataWebinario) {
  if (wz.absoluto) return wz.absoluto;
  if (!dataWebinario) throw new Error(`Mensagem ${wz.id} precisa de data de referência (ou usar formato livre no Notion)`);
  return scheduledTo(dataWebinario, wz.offset ?? 0, wz.hora ?? 0, wz.min ?? 0);
}

/** Constrói o objeto de variáveis a partir da config + data do webinário. */
async function resolverVariaveis(dataWebinario, releaseId, overrides = {}) {
  const cfg = await lerConfig(releaseId);
  return {
    data: dataWebinario ? formatarDataBR(dataWebinario) : '',
    hora: overrides.hora ?? cfg.horaEvento ?? cfg.horaWebinario ?? 20,
    nome_base: overrides.nome_base ?? cfg.nomeBase ?? '',
    link_inscricao: overrides.link_inscricao ?? cfg.linkInscricao ?? '',
  };
}

// ─── Preview (sem agendar) ───────────────────────────────────────────────
export async function wzPreview(dataWebinario, releaseId) {
  const seq = await getSequencia(releaseId);
  const vars = await resolverVariaveis(dataWebinario, releaseId);
  return seq.map((wz) => {
    const at = resolverScheduledTo(wz, dataWebinario);
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
      mensagem: aplicarVariaveis(wz.mensagem, vars),
      mensagemTemplate: wz.mensagem, // preserva original pra debug
      imageUrl: wz.imageUrl || null,
    };
  });
}

// ─── Agendar toda a sequência ────────────────────────────────────────────
// Mensagens (WZ/IN/LV) → Sendflow nativo (aparece em "Agendado")
// RN/DS → cron local (PUT /release-groups/{id} em cada grupo individual no
//   horário). Não dá pra agendar via REST pública — o Sendflow agenda via
//   Firestore direto. O PUT /releases/{id} com scheduled:true quebra o grupo.
//
// @param {string[]} [opts.fases] - Filtrar por prefixo ['WZ','IN','RN','DS','LV']. Omite = todas
// @param {string[]} [opts.ids]   - Filtrar por IDs específicos. Omite = todas
export async function agendarSequenciaWZ({ releaseId, accountId, dataWebinario, fases, ids }) {
  const seq = await getSequencia(releaseId);
  if (!seq.length) {
    throw new Error('Sequência vazia. Sincronize com o Notion primeiro.');
  }

  let alvo = seq.slice();
  if (fases?.length) alvo = alvo.filter((w) => fases.includes(w.prefixo));
  if (ids?.length) alvo = alvo.filter((w) => ids.includes(w.id));

  const vars = await resolverVariaveis(dataWebinario, releaseId);
  const agora = Date.now();

  const resultados = [];
  const localPendentes = [];
  for (const wz of alvo) {
    const at = resolverScheduledTo(wz, dataWebinario);

    if (new Date(at).getTime() <= agora) {
      resultados.push({ id: wz.id, prefixo: wz.prefixo || 'WZ', ok: false, pulado: true, motivo: 'horário já passou', scheduledTo: at });
      continue;
    }

    const textoFinal = aplicarVariaveis(wz.mensagem, vars);
    const tipoAcao = wz.tipoAcao || 'enviar_mensagem';

    if (tipoAcao === 'renomear_grupo' || tipoAcao === 'atualizar_descricao') {
      localPendentes.push({
        id: wz.id,
        prefixo: wz.prefixo || (tipoAcao === 'renomear_grupo' ? 'RN' : 'DS'),
        tipoAcao,
        scheduledTo: at,
        releaseId,
        accountId,
        mensagem: textoFinal,
        label: wz.label || '',
      });
      continue;
    }

    try {
      let res;
      if (wz.tipo === 'video' && wz.imageUrl) {
        res = await agendarMensagemVideo({
          releaseId,
          accountId,
          videoUrl: urlParaSendflow(wz.imageUrl, 'video'),
          caption: textoFinal,
          scheduledTo: at,
          shippingSpeed: 'none',
        });
      } else if (wz.tipo === 'imagem' && wz.imageUrl) {
        res = await agendarMensagemImagem({
          releaseId,
          accountId,
          imageUrl: urlParaSendflow(wz.imageUrl, 'imagem'),
          caption: textoFinal,
          scheduledTo: at,
          shippingSpeed: 'none',
        });
      } else {
        res = await agendarMensagemTexto({
          releaseId,
          accountId,
          mensagem: textoFinal,
          scheduledTo: at,
          shippingSpeed: 'none',
        });
      }
      resultados.push({
        id: wz.id, prefixo: wz.prefixo || 'WZ', tipoAcao, ok: true,
        actionId: res.data?.actionId, scheduledTo: at,
      });
    } catch (err) {
      const erro = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      resultados.push({ id: wz.id, prefixo: wz.prefixo || 'WZ', tipoAcao, ok: false, erro, scheduledTo: at });
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  if (localPendentes.length) {
    try {
      const locais = await agendarAcoes(localPendentes);
      for (const it of localPendentes) {
        const r = locais.find((x) => x.id === `${it.id}-${it.scheduledTo}`);
        resultados.push({ id: it.id, prefixo: it.prefixo, tipoAcao: it.tipoAcao, ok: !!r?.ok, local: true, scheduledTo: it.scheduledTo });
      }
    } catch (err) {
      for (const it of localPendentes) {
        resultados.push({ id: it.id, prefixo: it.prefixo, tipoAcao: it.tipoAcao, ok: false, erro: err.message, scheduledTo: it.scheduledTo });
      }
    }
  }

  return resultados;
}
