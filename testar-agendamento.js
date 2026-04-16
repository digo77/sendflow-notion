/**
 * Script de teste: agenda a mensagem WZ1 diretamente no Sendflow.
 * Aparece na aba "Agendado" da campanha Cookie Sandwich • Aula 21.04 às 19h.
 *
 * Uso: node testar-agendamento.js
 */
import 'dotenv/config';
import { agendarMensagemTexto } from './sendflow.js';

const RELEASE_ID  = '4eGjwrl02ThSiFSVBmFs'; // Cookie Sandwich • Aula 21.04 às 19h
const ACCOUNT_ID  = 'D9ceM3x1pGXTMTH5cDgW'; // Instância conectada

// WZ1 · D+0 · Boas-vindas (scheduledTo: 17/04 às 10h Brasília = 13h UTC)
const MENSAGEM_WZ1 = `*Bem-vinda(o) ao Aulão do Cookie Sandwich* 🍪

Sua vaga está CONFIRMADA para a aula ao vivo de terça, às 20h.

Enquanto isso, entra no grupo abaixo. É lá que o Chef Áureo vai te mandar conteúdo, bastidores e tudo que você precisa antes da aula.

👇🏻 *Acessa o grupo aqui:*
https://link.chefaureomagalhaes.com/webinar-sandwich

Te vejo na terça. Vai ser bom.`;

const SCHEDULED_TO = '2026-04-17T13:00:00.000Z'; // 10h Brasília (UTC-3)

async function main() {
  console.log('🚀 Agendando WZ1 no Sendflow...');
  console.log(`   Campanha: ${RELEASE_ID}`);
  console.log(`   Conta:    ${ACCOUNT_ID}`);
  console.log(`   Horário:  ${SCHEDULED_TO} (10h Brasília)`);
  console.log('');

  try {
    const resultado = await agendarMensagemTexto({
      releaseId:     RELEASE_ID,
      accountId:     ACCOUNT_ID,
      mensagem:      MENSAGEM_WZ1,
      scheduledTo:   SCHEDULED_TO,
      shippingSpeed: 'none',
    });

    console.log(`✅ Agendado com sucesso!`);
    console.log(`   Status HTTP: ${resultado.status}`);
    console.log(`   Resposta:`, JSON.stringify(resultado.data, null, 2));
    console.log('');
    console.log('👉 Verifique no Sendflow: Campanha → Ações → aba "Agendado"');
  } catch (err) {
    const msg = err.response
      ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`
      : err.message;
    console.error('❌ Erro:', msg);
  }
}

main();
