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
import { listarGruposDoRelease, atualizarGrupo, atualizarRelease } from './sendflow.js';

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
 * Executa IMEDIATAMENTE uma ação — usado pelo "Executar agora" e pelo
 * cron interno (fallback se algo falhou no agendamento pelo Sendflow).
 * Atualiza cada grupo individual direto (PUT /release-groups/{id}).
 */
async function executarAcao(entrada) {
  const campo = entrada.tipoAcao === 'renomear_grupo' ? 'name'
              : entrada.tipoAcao === 'atualizar_descricao' ? 'description'
              : null;
  if (!campo) throw new Error(`tipoAcao desconhecido: ${entrada.tipoAcao}`);

  const { data: grupos } = await listarGruposDoRelease(entrada.releaseId);
  if (!grupos?.length) throw new Error('Nenhum grupo criado nesse release ainda');

  const detalhes = [];
  for (const g of grupos) {
    try {
      await atualizarGrupo(g.id, { [campo]: entrada.payload });
      detalhes.push({ grupoId: g.id, nome: g.name, ok: true });
    } catch (err) {
      const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
      detalhes.push({ grupoId: g.id, nome: g.name, ok: false, erro: msg });
    }
  }

  const falhas = detalhes.filter((d) => !d.ok).length;
  if (falhas === detalhes.length) {
    throw new Error(`Todas as ${detalhes.length} tentativas falharam. Primeira: ${detalhes[0].erro}`);
  }
  return { gruposAtualizados: detalhes };
}

/**
 * Agenda uma lista de ações (RN ou DS) — agora diretamente no Sendflow.
 * Cada item dispara uma chamada PUT /releases/{id} com scheduled=true,
 * o que cria uma ação na aba "Agendado" do Sendflow. O Sendflow dispara
 * no horário sozinho (sem depender do nosso servidor).
 *
 * Mantemos também o registro local pra auditoria/histórico.
 *
 * @param {Array} items - cada item: { id, prefixo, tipoAcao, scheduledTo, releaseId, accountId, mensagem, label }
 */
export async function agendarAcoes(items) {
  if (!items?.length) return [];
  const atual = await ler();
  const resultados = [];
  for (const it of items) {
    const entradaBase = {
      id: `${it.id}-${it.scheduledTo}`,
      acaoId: it.id,
      prefixo: it.prefixo,
      tipoAcao: it.tipoAcao,
      scheduledTo: it.scheduledTo,
      releaseId: it.releaseId,
      accountId: it.accountId || null,
      payload: it.mensagem,
      label: it.label || '',
      criadoEm: new Date().toISOString(),
    };

    try {
      // Agenda NO SENDFLOW (aparece na aba "Agendado")
      const payload = { releaseId: it.releaseId, scheduled: true, scheduledTo: it.scheduledTo };
      if (it.tipoAcao === 'renomear_grupo') payload.nomeGrupo = it.mensagem;
      else if (it.tipoAcao === 'atualizar_descricao') payload.descricao = it.mensagem;
      else throw new Error(`tipoAcao não suportado: ${it.tipoAcao}`);
      const r = await atualizarRelease(payload);

      const entrada = { ...entradaBase, status: 'agendado_sendflow', sendflowResponse: r.data };
      const semDup = atual.filter((e) => e.id !== entrada.id);
      semDup.push(entrada);
      atual.length = 0;
      atual.push(...semDup);
      resultados.push({ id: entrada.id, ok: true, scheduledTo: entrada.scheduledTo });
    } catch (err) {
      const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
      const entrada = { ...entradaBase, status: 'erro_agendamento', erro: msg };
      const semDup = atual.filter((e) => e.id !== entrada.id);
      semDup.push(entrada);
      atual.length = 0;
      atual.push(...semDup);
      resultados.push({ id: entrada.id, ok: false, erro: msg });
    }

    // Pausa pequena pra não bombar a API
    await new Promise((r) => setTimeout(r, 300));
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

/** Executa ações pendentes cujo scheduledTo já passou.
 *  NOTA: hoje a gente agenda direto no Sendflow (status='agendado_sendflow'),
 *  então o cron normalmente não tem nada pra fazer. Esse loop existe apenas
 *  como fallback, pra o caso de algum agendamento ter falhado no Sendflow
 *  (status='erro_agendamento') — aí a gente tenta disparar localmente. */
export async function executarPendentes() {
  const todos = await ler();
  const agora = Date.now();
  const pendentes = todos.filter((e) =>
    (e.status === 'pendente' || e.status === 'erro_agendamento') &&
    new Date(e.scheduledTo).getTime() <= agora
  );
  if (!pendentes.length) return { executadas: 0 };

  let ok = 0, falhas = 0;
  for (const entrada of pendentes) {
    try {
      const detalhes = await executarAcao(entrada);
      entrada.status = 'executado';
      entrada.executadoEm = new Date().toISOString();
      entrada.detalhes = detalhes;
      ok++;
      console.log(`[WZ-Agendador] ✅ ${entrada.acaoId} executado (${detalhes.gruposAtualizados?.length || 0} grupos)`);
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

/** Força a execução imediata de UM agendamento (pra testes). */
export async function forcarExecucao(id) {
  const todos = await ler();
  const entrada = todos.find((e) => e.id === id);
  if (!entrada) throw new Error('Agendamento não encontrado');
  if (entrada.status !== 'pendente') throw new Error(`Status atual: ${entrada.status}`);
  try {
    const detalhes = await executarAcao(entrada);
    entrada.status = 'executado';
    entrada.executadoEm = new Date().toISOString();
    entrada.detalhes = detalhes;
    entrada.forcado = true;
    await salvar(todos);
    return { ok: true, entrada };
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}` : err.message;
    entrada.status = 'erro';
    entrada.erro = msg;
    entrada.tentadoEm = new Date().toISOString();
    await salvar(todos);
    throw new Error(msg);
  }
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
