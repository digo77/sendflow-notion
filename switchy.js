const SWITCHY_BASE_URL = 'https://api.switchy.io/v1';
const API_KEY = () => process.env.SWITCHY_API_KEY;

function headers() {
  return {
    'Content-Type': 'application/json',
    'Api-Authorization': API_KEY(),
  };
}

/**
 * Atualiza a URL de destino de um link no Switch.io via GraphQL.
 * Usa domínio para evitar ambiguidade quando o mesmo slug existe em domínios diferentes.
 * @param {string} linkId  - Slug do link (ex: "webinar-sandwich")
 * @param {string} novaUrl - Nova URL de destino
 * @param {string} domain  - Domínio do link (ex: "link.chefaureomagalhaes.com")
 */
export async function atualizarDestinoLink(linkId, novaUrl, domain) {
  const endpoint = domain
    ? `${SWITCHY_BASE_URL}/links/by-domain/${encodeURIComponent(domain)}/${encodeURIComponent(linkId)}`
    : `${SWITCHY_BASE_URL}/links/${encodeURIComponent(linkId)}`;

  const res = await fetch(endpoint, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ link: { url: novaUrl }, autofill: false }),
  });

  if (!res.ok) {
    const erro = await res.text();
    throw new Error(`Switchy erro ${res.status}: ${erro}`);
  }

  return res.json();
}

/**
 * Testa a conexão com a API do Switch.io via GraphQL.
 */
export async function testarConexao() {
  const res = await fetch('https://graphql.switchy.io/v1/graphql', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      query: 'query { workspaces { id name } }',
    }),
  });

  if (!res.ok) throw new Error(`Switch.io conexão falhou: ${res.status}`);
  const data = await res.json();
  return data?.data?.workspaces ?? [];
}
