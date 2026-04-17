/**
 * wz-validar.js
 * Validação pré-agendamento da sequência WZ.
 *
 * Antes de chamar o Sendflow, roda checagens que evitam disparar um lote
 * quebrado:
 *   - URLs de imagem respondem 200 + Content-Type image/*
 *   - Nenhuma mensagem tem o mesmo dia+hora+minuto que outra
 *   - Data do webinário é futura e cai numa terça
 *   - Texto dentro do limite do WhatsApp
 *   - Mensagem de texto não é vazia
 *   - Mensagem de imagem tem URL definida
 */

const LIMITE_TEXTO_WHATSAPP = 4096;
const LIMITE_CAPTION_WHATSAPP = 1024;

/** Checa uma URL de imagem (HEAD request rápido). */
async function checarImagem(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    if (!r.ok) return { ok: false, motivo: `HTTP ${r.status}` };
    const ct = r.headers.get('content-type') || '';
    if (!/^image\//.test(ct)) return { ok: false, motivo: `Content-Type inválido: ${ct}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

export async function validarSequencia({ mensagens, dataWebinario }) {
  const erros = [];
  const avisos = [];

  // 1. Data do webinário
  if (!dataWebinario || !/^\d{4}-\d{2}-\d{2}$/.test(dataWebinario)) {
    erros.push('Data do webinário inválida (use YYYY-MM-DD).');
    return { ok: false, erros, avisos };
  }
  const [y, m, d] = dataWebinario.split('-').map(Number);
  const alvoSP = new Date(Date.UTC(y, m - 1, d, 3, 0, 0)); // meia-noite em Brasília
  const hojeSP = new Date();
  if (alvoSP.getTime() < hojeSP.getTime() - 24 * 60 * 60 * 1000) {
    erros.push(`Data do webinário (${dataWebinario}) já passou.`);
  }
  // dia da semana em UTC+3 = Brasília
  const diaSemana = alvoSP.getUTCDay(); // 0=domingo, 2=terça
  if (diaSemana !== 2) {
    avisos.push(`Data ${dataWebinario} cai em ${['dom','seg','ter','qua','qui','sex','sáb'][diaSemana]}, não numa terça-feira.`);
  }

  // 2. Sequência vazia
  if (!mensagens || !mensagens.length) {
    erros.push('Sequência vazia — sincronize com o Notion primeiro.');
    return { ok: false, erros, avisos };
  }

  // 3. Duplicatas de horário — só detecta conflito DENTRO da mesma fase
  // (ex: 2 mensagens WZ no mesmo horário = erro; mas WZ + RN no mesmo
  // horário é ok, são ações diferentes)
  const slots = new Map();
  for (const m of mensagens) {
    const fase = m.prefixo || 'WZ';
    const chave = `${fase}__${m.offset}__${m.hora}:${String(m.min ?? 0).padStart(2, '0')}`;
    if (!slots.has(chave)) slots.set(chave, []);
    slots.get(chave).push(m.id);
  }
  for (const [chave, ids] of slots) {
    if (ids.length > 1) {
      erros.push(`Conflito de horário (${chave}): ${ids.join(', ')}`);
    }
  }

  // 4. Texto vazio e limites (só valida mensagens; renames/descrições têm regras diferentes)
  const somenteMensagens = mensagens.filter((m) => !m.tipoAcao || m.tipoAcao === 'enviar_mensagem');
  for (const m of somenteMensagens) {
    if (!m.mensagem || !m.mensagem.trim()) {
      erros.push(`${m.id}: mensagem vazia.`);
      continue;
    }
    const limite = m.tipo === 'imagem' ? LIMITE_CAPTION_WHATSAPP : LIMITE_TEXTO_WHATSAPP;
    if (m.mensagem.length > limite) {
      erros.push(`${m.id}: texto com ${m.mensagem.length} chars (limite ${limite}).`);
    }
    if (m.hora === null || m.hora === undefined) {
      erros.push(`${m.id}: horário não definido.`);
    }
  }

  // 4b. Renames: só checa que o novo nome não está vazio
  for (const m of mensagens.filter((m) => m.tipoAcao === 'renomear_grupo')) {
    if (!m.mensagem || !m.mensagem.trim()) erros.push(`${m.id}: nome do grupo vazio.`);
    if (m.mensagem && m.mensagem.length > 100) avisos.push(`${m.id}: nome com ${m.mensagem.length} chars (WhatsApp recomenda <= 100).`);
  }

  // 4c. Descrições: só checa não-vazio
  for (const m of mensagens.filter((m) => m.tipoAcao === 'atualizar_descricao')) {
    if (!m.mensagem || !m.mensagem.trim()) erros.push(`${m.id}: descrição vazia.`);
  }

  // 5. Imagens acessíveis (paralelo, timeout implícito pelo fetch)
  const imagens = somenteMensagens.filter((m) => m.tipo === 'imagem');
  const semImg = imagens.filter((m) => !m.imageUrl);
  for (const m of semImg) erros.push(`${m.id}: marcada como imagem mas sem URL.`);

  const checagens = await Promise.all(
    imagens.filter((m) => m.imageUrl).map(async (m) => {
      const r = await checarImagem(m.imageUrl);
      return { id: m.id, url: m.imageUrl, ...r };
    })
  );
  for (const c of checagens) {
    if (!c.ok) erros.push(`${c.id}: imagem inacessível (${c.motivo}) — ${c.url}`);
  }

  return {
    ok: erros.length === 0,
    erros,
    avisos,
    totalMensagens: mensagens.length,
    totalImagens: imagens.length,
  };
}
