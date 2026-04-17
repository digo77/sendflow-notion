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

// ─── Mapeamento dia da semana → offset relativo à terça do webinário ──────
// Há dois mapas: o PRE (dias ANTES da terça do webinário) e o POS (dias
// DEPOIS). Usamos o mapa PRE por padrão, mas se já passamos pela terça
// dentro de uma mesma fase, os próximos dias usam o mapa POS.
const DIA_OFFSET_PRE = {
  Quarta: -6, Quinta: -5, Sexta: -4,
  Sábado: -3, Sabado: -3,
  Domingo: -2, Segunda: -1,
  Terça: 0, Terca: 0,
};

const DIA_OFFSET_POS = {
  Terça: 0, Terca: 0,
  Quarta: 1, Quinta: 2, Sexta: 3,
  Sábado: 4, Sabado: 4,
  Domingo: 5, Segunda: 6,
};

// Mapeamento prefixo → tipoAcao
const PREFIXO_TIPO_ACAO = {
  WZ: 'enviar_mensagem',
  IN: 'enviar_mensagem',
  RN: 'renomear_grupo',
  DS: 'atualizar_descricao',
};

// ─── Helpers ──────────────────────────────────────────────────────────────
function extractPageId(urlOrId) {
  if (!urlOrId) return null;
  const cleaned = urlOrId.replace(/-/g, '');
  const match = cleaned.match(/([a-f0-9]{32})/i);
  return match ? match[1] : null;
}

/**
 * Converte qualquer URL do ImageKit para formato que o Sendflow/WhatsApp aceita:
 *   - Garante transform /tr:...,f-jpg/... (força JPG mesmo se o arquivo é .webp)
 *   - Garante extensão .jpg no final do path
 *   - Remove query string (updatedAt=...)
 */
function normalizarImagem(url) {
  if (!url) return null;

  // 1. Remove query string
  let out = url.split('?')[0];

  // 2. Se não é ImageKit, só garante .jpg e retorna
  if (!/ik\.imagekit\.io/.test(out)) {
    out = out.replace(/\.(webp|jpg|jpeg|png|gif)$/i, '');
    return out + '.jpg';
  }

  // 3. Remove extensão existente no path
  out = out.replace(/\.(webp|jpg|jpeg|png|gif)$/i, '');

  // 4. Parse: base (https://ik.imagekit.io/account) + transform opcional (/tr:...) + path
  const match = out.match(/^(https?:\/\/ik\.imagekit\.io\/[^\/]+)(\/tr:[^\/]+)?(\/.+)$/);
  if (!match) return out + '.jpg';

  const [, base, transform, path] = match;
  let newTransform;

  if (transform) {
    newTransform = transform;
    if (/f-webp/.test(newTransform)) {
      newTransform = newTransform.replace(/f-webp/g, 'f-jpg');
    } else if (!/f-jpg/.test(newTransform)) {
      newTransform = newTransform + ',f-jpg';
    }
  } else {
    newTransform = '/tr:f-jpg';
  }

  return base + newTransform + path + '.jpg';
}

function parseHorario(str) {
  // "11h", "09h", "20h30"
  const m = str.match(/(\d{1,2})h(\d{1,2})?/);
  if (!m) return null;
  return { hora: parseInt(m[1], 10), min: m[2] ? parseInt(m[2], 10) : 0 };
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

// ─── Parser principal ─────────────────────────────────────────────────────
export async function importarSequenciaDoNotion(urlOrId) {
  const pageId = extractPageId(urlOrId);
  if (!pageId) throw new Error('URL/ID do Notion inválido');

  // Busca todos os blocos top-level (com paginação)
  const all = [];
  let cursor;
  do {
    const resp = await notion.blocks.children.list({
      block_id: pageId,
      page_size: 100,
      start_cursor: cursor,
    });
    all.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : null;
  } while (cursor);

  const mensagens = [];
  let atual = null;
  // Dentro de cada fase (WZ/RN/DS/IN), tracka se já passamos pela Terça
  // pra decidir se os próximos dias usam PRE ou POS do offset.
  let fasePassouTerca = { WZ: false, RN: false, DS: false, IN: false };

  for (const block of all) {
    const tipo = block.type;

    if (tipo === 'heading_2') {
      // fecha a mensagem anterior
      if (atual) mensagens.push(atual);
      const texto = richTextToString(block.heading_2.rich_text).trim();
      // Pattern: "WZ1 · Quarta · label" | "RN1 · Sábado · label" etc.
      const m = texto.match(/^(WZ|RN|DS|IN)\s*(\d+)\s*·\s*(\p{L}+)\s*·\s*(.+)$/u);
      if (!m) { atual = null; continue; }

      const prefixo = m[1];
      const dia = m[3].trim();
      // IN sempre é pós-webinário; RN/DS usam contexto; WZ sempre pré
      let offset;
      if (prefixo === 'IN') {
        offset = DIA_OFFSET_POS[dia];
        if (dia === 'Terça' || dia === 'Terca') fasePassouTerca.IN = true;
      } else if (prefixo === 'WZ') {
        offset = DIA_OFFSET_PRE[dia];
      } else {
        // RN ou DS: antes da primeira Terça da fase usa PRE, depois POS
        offset = fasePassouTerca[prefixo] ? DIA_OFFSET_POS[dia] : DIA_OFFSET_PRE[dia];
        if (dia === 'Terça' || dia === 'Terca') fasePassouTerca[prefixo] = true;
      }

      if (offset === undefined) { atual = null; continue; }

      atual = {
        id: `${prefixo}${m[2]}`,
        prefixo,
        tipoAcao: PREFIXO_TIPO_ACAO[prefixo],
        dia,
        offset,
        label: m[4].trim(),
        tipo: 'texto',
        mensagem: '',
        imageUrl: null,
        hora: null,
        min: 0,
      };
    } else if (atual && tipo === 'quote') {
      const texto = await blockTextRecursive(block);

      // Horário: só considera quote que contém "Horário" (evita confusão
      // com URLs que têm dígitos+h tipo "ik8ho")
      if (atual.hora === null && /Hor[aá]rio/i.test(texto)) {
        const hr = parseHorario(texto);
        if (hr) { atual.hora = hr.hora; atual.min = hr.min; }
      }

      // URL da imagem: só quote que contém 🔗 (evita pegar link de Instagram
      // do 📲, que não serve como mídia pro Sendflow)
      if (!atual.imageUrl && texto.includes('🔗')) {
        const imgMatch = texto.match(/https?:\/\/ik\.imagekit\.io\/\S+/);
        if (imgMatch) {
          atual.imageUrl = normalizarImagem(imgMatch[0]);
          atual.tipo = 'imagem';
        }
      }
    } else if (atual && tipo === 'code') {
      atual.mensagem = richTextToString(block.code.rich_text).trim();
    }
    // image blocks são ignorados (a URL real vem do blockquote)
  }
  if (atual) mensagens.push(atual);

  // Ordena pela ordem natural dia+hora
  mensagens.sort((a, b) => {
    if (a.offset !== b.offset) return a.offset - b.offset;
    if (a.hora !== b.hora) return (a.hora ?? 0) - (b.hora ?? 0);
    return (a.min ?? 0) - (b.min ?? 0);
  });

  return mensagens;
}

// ─── Cache local ──────────────────────────────────────────────────────────
export async function salvarCache(mensagens, sourceUrl) {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  const payload = {
    syncedAt: new Date().toISOString(),
    sourceUrl: sourceUrl || null,
    mensagens,
  };
  await writeFile(CACHE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
  return payload;
}

export async function lerCache() {
  try {
    const raw = await readFile(CACHE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Config (URL do Notion salva) ─────────────────────────────────────────
export async function salvarConfigUrl(url) {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, JSON.stringify({ notionUrl: url }, null, 2), 'utf-8');
}

export async function lerConfigUrl() {
  try {
    const raw = await readFile(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw)?.notionUrl || null;
  } catch {
    return null;
  }
}

// ─── Sync completo: busca, normaliza, salva cache ─────────────────────────
export async function sincronizarComNotion(urlOrId) {
  const mensagens = await importarSequenciaDoNotion(urlOrId);
  const cache = await salvarCache(mensagens, urlOrId);
  return cache;
}
