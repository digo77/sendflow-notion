import {
  buscarAgendamentosPendentes,
  buscarAguardandoExpirados,
  atualizarAgendamento,
  resolverCampanha,
} from './notion.js';
import { renomearGrupo, enviarMensagem } from './sendflow.js';
import { pedirConfirmacao, limparExpirados } from './confirmacao.js';
import { registrarLog } from './backup.js';

/**
 * Ciclo principal: busca pendentes, pede confirmação, cancela expirados.
 */
export async function ciclo() {
  console.log(`[${new Date().toISOString()}] Iniciando ciclo...`);

  try {
    // 1. Buscar agendamentos pendentes prontos para execução
    const pendentes = await buscarAgendamentosPendentes();
    console.log(`  ${pendentes.length} agendamento(s) pendente(s)`);

    for (const ag of pendentes) {
      try {
        if (!ag.campanhaRelation) {
          await atualizarAgendamento(ag.id, 'erro', 'Campanha não vinculada');
          registrarLog(ag.id, 'erro', 'Campanha não vinculada');
          continue;
        }

        // Resolver dados da campanha
        const campanha = await resolverCampanha(ag.campanhaRelation);
        if (!campanha.idSendflow) {
          await atualizarAgendamento(ag.id, 'erro', 'ID Sendflow não encontrado na campanha');
          registrarLog(ag.id, 'erro', 'ID Sendflow ausente');
          continue;
        }

        // Mudar status para aguardando_ok
        await atualizarAgendamento(ag.id, 'aguardando_ok');

        // Enviar pedido de confirmação via WhatsApp
        const shortId = await pedirConfirmacao(
          ag,
          campanha.nome,
          campanha.idSendflow,
          campanha.instancia || process.env.SENDFLOW_ACCOUNT_ID
        );
        console.log(`  Confirmação enviada: ${ag.nome} [${shortId}]`);
        registrarLog(ag.id, 'aguardando_ok', `Confirmação enviada [${shortId}]`);
      } catch (err) {
        console.error(`  Erro no agendamento ${ag.nome}:`, err.message);
        await atualizarAgendamento(ag.id, 'erro', err.message).catch(() => {});
        registrarLog(ag.id, 'erro', err.message);
      }
    }

    // 2. Cancelar aprovações expiradas (>60min sem resposta)
    const expirados = limparExpirados();
    for (const dados of expirados) {
      try {
        await atualizarAgendamento(dados.pageId, 'cancelado', 'Expirado sem resposta (60min)');
        console.log(`  Expirado: ${dados.nome}`);
        registrarLog(dados.pageId, 'cancelado', 'Expirado sem resposta');
      } catch (err) {
        console.error(`  Erro ao cancelar expirado ${dados.nome}:`, err.message);
      }
    }

    // 3. Verificar no Notion agendamentos aguardando_ok expirados (redundância)
    const expiradosNotion = await buscarAguardandoExpirados();
    for (const ag of expiradosNotion) {
      try {
        await atualizarAgendamento(ag.id, 'cancelado', 'Expirado sem resposta (60min)');
        console.log(`  Expirado (Notion): ${ag.nome}`);
        registrarLog(ag.id, 'cancelado', 'Expirado (verificação Notion)');
      } catch (err) {
        console.error(`  Erro ao cancelar expirado Notion:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[Ciclo] Erro geral:`, err.message);
  }

  console.log(`[${new Date().toISOString()}] Ciclo concluído.\n`);
}

/**
 * Executa a ação aprovada via Sendflow e atualiza o Notion.
 */
export async function executarAcao(dados) {
  const { pageId, tipoAcao, releaseId, accountId, parametro, nome } = dados;

  try {
    let resultado;

    if (tipoAcao === 'renomear_grupo') {
      resultado = await renomearGrupo(releaseId, parametro);
    } else if (tipoAcao === 'enviar_mensagem') {
      resultado = await enviarMensagem(releaseId, parametro, accountId);
    } else {
      throw new Error(`Tipo de ação desconhecido: ${tipoAcao}`);
    }

    const resumo = `HTTP ${resultado.status} — ${JSON.stringify(resultado.data).slice(0, 500)}`;
    await atualizarAgendamento(pageId, 'executado', resumo);
    console.log(`  Executado: ${nome} -> ${resumo.slice(0, 100)}`);
    registrarLog(pageId, 'executado', resumo);

    return { ok: true, resultado };
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data).slice(0, 500)}`
      : err.message;
    await atualizarAgendamento(pageId, 'erro', msg).catch(() => {});
    console.error(`  Erro ao executar ${nome}:`, msg);
    registrarLog(pageId, 'erro', msg);

    return { ok: false, erro: msg };
  }
}
