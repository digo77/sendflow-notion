const SWITCHY_BASE_URL = 'https://api.switchy.io/v1';
const API_KEY = () => process.env.SWITCHY_API_KEY;

function headers() {
  return {
    'Content-Type': 'application/json',
    'Api-Authorization': API_KEY(),
  };
}

/**
 * Atualiza a URL de destino de um link via REST API.
 * Usa PUT /v1/links/by-domain/:domain/:id para evitar ambiguidade.
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
    body: JSON.stringify({ link: { url: novaUrl } }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Switch.io erro ${res.status}: ${text}`);

  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  return data;
}

/**
 * Lista links de um domínio (diagnóstico — mostra os campos reais do schema).
 */
export async function listarLinks(domain, limit = 10) {
  const domainFilter = domain ? `, where: { domain: { _ilike: "%${domain}%" } }` : '';
  const res = await fetch('https://graphql.switchy.io/v1/graphql', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      query: `query { links(limit: ${limit}${domainFilter}, order_by: { created_at: desc }) { id url domain } }`,
    }),
  });
  if (!res.ok) throw new Error(`Switch.io erro ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GraphQL: ${data.errors[0].message}`);
  return data?.data?.links ?? [];
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
