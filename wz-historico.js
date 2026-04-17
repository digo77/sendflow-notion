/**
 * wz-historico.js
 * Guarda o histórico das sequências WZ agendadas (persistente em JSON).
 *
 * Cada entrada contém: quando foi agendado, pra qual campanha, pra qual
 * data de webinário, quantas mensagens agendaram com sucesso, falhas,
 * os actionIds retornados pelo Sendflow.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORICO_PATH = join(__dirname, 'data', 'wz-historico.json');
const LIMITE = 100; // guarda as últimas 100 sequências

async function lerHistorico() {
  try {
    const raw = await readFile(HISTORICO_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export async function registrarHistorico({ releaseId, accountId, dataWebinario, resultados, validacao }) {
  await mkdir(dirname(HISTORICO_PATH), { recursive: true });
  const historico = await lerHistorico();
  const entrada = {
    id: `wz-${Date.now()}`,
    agendadoEm: new Date().toISOString(),
    releaseId,
    accountId: accountId || null,
    dataWebinario,
    total: resultados.length,
    agendadas: resultados.filter((r) => r.ok).length,
    falhas: resultados.filter((r) => !r.ok).length,
    validacao: validacao ? { ok: validacao.ok, erros: validacao.erros?.length || 0, avisos: validacao.avisos?.length || 0 } : null,
    resultados: resultados.map((r) => ({ id: r.id, ok: r.ok, actionId: r.actionId || null, scheduledTo: r.scheduledTo, erro: r.erro || null })),
  };
  historico.unshift(entrada);
  const truncado = historico.slice(0, LIMITE);
  await writeFile(HISTORICO_PATH, JSON.stringify(truncado, null, 2), 'utf-8');
  return entrada;
}

export async function listarHistorico(limit = 20) {
  const h = await lerHistorico();
  return h.slice(0, limit);
}
