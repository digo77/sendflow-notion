import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_TOKEN });

const DB_AGENDAMENTOS = process.env.NOTION_DATABASE_AGENDAMENTOS;
const DB_CAMPANHAS = process.env.NOTION_DATABASE_CAMPANHAS;
const DB_WEBINARIOS = process.env.NOTION_DATABASE_WEBINARIOS;

/**
 * Busca agendamentos com status "pendente" e Data/Hora <= agora + 30min.
 */
export async function buscarAgendamentosPendentes() {
  const limite = new Date(Date.now() + 30 * 60 * 1000).toISOString();

  const res = await notion.databases.query({
    database_id: DB_AGENDAMENTOS,
    filter: {
      and: [
        { property: 'Status', select: { equals: 'pendente' } },
        { property: 'Data/Hora', date: { on_or_before: limite } },
      ],
    },
  });

  return res.results.map(parseAgendamento);
}

/**
 * Busca agendamentos com status "aguardando_ok" há mais de 60 minutos.
 */
export async function buscarAguardandoExpirados() {
  const res = await notion.databases.query({
    database_id: DB_AGENDAMENTOS,
    filter: {
      property: 'Status',
      select: { equals: 'aguardando_ok' },
    },
  });

  const limite = Date.now() - 60 * 60 * 1000;
  return res.results
    .filter((p) => new Date(p.last_edited_time).getTime() < limite)
    .map(parseAgendamento);
}

/**
 * Atualiza o Status e opcionalmente o Resultado de um agendamento.
 */
export async function atualizarAgendamento(pageId, status, resultado) {
  const properties = {
    Status: { select: { name: status } },
  };
  if (resultado !== undefined) {
    properties['Resultado'] = {
      rich_text: [{ text: { content: String(resultado).slice(0, 2000) } }],
    };
  }
  await notion.pages.update({ page_id: pageId, properties });
}

/**
 * Resolve o ID Sendflow a partir da relation Campanha de um agendamento.
 */
export async function resolverCampanha(relationPageId) {
  const page = await notion.pages.retrieve({ page_id: relationPageId });
  const props = page.properties;

  const idSendflow =
    props['ID Sendflow']?.rich_text?.[0]?.plain_text || null;
  const nome =
    props['Nome da Campanha']?.title?.[0]?.plain_text || '';
  const instancia =
    props['Instância']?.select?.name || '';

  return { idSendflow, nome, instancia };
}

/**
 * Busca TODOS os agendamentos (sem filtro de status).
 */
export async function buscarTodosAgendamentos() {
  const res = await notion.databases.query({
    database_id: DB_AGENDAMENTOS,
    sorts: [{ property: 'Data/Hora', direction: 'descending' }],
    page_size: 100,
  });
  return res.results.map(parseAgendamento);
}

/**
 * Busca todas as campanhas.
 */
export async function buscarCampanhas() {
  const res = await notion.databases.query({
    database_id: DB_CAMPANHAS,
    page_size: 100,
  });
  return res.results.map((page) => {
    const p = page.properties;
    return {
      id: page.id,
      nome: p['Nome da Campanha']?.title?.[0]?.plain_text || '',
      idSendflow: p['ID Sendflow']?.rich_text?.[0]?.plain_text || '',
      instancia: p['Instância']?.select?.name || '',
      status: p['Status']?.select?.name || '',
      ultimaSync: p['Última Sync']?.date?.start || null,
    };
  });
}

/**
 * Cria um novo agendamento no Notion.
 */
export async function criarAgendamento({ nome, dataHora, tipoAcao, campanhaId, parametro }) {
  const properties = {
    Nome: { title: [{ text: { content: nome } }] },
    'Data/Hora': { date: { start: dataHora } },
    'Tipo de Ação': { select: { name: tipoAcao } },
    Campanha: { relation: [{ id: campanhaId }] },
    'Parâmetro': { rich_text: [{ text: { content: parametro } }] },
    Status: { select: { name: 'pendente' } },
  };
  const page = await notion.pages.create({
    parent: { database_id: DB_AGENDAMENTOS },
    properties,
  });
  return page.id;
}

/**
 * Sincroniza campanhas do Sendflow para o Notion (upsert).
 * Recebe array de campanhas da API do Sendflow.
 */
export async function sincronizarCampanhas(campanhasSendflow) {
  // Buscar campanhas existentes no Notion
  const existentes = await buscarCampanhas();
  const mapExistentes = new Map(existentes.map((c) => [c.idSendflow, c]));

  let criadas = 0;
  let atualizadas = 0;

  for (const sf of campanhasSendflow) {
    const idSf = sf.id;
    const nome = sf.name || 'Sem nome';
    const instancia = sf.accountIds?.[0] || null;
    const status = sf.archived ? 'encerrada' : 'ativa';
    const agora = new Date().toISOString();

    const existente = mapExistentes.get(idSf);

    // Propriedades base (sem Instância se vazio)
    const baseProps = {
      'Nome da Campanha': { title: [{ text: { content: nome } }] },
      'Status': { select: { name: status } },
      'Última Sync': { date: { start: agora } },
    };
    if (instancia) {
      baseProps['Instância'] = { select: { name: instancia } };
    }

    if (existente) {
      await notion.pages.update({ page_id: existente.id, properties: baseProps });
      atualizadas++;
    } else {
      await notion.pages.create({
        parent: { database_id: DB_CAMPANHAS },
        properties: {
          ...baseProps,
          'ID Sendflow': { rich_text: [{ text: { content: idSf } }] },
        },
      });
      criadas++;
    }
  }

  return { criadas, atualizadas, total: campanhasSendflow.length };
}

// ─── Webinários ───

/**
 * Cria um novo registro de webinário no Notion.
 */
export async function criarWebinario({ nome, dataWebinario, linkGrupo, campaignId, status, switchyAtualizado, observacoes }) {
  const properties = {
    Nome: { title: [{ text: { content: nome } }] },
    'Data Webinário': { date: { start: dataWebinario } },
    'Data Criação': { date: { start: new Date().toISOString() } },
    Status: { select: { name: status } },
    'Switchy Atualizado': { checkbox: switchyAtualizado || false },
  };
  if (linkGrupo) properties['Link Grupo'] = { url: linkGrupo };
  if (campaignId) properties['Campaign ID'] = { rich_text: [{ text: { content: campaignId } }] };
  if (observacoes) properties['Observações'] = { rich_text: [{ text: { content: String(observacoes).slice(0, 2000) } }] };

  const page = await notion.pages.create({
    parent: { database_id: DB_WEBINARIOS },
    properties,
  });
  return page.id;
}

/**
 * Atualiza campos de um registro de webinário.
 */
export async function atualizarWebinario(pageId, { switchyAtualizado, observacoes, status } = {}) {
  const properties = {};
  if (switchyAtualizado !== undefined) properties['Switchy Atualizado'] = { checkbox: switchyAtualizado };
  if (observacoes !== undefined) properties['Observações'] = { rich_text: [{ text: { content: String(observacoes).slice(0, 2000) } }] };
  if (status !== undefined) properties['Status'] = { select: { name: status } };
  await notion.pages.update({ page_id: pageId, properties });
}

/**
 * Lista os últimos webinários do banco Notion.
 */
export async function listarWebinarios(limite = 10) {
  const res = await notion.databases.query({
    database_id: DB_WEBINARIOS,
    sorts: [{ property: 'Data Webinário', direction: 'descending' }],
    page_size: limite,
  });
  return res.results.map(parseWebinario);
}

/**
 * Busca um webinário pela data (yyyy-mm-dd) para verificar idempotência.
 */
export async function buscarWebinarioPorData(dataISO) {
  const res = await notion.databases.query({
    database_id: DB_WEBINARIOS,
    filter: {
      property: 'Data Webinário',
      date: { equals: dataISO },
    },
    page_size: 1,
  });
  if (!res.results.length) return null;
  return parseWebinario(res.results[0]);
}

function parseWebinario(page) {
  const p = page.properties;
  return {
    id: page.id,
    nome: p['Nome']?.title?.[0]?.plain_text || '',
    dataWebinario: p['Data Webinário']?.date?.start || null,
    dataCriacao: p['Data Criação']?.date?.start || null,
    linkGrupo: p['Link Grupo']?.url || null,
    campaignId: p['Campaign ID']?.rich_text?.[0]?.plain_text || '',
    status: p['Status']?.select?.name || '',
    switchyAtualizado: p['Switchy Atualizado']?.checkbox || false,
    observacoes: p['Observações']?.rich_text?.[0]?.plain_text || '',
  };
}

function parseAgendamento(page) {
  const p = page.properties;
  return {
    id: page.id,
    nome: p['Nome']?.title?.[0]?.plain_text || '',
    dataHora: p['Data/Hora']?.date?.start || null,
    tipoAcao: p['Tipo de Ação']?.select?.name || '',
    campanhaRelation: p['Campanha']?.relation?.[0]?.id || null,
    parametro: p['Parâmetro']?.rich_text?.[0]?.plain_text || '',
    status: p['Status']?.select?.name || '',
    resultado: p['Resultado']?.rich_text?.[0]?.plain_text || '',
  };
}
