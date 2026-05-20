import axios from 'axios';

const API = () => process.env.SENDFLOW_API_URL?.replace(/\/$/, '');
const PRO_API = 'https://sendflow.pro';
const TOKEN = () => process.env.SENDFLOW_API_TOKEN;
const ACCOUNT = () => process.env.SENDFLOW_ACCOUNT_ID;

function headers() {
  return { Authorization: `Bearer ${TOKEN()}` };
}

/**
 * Renomeia um grupo de campanha no Sendflow.
 * PUT /sendapi/release-groups/{releaseGroupId}
 */
export async function renomearGrupo(releaseGroupId, novoNome) {
  const res = await axios.put(
    `${API()}/sendapi/release-groups/${releaseGroupId}`,
    { name: novoNome },
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Envia mensagem de texto para todos os grupos de uma campanha.
 * POST /sendapi/actions/send-text-message
 */
export async function enviarMensagem(releaseId, mensagem, accountId) {
  const res = await axios.post(
    `${API()}/sendapi/actions/send-text-message`,
    {
      accountId: accountId || ACCOUNT(),
      releaseId,
      messageText: mensagem,
    },
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Envia mensagem direta para um número via WhatsApp.
 * POST /sendapi/send-text-message/{accountId}
 */
export async function enviarMensagemDireta(numero, texto, accountId) {
  const res = await axios.post(
    `${API()}/sendapi/send-text-message/${accountId || ACCOUNT()}`,
    { text: texto, phoneNumber: numero },
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Envia imagem (com caption opcional) direta para um número.
 * POST /sendapi/send-image-message/{accountId}
 */
export async function enviarImagemDireta(numero, imageUrl, caption, accountId) {
  const res = await axios.post(
    `${API()}/sendapi/send-image-message/${accountId || ACCOUNT()}`,
    { url: imageUrl, caption: caption || '', phoneNumber: numero },
    { headers: headers(), timeout: 20000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Lista campanhas (releases) do usuário.
 * GET /sendapi/releases
 */
export async function listarCampanhas() {
  const res = await axios.get(
    `${API()}/sendapi/releases`,
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Cria uma nova campanha (release) no SendFlow para o webinário.
 * 1. POST /sendapi/releases → cria a campanha
 * 2. PUT /sendapi/releases/{id} → associa a conta
 * Retorna: { id, inviteLink: 'https://sndflw.com/i/{id}' }
 */
export const ADMINS_PADRAO = [
  { name: 'Admin', number: '5511974561100' },
  { name: 'Admin', number: '5511968753518' },
  { name: 'Admin', number: '5511996651100' },
];

export const MEMBROS_PADRAO = [
  { name: 'Membro', number: '5511955591100' },
];

export async function criarGrupoWebinario({ accountId, nome, descricao, fotoUrl }) {
  const conta = accountId || ACCOUNT();

  const post = await axios.post(
    `${API()}/sendapi/releases`,
    { name: nome, type: 'WhatsRelease' },
    { headers: headers(), timeout: 30000 }
  );

  const releaseId = post.data.id;

  const groupSettings = {
    name: nome,
    fixedDescription: descricao || '',
    limit: 350,
    margin: 2,
    countStart: 4,
    numberplacedonstart: true,
    onlyAdminsSpeak: true,
    createOpenGroupAndCloseAfter: false,
    groupCreationMode: 'normal',
    antiHacker: true,
    admins: ADMINS_PADRAO,
    members: MEMBROS_PADRAO,
  };
  if (fotoUrl) groupSettings.image = fotoUrl;

  await axios.put(
    `${API()}/sendapi/releases/${releaseId}`,
    { accountIds: [conta], group: groupSettings },
    { headers: headers(), timeout: 15000 }
  );

  return {
    status: post.status,
    data: {
      id: releaseId,
      inviteLink: `https://sndflw.com/i/${releaseId}`,
    },
  };
}

/**
 * GET /sendapi/releases/{id} — inspeciona uma campanha existente.
 * Útil para descobrir os nomes exatos de campos do group.
 */
export async function obterCampanha(releaseId) {
  const res = await axios.get(
    `${API()}/sendapi/releases/${releaseId}`,
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Busca detalhes de um release (útil pra fazer merge antes de atualizar).
 * GET /sendapi/releases/{id}
 */
export async function buscarRelease(releaseId) {
  const res = await axios.get(
    `${API()}/sendapi/releases/${releaseId}`,
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Lista os grupos INDIVIDUAIS criados dentro de um release.
 * GET /sendapi/releases/{id}/groups
 */
export async function listarGruposDoRelease(releaseId) {
  const res = await axios.get(
    `${API()}/sendapi/releases/${releaseId}/groups`,
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Atualiza um grupo INDIVIDUAL do WhatsApp (nome, descrição, foto).
 * PUT /sendapi/release-groups/{releaseGroupId}
 */
export async function atualizarGrupo(releaseGroupId, { name, description, image } = {}) {
  const body = {};
  if (name !== undefined) body.name = name;
  if (description !== undefined) body.description = description;
  if (image !== undefined) body.image = image;
  if (!Object.keys(body).length) return { status: 204, data: { noop: true } };

  const res = await axios.put(
    `${API()}/sendapi/release-groups/${releaseGroupId}`,
    body,
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Atualiza configurações de um release (nome da campanha + settings do grupo).
 * PUT /sendapi/releases/{id}
 *
 * @param {object} opts
 * @param {string} opts.releaseId
 * @param {string} [opts.nome]        - Novo nome da campanha
 * @param {string} [opts.nomeGrupo]   - Novo nome do grupo (template)
 * @param {string} [opts.descricao]   - Nova descrição do grupo
 * @param {string} [opts.fotoUrl]     - URL nova da foto do grupo
 * @param {string[]} [opts.accountIds]
 */
export async function atualizarRelease({ releaseId, nome, nomeGrupo, descricao, fotoUrl, accountIds, scheduled, scheduledTo }) {
  const body = {};
  if (nome) body.name = nome;

  const alteraGroup = nomeGrupo !== undefined || descricao !== undefined || fotoUrl !== undefined;
  if (alteraGroup) {
    if (scheduled) {
      // SCHEDULED: mandamos SÓ o campo que está mudando. O Sendflow cria
      // UMA ação para esse campo e mantém os outros intactos. Se mandar
      // todos os campos, ele cria uma ação pra cada = polui a aba Agendado.
      const group = {};
      if (nomeGrupo !== undefined) group.name = nomeGrupo;
      if (descricao !== undefined) group.fixedDescription = descricao;
      if (fotoUrl !== undefined) group.image = fotoUrl;
      body.group = group;
    } else {
      // IMEDIATO: o Sendflow SOBRESCREVE o `group` inteiro se enviado parcial,
      // apagando os outros campos. Solução: GET atual e fazer merge.
      const atual = await buscarRelease(releaseId);
      const g = atual.data?.group || {};
      const group = {
        name: nomeGrupo !== undefined ? nomeGrupo : g.name,
        fixedDescription: descricao !== undefined ? descricao : g.fixedDescription,
      };
      const novaImagem = fotoUrl !== undefined ? fotoUrl : g.image;
      if (novaImagem != null) group.image = novaImagem;
      body.group = group;
    }
  }

  if (accountIds?.length) body.accountIds = accountIds;
  if (scheduled) {
    body.scheduled = true;
    body.scheduledTo = scheduledTo;
  }
  if (!Object.keys(body).length) return { status: 204, data: { noop: true } };

  const res = await axios.put(
    `${API()}/sendapi/releases/${releaseId}`,
    body,
    { headers: headers(), timeout: 20000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Lista contas conectadas.
 * GET /sendapi/accounts
 */
export async function listarContas() {
  const res = await axios.get(
    `${API()}/sendapi/accounts`,
    { headers: headers(), timeout: 15000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Agenda uma mensagem de texto para uma campanha (aparece no Sendflow como "Agendado").
 * POST https://sendflow.pro/sendapi/actions/send-text-message
 *
 * @param {object} opts
 * @param {string} opts.releaseId     - ID da campanha no Sendflow
 * @param {string} opts.accountId     - ID da instância/conta WhatsApp
 * @param {string} opts.mensagem      - Texto da mensagem
 * @param {string} opts.scheduledTo   - Data ISO 8601 (ex: "2026-04-21T13:00:00.000Z")
 * @param {string} [opts.shippingSpeed] - Velocidade: none|fast|normal|slow (padrão: none)
 */
export async function agendarMensagemTexto({ releaseId, accountId, mensagem, scheduledTo, shippingSpeed = 'none' }) {
  const res = await axios.post(
    `${PRO_API}/sendapi/actions/send-text-message`,
    {
      accountId: accountId || ACCOUNT(),
      releaseId,
      messageText: mensagem,
      scheduled: true,
      scheduledTo,
      chooseSpecificGroups: false,
      options: { shippingSpeed },
    },
    { headers: headers(), timeout: 20000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Agenda uma mensagem com imagem para uma campanha (aparece no Sendflow como "Agendado").
 * POST https://sendflow.pro/sendapi/actions/send-image-message
 *
 * @param {object} opts
 * @param {string} opts.releaseId     - ID da campanha no Sendflow
 * @param {string} opts.accountId     - ID da instância/conta WhatsApp
 * @param {string} opts.imageUrl      - URL pública da imagem
 * @param {string} [opts.caption]     - Texto/legenda junto com a imagem
 * @param {string} opts.scheduledTo   - Data ISO 8601
 * @param {string} [opts.shippingSpeed] - Velocidade: none|fast|normal|slow
 */
export async function agendarMensagemImagem({ releaseId, accountId, imageUrl, caption, scheduledTo, shippingSpeed = 'none' }) {
  const res = await axios.post(
    `${PRO_API}/sendapi/actions/send-image-message`,
    {
      accountId: accountId || ACCOUNT(),
      releaseId,
      url: imageUrl,
      caption: caption || '',
      scheduled: true,
      scheduledTo,
      chooseSpecificGroups: false,
      options: { shippingSpeed },
    },
    { headers: headers(), timeout: 20000 }
  );
  return { status: res.status, data: res.data };
}

/**
 * Agenda uma mensagem com vídeo para uma campanha.
 * POST https://sendflow.pro/sendapi/actions/send-video-message
 */
export async function agendarMensagemVideo({ releaseId, accountId, videoUrl, caption, scheduledTo, shippingSpeed = 'none' }) {
  const res = await axios.post(
    `${PRO_API}/sendapi/actions/send-video-message`,
    {
      accountId: accountId || ACCOUNT(),
      releaseId,
      url: videoUrl,
      caption: caption || '',
      scheduled: true,
      scheduledTo,
      chooseSpecificGroups: false,
      options: { shippingSpeed },
    },
    { headers: headers(), timeout: 30000 }
  );
  return { status: res.status, data: res.data };
}
