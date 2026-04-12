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
export async function criarGrupoWebinario({ accountId, nome, descricao, fotoUrl, adminNumero }) {
  const conta = accountId || ACCOUNT();

  // 1. Criar release
  const post = await axios.post(
    `${API()}/sendapi/releases`,
    { name: nome, type: 'WhatsRelease' },
    { headers: headers(), timeout: 30000 }
  );

  const releaseId = post.data.id;

  // 2. Associar conta + configurar grupo (descrição, imagem, admins)
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
  };
  if (fotoUrl) groupSettings.image = fotoUrl;
  groupSettings.admins = [{ name: 'Admin', number: '5511974561100' }];

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
