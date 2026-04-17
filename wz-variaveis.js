/**
 * wz-variaveis.js
 * Substituição de variáveis nas mensagens (suporta {data}, {hora},
 * {nome_base}, {link_inscricao}).
 *
 * Aceita vários formatos de sintaxe:
 *   {data}, {{data}}, {{ data }}
 *   para compatibilidade com texto copiado de diferentes lugares.
 */

/**
 * Formata data ISO (YYYY-MM-DD) para DD/MM em PT-BR.
 */
export function formatarDataBR(iso) {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${m[3]}/${m[2]}`;
}

/**
 * Aplica substituições num texto.
 * @param {string} texto
 * @param {object} valores - { data, hora, nome_base, link_inscricao }
 */
export function aplicarVariaveis(texto, valores = {}) {
  if (!texto) return texto;
  const mapa = {
    data: valores.data || '',
    hora: valores.hora != null ? String(valores.hora) : '',
    nome_base: valores.nome_base || '',
    link_inscricao: valores.link_inscricao || '',
  };
  return texto.replace(/\{\{?\s*(data|hora|nome_base|link_inscricao)\s*\}?\}/g, (_full, chave) => mapa[chave] ?? '');
}

/**
 * Aplica substituições em todas as mensagens de uma sequência.
 * Retorna uma cópia — não muta a entrada.
 */
export function aplicarVariaveisSequencia(mensagens, valores = {}) {
  return mensagens.map((m) => ({
    ...m,
    mensagem: aplicarVariaveis(m.mensagem, valores),
    label: m.label,
    imageUrl: m.imageUrl,
  }));
}
