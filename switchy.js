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
  const where = domain
    ? `{ id: { _eq: "${linkId}" }, domain: { _eq: "${domain}" } }`
    : `{ id: { _eq: "${linkId}" } }`;

  const res = await fetch('https://graphql.switchy.io/v1/graphql', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      query: `
        mutation {
          update_links(
            where: ${where}
            _set: { url: "${novaUrl}" }
          ) { affected_rows returning { id url domain } }
        }
      `,
    }),
  });

  if (!res.ok) {
    const erro = await res.text();
    throw new Error(`Switch.io erro ${res.status}: ${erro}`);
  }

  const data = await res.json();
  if (data.errors) throw new Error(`Switch.io GraphQL: ${data.errors[0].message}`);

  const affected = data?.data?.update_links?.affected_rows ?? 0;
  if (affected === 0) throw new Error(`Switch.io: link "${linkId}" não encontrado`);

  return data.data.update_links.returning[0];
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
