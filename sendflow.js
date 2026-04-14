import axios from 'axios';

const API = () => process.env.SENDFLOW_API_URL?.replace(/\/$/, '');
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
