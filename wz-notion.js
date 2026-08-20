/**
 * wz-notion.js
 * Lê a página do Notion com a sequência WZ de aquecimento, faz parse
 * e retorna array no formato que o agendador usa.
 */
import { Client } from '@notionhq/client';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = join(__dirname, 'data', 'wz-cache.json');
const CONFIG_PATH = join(__dirname, 'data', 'wz-config.json');

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// ─── Mapeamento dia da semana → offset relativo ao dia da aula ────────────
// O dia de referência (âncora) NÃO é sempre terça — é o dia da semana real
// da aula (dataWebinario da campanha). Os offsets são calculados na hora,
// a partir do índice do dia (Dom=0 ... Sáb=6), pra funcionar com qualquer
// âncora (terça, quarta, etc).
const DIA_INDEX = {
  Domingo: 0, Dom: 0,
  Segunda: 1, Seg: 1,
  Terça: 2, Terca: 2, Ter: 2,
  Quarta: 3, Qua: 3,
  Quinta: 4, Qui: 4,
  Sexta: 5,  Sex: 5,
  Sábado: 6, Sabado: 6, Sáb: 6, Sab: 6,
};

// Constrói os mapas PRE (dias ANTES da âncora) e POS (dias DEPOIS) pra um
// dia-âncora qualquer. Usamos o mapa PRE por padrão, mas se já passamos
// pela âncora dentro de uma mesma fase, os próximos dias usam o mapa POS.
function construirOffsetMaps(diaAncora) {
  const ancoraIdx = DIA_INDEX[diaAncora] ?? DIA_INDEX['Terça'];
  const pre = {};
  const pos = {};
  for (const [nome, idx] of Object.entries(DIA_INDEX)) {
    if (idx === ancoraIdx) {
      pre[nome] = 0;
      pos[nome] = 0;
    } else {
      pos[nome] = (idx - ancoraIdx + 7) % 7;
      pre[nome] = pos[nome] - 7;
    }
  }
  return { pre, pos };
}

// Mapeamento prefixo → tipoAcao
const PREFIXO_TIPO_ACAO = {
  WZ: 'enviar_mensagem',
  IN: 'enviar_mensagem',
  RN: 'renomear_grupo',
  DS: 'atualizar_descricao',
  DC: 'atualizar_descricao',
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function extractPageId(urlOrId) {
  if (!urlOrId) return null;
  const noQuery = urlOrId.split('?')[0];
  const cleaned = noQuery.replace(/-/g, '');
  // O ID do Notion é sempre os últimos 32 chars do último grupo hex do path.
  // Usar slice(-32) no último match >= 32 chars evita capturar "2026" de slugs
  // como "29-abril-2026-351d6e..." que prefixam o ID real.
  const all = [...cleaned.matchAll(/[a-f0-9]{32,}/gi)];
  if (all.length) return all[all.length - 1][0].slice(-32);
  const m = cleaned.match(/([a-f0-9]{32})/i);
  return m ? m[1] : null;
}

/**
 * Normaliza URL de mídia:
 *   1. Remove query string (`?updatedAt=...`)
 *   2. Pra URLs do ImageKit sem extensão no path, faz HEAD pra descobrir se
 *      o arquivo é salvo com `.jpg` ou sem extensão — no ImageKit do projeto
 *      convive os dois formatos e adivinhar errado dá 404.
 *   3. Vídeo e URLs externas (Sendflow storage etc.) passam direto.
 */
async function normalizarImagem(url) {
  if (!url) return null;
  const semQuery = url.split('?')[0];

  // Vídeo ou não-ImageKit: preserva
  if (/\.(mp4|mov|webm)$/i.test(semQuery) || !/ik\.imagekit\.io/.test(semQuery)) {
    return semQuery;
  }

  // Já tem extensão explícita: confia
  if (/\.(jpg|jpeg|png|webp|gif)$/i.test(semQuery)) {
    return semQuery;
  }

  // Sem extensão — testa primeiro sem, depois com `.jpg`.
  // (HEAD é rápido; usa o primeiro que responder 200.)
  try {
    const r1 = await fetch(semQuery, { method: 'HEAD' });
    if (r1.ok) return semQuery;
  } catch {}
  try {
    const comJpg = semQuery + '.jpg';
    const r2 = await fetch(comJpg, { method: 'HEAD' });
    if (r2.ok) return comJpg;
  } catch {}
  // Deu ruim nos dois — devolve como veio pra debug visual.
  return semQuery;
}

function parseHorario(str) {
  // "11h", "09h", "20h30"
  const m = str.match(/(\d{1,2})h(\d{1,2})?/);
  if (!m) return null;
  return { hora: parseInt(m[1], 10), min: m[2] ? parseInt(m[2], 10) : 0 };
}

/**
 * Reconhece uma DATA ABSOLUTA no início de um header do Notion e devolve
 * { absolutoUTC, hora, min, label } — ou null se não casar.
 *
 * Formatos aceitos (todos com "· label" opcional no fim):
 *   04/06/2026 20:00 · label      (completo com dois pontos)
 *   04/06/2026 20h30 · label      (completo com h)
 *   04/06 às 20h · label          (sem ano, "às", h)
 *   4/6 20h30                      (sem zero à esquerda, sem ano)
 *   04/06 20:00                    (sem ano, dois pontos)
 *
 * Ano omitido → assume o próximo em que a data ainda é futura (rollover de
 * virada de ano). Hora em Brasília (UTC-3).
 */
function parseDataAbsoluta(texto) {
  // dia/mês, ano opcional (2 ou 4 díg), "às" opcional, hora com :MM | hMM | h | nada
  const re = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(?:[àa]s\s+)?(\d{1,2})(?::(\d{2})|h(\d{2})?)?\s*(?:[·\-–]\s*(.+))?$/iu;
  const m = texto.trim().match(re);
  if (!m) return null;
  const [, dd, mm, yy, hh, minColon, minH, label] = m;
  const dia = parseInt(dd, 10), mes = parseInt(mm, 10);
  const hora = parseInt(hh, 10);
  const min = minColon != null ? parseInt(minColon, 10) : (minH != null ? parseInt(minH, 10) : 0);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23 || min > 59) return null;

  let ano;
  if (yy != null) {
    ano = parseInt(yy, 10);
    if (ano < 100) ano += 2000; // "26" → 2026
  } else {
    // Sem ano: usa o ano corrente; se a data já passou, rola pro próximo.
    const agora = new Date();
    ano = agora.getUTCFullYear();
    const cand = Date.UTC(ano, mes - 1, dia, hora + 3, min);
    if (cand < agora.getTime()) ano += 1;
  }
  const absolutoUTC = new Date(Date.UTC(ano, mes - 1, dia, hora + 3, min)).toISOString();
  return { absolutoUTC, hora, min, label: (label || '').trim(), dia, mes, ano };
}

/**
 * Reconhece um header com PREFIXO CUSTOM + DATA INLINE e devolve
 * { codigo, absolutoUTC, hora, min, label } — ou null se não casar.
 *
 * Diferente de parseDataAbsoluta (que exige a data NO INÍCIO), aqui a data
 * vem depois de um código livre. Cobre sequências como:
 *   NC-A1 · Seg 29/06 · 8h · Hoje tem jogo. Amanhã tem vaga.
 *   NC-RB1 · Ter 30/06 · 9h01 · Falta 1 hora
 *   X1 · 30/06 · 10h00 · label            (dia da semana opcional)
 *
 * O dia da semana antes da data é decorativo — quem manda é o DD/MM. Ano
 * omitido → próximo em que a data ainda é futura. Hora em Brasília (UTC-3).
 */
function parseDataInlineComPrefixo(texto) {
  // codigo · [diaSemana] DD/MM[/AA[AA]] · HORA(h|:)[MM] · label(resto, pode ter ·)
  const re = /^([A-Za-z][\w-]*)\s*·\s*(?:\p{L}+\.?\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*·\s*(\d{1,2})(?:h|:)(\d{2})?\s*·\s*(.+)$/u;
  const m = (texto || '').trim().match(re);
  if (!m) return null;
  const [, codigo, dd, mm, yy, hh, mi, label] = m;
  const dia = parseInt(dd, 10), mes = parseInt(mm, 10), hora = parseInt(hh, 10);
  const min = mi != null ? parseInt(mi, 10) : 0;
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31 || hora > 23 || min > 59) return null;

  let ano;
  if (yy != null) {
    ano = parseInt(yy, 10);
    if (ano < 100) ano += 2000;
  } else {
    const agora = new Date();
    ano = agora.getUTCFullYear();
    const cand = Date.UTC(ano, mes - 1, dia, hora + 3, min);
    if (cand < agora.getTime()) ano += 1;
  }
  const absolutoUTC = new Date(Date.UTC(ano, mes - 1, dia, hora + 3, min)).toISOString();
  return { codigo: codigo.trim(), absolutoUTC, hora, min, label: (label || '').trim() };
}

function richTextToString(rt) {
  return (rt || []).map((t) => t.plain_text || '').join('');
}

/** Junta o texto de um bloco e todos os descendentes (para quote com filhos). */
async function blockTextRecursive(block) {
  let partes = [];
  const t = block.type;
  if (t === 'quote' || t === 'paragraph' || t === 'bulleted_list_item' || t === 'numbered_list_item') {
    partes.push(richTextToString(block[t].rich_text));
    // Para pegar URLs "crus", inclui href dos tokens
    for (const token of block[t].rich_text || []) {
      if (token.href && !partes.join('').includes(token.href)) {
        partes.push(token.href);
      }
    }
  }
  if (block.has_children) {
    const kids = await notion.blocks.children.list({ block_id: block.id, page_size: 100 });
    for (const k of kids.results) {
      partes.push(await blockTextRecursive(k));
    }
  }
  return partes.join(' ');
}

// Traduz erros da API do Notion em mensagens acionáveis em PT-BR.
function traduzirErroNotion(err, pageId) {
  const code = err?.code;
  const status = err?.status;
  const raw = err?.message || '';

  if (code === 'object_not_found' || /Could not find block/i.test(raw)) {
    const e = new Error(
      `A página do Notion não foi compartilhada com a integração "sendflow".\n\n` +
      `Como resolver:\n` +
      `1. Abra a página no Notion\n` +
      `2. Clique em "..." (canto superior direito) → "Connections" / "Conexões"\n` +
      `3. Procure e selecione "sendflow"\n` +
      `4. Volte aqui e clique em Sincronizar de novo\n\n` +
      `(ID da página: ${pageId})`
    );
    e.code = 'notion_not_shared';
    return e;
  }
  if (code === 'unauthorized' || status === 401) {
    const e = new Error('Token do Notion (NOTION_TOKEN) inválido ou expirado. Atualize a variável de ambiente e reinicie o servidor.');
    e.code = 'notion_unauthorized';
    return e;
  }
  if (code === 'validation_error') {
    const e = new Error(`URL/ID do Notion inválido. Verifique se colou a URL completa da página. (detalhe: ${raw})`);
    e.code = 'notion_invalid_url';
    return e;
  }
  if (code === 'rate_limited' || status === 429) {
    const e = new Error('Notion limitou as requisições (rate limit). Aguarde alguns segundos e tente novamente.');
    e.code = 'notion_rate_limit';
    return e;
  }
  return err;
}

// ─── Parser principal ─────────────────────────────────────────────────────
// diaAncora: nome do dia da semana da aula (ex: "Quarta") — determina a
// partir de qual dia os offsets "antes/depois" são calculados. Default
// "Terça" mantém compatibilidade com campanhas sem data configurada ainda.
export async function importarSequenciaDoNotion(urlOrId, diaAncora) {
  const { pre: DIA_OFFSET_PRE, pos: DIA_OFFSET_POS } = construirOffsetMaps(diaAncora || 'Terça');
  const pageId = extractPageId(urlOrId);
  if (!pageId) throw new Error('URL/ID do Notion inválido — cole a URL completa da página (https://www.notion.so/...)');

  // Busca todos os blocos top-level (com paginação)
  const all = [];
  let cursor;
  try {
    do {
      const resp = await notion.blocks.children.list({
        block_id: pageId,
        page_size: 100,
        start_cursor: cursor,
      });
      all.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : null;
    } while (cursor);
  } catch (err) {
    throw traduzirErroNotion(err, pageId);
  }

  const mensagens = [];
  const ignorados = []; // {texto, motivo} pros H2 que não casaram
  let atual = null;
  // Dentro de cada fase (WZ/RN/DS/IN), tracka se já passamos pelo dia-âncora
  // pra decidir se os próximos dias usam PRE ou POS do offset.
  let fasePassouAncora = { WZ: false, RN: false, DS: false, DC: false, IN: false };
  // Contador pra auto-numerar itens sem número explícito (ex: "RN · Domingo · 09h")
  const autoContador = { WZ: 0, RN: 0, DS: 0, DC: 0, IN: 0 };
  // Data fixa da seção atual (ex: cabeçalho "📆 SEGUNDA (08/06)"). Quando presente,
  // os itens abaixo são agendados nessa data exata + a hora do item — em vez do
  // offset relativo à terça. Resolve sequências multi-semana e multi-aula.
  let dataSecaoAtual = null; // { dia, mes }

  // Monta ISO absoluto (Brasília UTC-3) a partir de dia/mês da seção + hora.
  // Ano: corrente; se a data ficou >180 dias no passado, assume o próximo ano
  // (cobre virada de ano sem bagunçar a ordem de sequências curtas).
  function absolutoDeSecao(dia, mes, hora, min) {
    const agora = new Date();
    let ano = agora.getUTCFullYear();
    let ms = Date.UTC(ano, mes - 1, dia, hora + 3, min);
    if (ms < agora.getTime() - 180 * 24 * 60 * 60 * 1000) {
      ano += 1;
      ms = Date.UTC(ano, mes - 1, dia, hora + 3, min);
    }
    return new Date(ms).toISOString();
  }

  // Constrói item da sequência a partir do texto do header de uma ação
  // (heading_2, toggle ou quote RN/DC). Retorna null se não casa em nenhum padrão.
  function parseHeader(texto) {
    if (!texto) return null;

    // ── Pattern LIVRE (data absoluta): "04/06 às 20h · label", "04/06/2026 20:00 · label", etc
    const livre = parseDataAbsoluta(texto);
    if (livre) {
      const idNum = mensagens.filter(x => x.prefixo === 'LV').length + 1;
      const dd = String(livre.dia).padStart(2, '0');
      const mmStr = String(livre.mes).padStart(2, '0');
      const hhStr = String(livre.hora).padStart(2, '0');
      const miStr = String(livre.min).padStart(2, '0');
      return {
        id: `LV${idNum}`, prefixo: 'LV', tipoAcao: 'enviar_mensagem',
        dia: '', offset: null, absoluto: livre.absolutoUTC,
        label: livre.label || `${dd}/${mmStr} ${hhStr}:${miStr}`,
        tipo: 'texto', mensagem: '', imageUrl: null, hora: livre.hora, min: livre.min,
      };
    }

    // Remove emoji prefix (ex: "🔄 RN ..." vira "RN ...")
    const semEmoji = texto.replace(/^[^\w]+/, '').trim();

    // ── Pattern PREFIXO + DATA INLINE: "NC-A1 · Seg 29/06 · 8h · label".
    // Código livre (NC, CR, etc.) com data absoluta embutida. Tratado como
    // mensagem de data fixa — mesma máquina do modo livre (LV), por isso o
    // prefixo vira 'LV' (entra no fluxo de agendamento absoluto já existente).
    // O código original é preservado na label pra continuar visível na UI.
    const inline = parseDataInlineComPrefixo(semEmoji);
    if (inline) {
      const idNum = mensagens.filter(x => x.prefixo === 'LV').length + 1;
      return {
        id: `LV${idNum}`, prefixo: 'LV', tipoAcao: 'enviar_mensagem',
        dia: '', offset: null, absoluto: inline.absolutoUTC,
        label: `${inline.codigo} · ${inline.label}`.trim(),
        tipo: 'texto', mensagem: '', imageUrl: null, hora: inline.hora, min: inline.min,
      };
    }

    // Patterns:
    //   "WZ1 · Quarta · 22h · label"      — hora separada por ·
    //   "WZ1 · Qua 22h · label"           — dia e hora combinados (abrev)
    //   "RN · Dom 09h → label"            — separador → (RN/DC)
    const sepHora = '\\s*[·→]\\s*';
    const mInline = semEmoji.match(/^(WZ|RN|DS|DC|IN)\s*(\d*[a-zA-Z]*)\s*·\s*(\p{L}+)\s*·\s*(\d{1,2})h(\d{1,2})?(?:\s*[·→]\s*(.+))?$/u);
    const mCombinado = semEmoji.match(/^(WZ|RN|DS|DC|IN)\s*(\d*[a-zA-Z]*)\s*·\s*(\p{L}+)\s+(\d{1,2})h(\d{1,2})?(?:\s*[·→]\s*(.+))?$/u);
    const mAny = mInline || mCombinado;
    const m = mAny || semEmoji.match(/^(WZ|RN|DS|DC|IN)\s*(\d*[a-zA-Z]*)\s*·\s*(\p{L}+)\s*·\s*(.+)$/u);
    if (!m) {
      // Cabeçalhos de seção do calendário ("📆 QUARTA", "🚧 SEGUNDA + ...") são
      // visuais e não devem aparecer como erro pro usuário.
      const ehSecaoDia = /^[A-ZÀ-Ú]{4,}(\s|\+|·|$)/.test(semEmoji);
      if (!ehSecaoDia) {
        let motivo;
        const prefMatch = semEmoji.match(/^([A-Z]+-?[A-Z0-9]*)/);
        if (prefMatch && !['WZ','RN','DS','DC','IN'].includes(prefMatch[1])) {
          motivo = `prefixo "${prefMatch[1]}" não reconhecido (use WZ/RN/DS/DC/IN ou data fixa "04/06 às 20h · label")`;
        } else if (!semEmoji.includes('·') && !/\d{1,2}\/\d{1,2}/.test(semEmoji)) {
          motivo = 'faltam separadores "·" ou data (ex: "04/06 às 20h · label")';
        } else {
          motivo = 'formato não reconhecido';
        }
        ignorados.push({ texto, motivo });
      }
      return null;
    }

    const prefixo = m[1];
    const dia = m[3].trim();
    const horaInline = mAny ? parseInt(mAny[4], 10) : null;
    const minInline = mAny && mAny[5] ? parseInt(mAny[5], 10) : (mAny ? 0 : null);
    const labelMatch = mAny ? (mAny[6] || '') : m[4];

    let offset;
    const isDiaAncora = DIA_INDEX[dia] === (DIA_INDEX[diaAncora] ?? DIA_INDEX['Terça']);
    if (prefixo === 'IN') {
      offset = DIA_OFFSET_POS[dia];
      if (isDiaAncora) fasePassouAncora.IN = true;
    } else {
      offset = fasePassouAncora[prefixo] ? DIA_OFFSET_POS[dia] : DIA_OFFSET_PRE[dia];
      if (isDiaAncora) fasePassouAncora[prefixo] = true;
    }

    if (offset === undefined) {
      ignorados.push({ texto, motivo: `dia "${dia}" não é dia da semana válido` });
      return null;
    }

    let numPart = m[2] || '';
    if (!numPart) {
      autoContador[prefixo] = (autoContador[prefixo] || 0) + 1;
      numPart = String(autoContador[prefixo]);
    }

    // Se a seção atual tem data fixa (ex: "📆 SEGUNDA (08/06)"), usa-a + a hora
    // do item como data ABSOLUTA. Senão, cai no offset relativo à terça (legado).
    const horaItem = horaInline ?? 0;
    const minItem = minInline ?? 0;
    const absoluto = dataSecaoAtual
      ? absolutoDeSecao(dataSecaoAtual.dia, dataSecaoAtual.mes, horaItem, minItem)
      : null;

    return {
      id: `${prefixo}${numPart}`,
      prefixo, tipoAcao: PREFIXO_TIPO_ACAO[prefixo],
      dia, offset, absoluto,
      label: labelMatch.trim() || dia,
      tipo: 'texto', mensagem: '', imageUrl: null,
      hora: horaItem, min: minItem,
    };
  }

  // Processa um bloco de conteúdo (quote/code/image) preenchendo `atual`.
  async function processarConteudo(block, atual) {
    if (!atual) return;
    const tipo = block.type;
    if (tipo === 'quote') {
      const texto = await blockTextRecursive(block);
      if (!atual.mensagem) {
        const mNome = texto.match(/Novo\s+nome\s*:\s*(.+)/i);
        const mDesc = texto.match(/Nova\s+descri[çc][aã]o\s*:\s*(.+)/i);
        if (mNome) atual.mensagem = mNome[1].trim();
        else if (mDesc) atual.mensagem = mDesc[1].trim();
      }
      if (atual.hora === null && /Hor[aá]rio/i.test(texto)) {
        const hr = parseHorario(texto);
        if (hr) { atual.hora = hr.hora; atual.min = hr.min; }
      }
      if (!atual.imageUrl) {
        const imgMatch =
          texto.match(/https?:\/\/ik\.imagekit\.io\/\S+/) ||
          texto.match(/https?:\/\/storage\.sendflow\.[^\s)]+/i) ||
          texto.match(/https?:\/\/\S+\.(?:jpe?g|png|webp|gif|mp4|mov|webm)(?:\?\S*)?/i);
        if (imgMatch) {
          const url = await normalizarImagem(imgMatch[0]);
          atual.imageUrl = url;
          atual.tipo = /\.(mp4|mov|webm)(?:\?|$)/i.test(url) ? 'video' : 'imagem';
        }
      }
    } else if (tipo === 'code') {
      atual.mensagem = richTextToString(block.code.rich_text).trim();
    } else if (tipo === 'image' && !atual.imageUrl) {
      const img = block.image;
      const url = img?.external?.url || img?.file?.url;
      if (url) {
        atual.imageUrl = await normalizarImagem(url);
        atual.tipo = 'imagem';
      }
    }
  }

  // Detecta data num cabeçalho de seção (ex: "📆 SEGUNDA (08/06) — AULA 1" → {8,6})
  function dataDeCabecalhoSecao(texto) {
    const m = (texto || '').match(/\((\d{1,2})\/(\d{1,2})\)/);
    if (!m) return null;
    const dia = parseInt(m[1], 10), mes = parseInt(m[2], 10);
    if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
    return { dia, mes };
  }

  for (const block of all) {
    const tipo = block.type;

    // Cabeçalho de seção com data fixa (ex: "📆 SEGUNDA (08/06)") — define a
    // data dos itens abaixo. Não é um item em si.
    if (tipo === 'heading_1' || tipo === 'heading_2' || tipo === 'heading_3') {
      const txtH = richTextToString(block[tipo].rich_text).trim();
      const dataSec = dataDeCabecalhoSecao(txtH);
      if (dataSec) {
        if (atual) { mensagens.push(atual); atual = null; }
        dataSecaoAtual = dataSec;
        continue;
      }
    }

    // Action header: heading_2 ou toggle
    if (tipo === 'heading_2' || tipo === 'toggle') {
      if (atual) mensagens.push(atual);
      const texto = richTextToString(block[tipo].rich_text).trim();
      atual = parseHeader(texto);

      // Toggle: o conteúdo (quote/code/image) está nos filhos do bloco
      if (atual && tipo === 'toggle' && block.has_children) {
        const kids = await notion.blocks.children.list({ block_id: block.id, page_size: 100 });
        for (const k of kids.results) {
          await processarConteudo(k, atual);
        }
      }
    } else if (tipo === 'quote' || tipo === 'paragraph') {
      // Quote/parágrafo no top-level pode ser:
      //   1. RN/DC standalone: "🔄 RN · Dom 09h → label" (ex: lista simples de
      //      trocas de nome, sem toggle — cada linha é um parágrafo comum)
      //   2. Continuação de uma ação corrente (heading_2 com filhos no mesmo nível)
      const texto = await blockTextRecursive(block);
      const semEmoji = texto.replace(/^[^\w]+/, '').trim();
      const ehAcao = /^(RN|DC)\s*(\d*[a-zA-Z]*)\s*·/u.test(semEmoji);
      if (ehAcao) {
        if (atual) mensagens.push(atual);
        atual = parseHeader(texto);
        // RN/DC em quote: a label DEPOIS do → é o "novo nome" — preenche mensagem
        if (atual && (atual.prefixo === 'RN' || atual.prefixo === 'DC') && !atual.mensagem) {
          atual.mensagem = atual.label;
        }
      } else {
        await processarConteudo(block, atual);
      }
    } else {
      await processarConteudo(block, atual);
    }
  }
  if (atual) mensagens.push(atual);

  // Ordena: livres por data absoluta; webinar por offset+hora
  mensagens.sort((a, b) => {
    if (a.absoluto && b.absoluto) return a.absoluto.localeCompare(b.absoluto);
    if (a.absoluto) return -1;
    if (b.absoluto) return 1;
    if (a.offset !== b.offset) return (a.offset ?? 0) - (b.offset ?? 0);
    if (a.hora !== b.hora) return (a.hora ?? 0) - (b.hora ?? 0);
    return (a.min ?? 0) - (b.min ?? 0);
  });

  return { mensagens, ignorados };
}

// ─── Cache local ──────────────────────────────────────────────────────────
// Schema v2: { default: {...}, campanhas: { [releaseId]: {...} } }
// Schema v1 (legacy): { syncedAt, sourceUrl, mensagens } → migrado pra default.

async function lerRawCache() {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Migração do schema antigo
    if (parsed && (parsed.mensagens || parsed.syncedAt) && !parsed.campanhas) {
      return { default: parsed, campanhas: {} };
    }
    return { default: parsed.default || null, campanhas: parsed.campanhas || {} };
  } catch {
    return { default: null, campanhas: {} };
  }
}

async function gravarRawCache(data) {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export async function salvarCache(mensagens, sourceUrl, releaseId) {
  const all = await lerRawCache();
  const urls = Array.isArray(sourceUrl) ? sourceUrl : (sourceUrl ? [sourceUrl] : []);
  const payload = {
    syncedAt: new Date().toISOString(),
    sourceUrl: urls[0] || null,           // back-compat
    sourceUrls: urls,                     // multi-Notion
    mensagens,
  };
  if (releaseId) {
    all.campanhas[releaseId] = payload;
  } else {
    all.default = payload;
  }
  await gravarRawCache(all);
  return payload;
}

export async function lerCache(releaseId) {
  const all = await lerRawCache();
  if (releaseId && all.campanhas[releaseId]) return all.campanhas[releaseId];
  return all.default;
}

export async function limparCache(releaseId) {
  const all = await lerRawCache();
  if (releaseId) delete all.campanhas[releaseId];
  else all.default = null;
  await gravarRawCache(all);
}

// ─── Config (URL do Notion + variáveis de substituição) ───────────────────
// Schema v2: { default: {...}, campanhas: { [releaseId]: {...} } }
// Schema v1 (legacy): { notionUrl, nomeBase, linkInscricao, horaWebinario } (flat)
//   → migrado pra default na primeira leitura.

async function lerRawConfig() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    // Migração: se tem chaves flat (v1) e nenhuma chave v2, trata como default
    const v2Keys = parsed && (parsed.default || parsed.campanhas);
    if (!v2Keys && parsed && typeof parsed === 'object') {
      const { default: _d, campanhas: _c, ...flat } = parsed;
      if (Object.keys(flat).length) {
        return { default: flat, campanhas: {} };
      }
    }
    return { default: parsed.default || {}, campanhas: parsed.campanhas || {} };
  } catch {
    return { default: {}, campanhas: {} };
  }
}

async function gravarRawConfig(data) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/** Lê config merged: default + overrides da campanha. */
export async function lerConfig(releaseId) {
  const all = await lerRawConfig();
  if (!releaseId) return { ...all.default };
  return { ...all.default, ...(all.campanhas[releaseId] || {}) };
}

/** Salva patch. Se releaseId é dado, grava só nessa campanha; senão no default. */
export async function salvarConfig(patch, releaseId) {
  const all = await lerRawConfig();
  if (releaseId) {
    all.campanhas[releaseId] = { ...(all.campanhas[releaseId] || {}), ...patch };
    await gravarRawConfig(all);
    return lerConfig(releaseId);
  }
  all.default = { ...all.default, ...patch };
  await gravarRawConfig(all);
  return all.default;
}

/** Remove config de uma campanha (não mexe no default). */
export async function removerConfigCampanha(releaseId) {
  const all = await lerRawConfig();
  delete all.campanhas[releaseId];
  await gravarRawConfig(all);
}

/** Lista todas as campanhas configuradas (pra UI). */
export async function listarCampanhasConfig() {
  const all = await lerRawConfig();
  const cache = await lerRawCache();
  return Object.entries(all.campanhas).map(([releaseId, cfg]) => ({
    releaseId,
    ...cfg,
    cache: cache.campanhas[releaseId] || null,
  }));
}

// Retrocompat — funções antigas (mantidas pra não quebrar imports existentes)
export async function salvarConfigUrl(url, releaseId) { return salvarConfig({ notionUrl: url }, releaseId); }
export async function lerConfigUrl(releaseId) { const c = await lerConfig(releaseId); return c?.notionUrl || null; }

// ─── Sync completo: busca, normaliza, salva cache ─────────────────────────
// Aceita uma URL (string) ou um array de URLs. No caso de array, as mensagens
// de todas as páginas são concatenadas na mesma sequência (útil pro modo livre
// quando o usuário divide as fases em vários Notions).
const NOMES_DIA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// Descobre o nome (PT) do dia da semana de uma data "YYYY-MM-DD".
function diaSemanaDoISO(dataISO) {
  if (!dataISO) return null;
  const [y, m, d] = dataISO.split('-').map(Number);
  if (!y || !m || !d) return null;
  return NOMES_DIA[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export async function sincronizarComNotion(urlOrIds, releaseId) {
  const urls = Array.isArray(urlOrIds) ? urlOrIds.filter(Boolean) : [urlOrIds];
  if (!urls.length) throw new Error('Nenhuma URL do Notion informada');

  // Preserva itens criados manualmente no cache atual (origem: 'manual')
  const cacheAtual = await lerCache(releaseId);
  const manuais = (cacheAtual?.mensagens || []).filter((m) => m.origem === 'manual');

  // Dia-âncora = dia da semana real da aula (config da campanha), não fixo em terça.
  const cfg = await lerConfig(releaseId);
  const dataWebinario = cfg?.dataReferencia || cfg?.dataWebinario || null;
  const diaAncora = diaSemanaDoISO(dataWebinario) || 'Terça';

  const todasMensagens = [];
  const todosIgnorados = [];
  for (const url of urls) {
    const { mensagens, ignorados } = await importarSequenciaDoNotion(url, diaAncora);
    mensagens.forEach((m) => { m.sourceUrl = url; });
    todasMensagens.push(...mensagens);
    todosIgnorados.push(...ignorados.map((i) => ({ ...i, sourceUrl: url })));
  }

  // Re-adiciona manuais (ids preservados)
  todasMensagens.push(...manuais);

  // Re-numera IDs LV globalmente (1..N) após merge
  let livreIdx = 0;
  todasMensagens.forEach((m) => {
    if (m.prefixo === 'LV') { livreIdx += 1; m.id = `LV${livreIdx}`; }
  });

  // Re-ordena o agregado (livres por absoluto, webinar por offset)
  todasMensagens.sort((a, b) => {
    if (a.absoluto && b.absoluto) return a.absoluto.localeCompare(b.absoluto);
    if (a.absoluto) return -1;
    if (b.absoluto) return 1;
    if (a.offset !== b.offset) return (a.offset ?? 0) - (b.offset ?? 0);
    if (a.hora !== b.hora) return (a.hora ?? 0) - (b.hora ?? 0);
    return (a.min ?? 0) - (b.min ?? 0);
  });

  const cache = await salvarCache(todasMensagens, urls, releaseId);
  return { ...cache, ignorados: todosIgnorados };
}
