/**
 * wz-agendador.js
 * Agendador local pra ações que o Sendflow não agenda nativamente:
 *   - renomear_grupo (RN)
 *   - atualizar_descricao (DS)
 *
 * Persiste os agendamentos em data/wz-agendados.json. Um cron roda a cada
 * minuto (iniciado em index.js) e dispara tudo que estiver com scheduledTo
 * <= agora e status === 'pendente'.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renomearGrupo, atualizarRelease } from './sendflow.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STORE_PATH = join(__dirname, 'data', 'wz-agendados.json');

async function ler() {
  try {
    const raw = await readFile(STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function salvar(lista) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify(lista, null, 2), 'utf-8');
}

/**
 * Agenda uma lista de ações (RN ou DS) pra execução futura.
 * @param {Array} items - cada item: { id, prefixo, tipoAcao, scheduledTo, releaseId, accountId, mensagem, label }
 */
export async function agendarAcoes(items) {
  if (!items?.length) return [];
  const atual = await ler();
  const resultados = [];
  for (const it of items) {
    const entrada = {
      id: `${it.id}-${it.scheduledTo}`,
      acaoId: it.id,
      prefixo: it.prefixo,
      tipoAcao: it.tipoAcao,
      scheduledTo: it.scheduledTo,
      releaseId: it.releaseId,
      accountId: it.accountId || null,
      payload: it.mensagem, // nome do grupo (RN) ou descrição (DS)
      label: it.label || '',
      status: 'pendente',
      criadoEm: new Date().toISOString(),
    };
    // Idempotência: se já existe mesmo id, remove e sobrescreve
    const semDuplicata = atual.filter((e) => e.id !== entrada.id);
    semDuplicata.push(entrada);
    atual.length = 0;
    atual.push(...semDuplicata);
    resultados.push({ id: entrada.id, ok: true, scheduledTo: entrada.scheduledTo });
  }
  await salvar(atual);
  return resultados;
}

/** Lista todos os agendamentos, com filtros opcionais. */
export async function listarAgendados({ status } = {}) {
  const todos = await ler();
  if (status) return todos.filter((e) => e.status === status);
  return todos;
}

/** Executa ações pendentes cujo scheduledTo já passou. */
export async function executarPendentes() {
  const todos = await ler();
  const agora = Date.now();
  const pendentes = todos.filter((e) => e.status === 'pendente' && new Date(e.scheduledTo).getTime() <= agora);
  if (!pendentes.length) return { executadas: 0 };

  let ok = 0, falhas = 0;
  for (const entrada of pendentes) {
    try {
      if (entrada.tipoAcao === 'renomear_grupo') {
        // O releaseId na verdade refere-se ao release no Sendflow. A
        // renomearGrupo espera o ID do GRUPO individual — mas num fluxo
        // típico (1 grupo por release) podemos atualizar via PUT release.
        // Por robustez, tentamos primeiro o rename direto; se falhar,
        // fallback em atualizarRelease.
        try {
          await renomearGrupo(entrada.releaseId, entrada.payload);
        } catch {
          await atualizarRelease({ releaseId: entrada.releaseId, nome: entrada.payload, nomeGrupo: entrada.payload });
        }
      } else if (entrada.tipoAcao === 'atualizar_descricao') {
        await atualizarRelease({ releaseId: entrada.releaseId, descricao: entrada.payload });
      } else {
        throw new Error(`tipoAcao desconhecido: ${entrada.tipoAcao}`);
      }
      entrada.status = 'executado';
      entrada.executadoEm = new Date().toISOString();
      ok++;
      console.log(`[WZ-Agendador] ✅ ${entrada.acaoId} executado`);
    } catch (err) {
      const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
      entrada.status = 'erro';
      entrada.erro = msg;
      entrada.tentadoEm = new Date().toISOString();
      falhas++;
      console.error(`[WZ-Agendador] ❌ ${entrada.acaoId}: ${msg}`);
    }
  }
  await salvar(todos);
  return { executadas: ok, falhas };
}

/** Cancela um agendamento pendente (não mexe em itens já executados). */
export async function cancelarAgendado(id) {
  const todos = await ler();
  const entrada = todos.find((e) => e.id === id);
  if (!entrada) throw new Error('Agendamento não encontrado');
  if (entrada.status !== 'pendente') throw new Error(`Status atual: ${entrada.status}, só cancela pendentes`);
  entrada.status = 'cancelado';
  entrada.canceladoEm = new Date().toISOString();
  await salvar(todos);
  return entrada;
}

/** Remove agendamentos antigos (executados/cancelados há mais de 30 dias). */
export async function limparAntigos(diasRetencao = 30) {
  const todos = await ler();
  const limite = Date.now() - diasRetencao * 24 * 60 * 60 * 1000;
  const filtrados = todos.filter((e) => {
    if (e.status === 'pendente') return true;
    const ts = new Date(e.executadoEm || e.canceladoEm || e.criadoEm).getTime();
    return ts >= limite;
  });
  if (filtrados.length < todos.length) {
    await salvar(filtrados);
  }
  return { removidos: todos.length - filtrados.length };
}
