/**
 * Agenda toda a sequência WZ (aquecimento) no Sendflow.
 * Aparece na aba "Agendado" da campanha selecionada.
 *
 * Uso: node agendar-wz-campanha.js
 *
 * Imagens: O Sendflow exige extensão no path da URL (.jpg/.png).
 * As imagens do ImageKit (sem extensão) são servidas via proxy no próprio
 * servidor: https://<CLOUDFLARE_TUNNEL_DOMAIN>/img/<nome>.jpg?src=<url-encoded>
 */
import 'dotenv/config';
import { agendarMensagemTexto, agendarMensagemImagem } from './sendflow.js';

// ─── Configuração da campanha ───────────────────────────────────────────────
const RELEASE_ID  = '4eGjwrl02ThSiFSVBmFs'; // Cookie Sandwich • Aula 21.04 às 19h
const ACCOUNT_ID  = 'D9ceM3x1pGXTMTH5cDgW';
// Arquivos renomeados no ImageKit com .jpg — URLs diretas funcionam sem proxy.

// ─── Horários (UTC — Brasília é UTC-3) ─────────────────────────────────────
// Webinário: terça 21/04/2026 às 20h Brasília
// WZ1 já foi agendado: 17/04 às 10h Brasília (13h UTC) ✓

const mensagens = [
  // ── Fase Dinâmica ─────────────────────────────────────────────────────────
  {
    id: 'WZ2',
    tipo: 'imagem',
    scheduledTo: '2026-04-18T13:00:00.000Z', // sáb 18/04 10h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-03-mh3ou.jpg',
    mensagem: `*QUANDO ME PERGUNTAM SE DÁ PRA LUCRAR COM COOKIE...* 🍪🔥

Eu poderia responder em uma palavra.

Mas prefiro mostrar. 👀

Fiz um carrossel com tudo que você precisa saber sobre lucrar de verdade com cookie, sem ilusão e sem enrolação.

_Aperta aqui e me conta o que achou._ 😍

👇🏻 *Aperta aqui:*
https://www.instagram.com/p/DWka-PgDSJW/`,
  },
  {
    id: 'WZ3',
    tipo: 'imagem',
    scheduledTo: '2026-04-19T13:00:00.000Z', // dom 19/04 10h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-04-zpb08.jpg',
    mensagem: `*A maioria das confeiteiras sabe FAZER um bom cookie.* 🍪🔥

O problema não é a receita.

É que ninguém ensinou como *transformar cookie em VENDA.*

Divulgação, precificação, apresentação... tudo isso parece complicado quando você tá sozinha tentando descobrir.

Mas sabe o que muda tudo? *Escolher o produto certo pra começar.* 👀

Cookie tem menor custo, menor tempo de produção e *MAIOR MARGEM* do que quase tudo na confeitaria. 📈😍

_E na nossa aula de terça você vai entender exatamente por quê._

👇🏻 *Clica aqui:*
https://www.instagram.com/p/DWm3HeljYZL/`,
  },
  {
    id: 'WZ4',
    tipo: 'imagem',
    scheduledTo: '2026-04-20T11:00:00.000Z', // seg 20/04 08h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-05-ve7v5.jpg',
    mensagem: `*Você trabalha o dia inteiro na cozinha e no final do mês o dinheiro some.* 😔

Isso tem nome: *produzir muito e precificar ERRADO.*

É o erro mais comum entre confeiteiras. E o mais silencioso.

Você não percebe porque a encomenda entrou, o cliente pagou, o dinheiro chegou.

_Mas quando você para pra calcular de verdade... sobrou quase nada._ 😳

O problema não é você trabalhar pouco.

É que *ninguém te ensinou a cobrar o que o seu produto VALE.*

Cookie bem feito, com técnica e apresentação certa, não compete por preço.

*Ele compete por DESEJO.* 🔥😍

👇🏻 *Aperta aqui:*
https://www.instagram.com/p/DW4uPHWltaL/`,
  },
  {
    id: 'WZ5',
    tipo: 'imagem',
    scheduledTo: '2026-04-20T13:00:00.000Z', // seg 20/04 10h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/chefaureo/depoimentos/depoimento-chef-aureo-06-ik8ho.jpg',
    mensagem: `*Ela levou 20 cookies pra faculdade.* 🍪

Vendeu TUDO na primeira aula.

Na segunda semana, já tinha fila. Pessoas de outros cursos pedindo pelo WhatsApp. Encomendas pra semana toda.

_Sem loja. Sem delivery. Sem nada sofisticado._

Só um cookie BOM, feito com técnica. 🔥😍

*Isso é o que acontece quando o produto certo encontra o método certo.*

Na terça a gente te mostra como chegar lá. 👊🏻`,
  },
  {
    id: 'WZ6',
    tipo: 'imagem',
    scheduledTo: '2026-04-20T15:00:00.000Z', // seg 20/04 12h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-02-pwd31.jpg',
    mensagem: `*VOCÊ SABE QUANTO CUSTA FAZER 1 COOKIE?* 🍪👀

A maioria das confeiteiras chuta. E esse chute custa CARO.

Vamos fazer uma conta rápida:

🔸 Ingredientes: R$ 2,50
🔸 Embalagem: R$ 0,80
🔸 Gás + luz: R$ 0,40
🔸 Seu tempo: R$ ???

*A maioria cobra R$ 5,00 e acha que tá lucrando.* 😳

Mas quando coloca o tempo na conta, o lucro real é menos de R$ 1,00 por cookie.

_Numa fornada de 20 unidades: R$ 20,00. Sendo que dá pra fazer em menos de 1 hora._

Agora imagina o mesmo cookie, com *apresentação certa e técnica certa*, vendido a *R$ 15,00 a R$ 18,00*. 📈😍

*Mesma fornada. Até R$ 360,00.*

A diferença não é trabalhar mais.

É saber o que o seu cookie VALE de verdade. 🔥

👇🏻 *Clica aqui:*
https://www.instagram.com/reel/DSV9CqbDQD-/`,
  },
  {
    id: 'WZ7',
    tipo: 'imagem',
    scheduledTo: '2026-04-20T17:00:00.000Z', // seg 20/04 14h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/chefaureo/depoimentos/depoimento-chef-aureo-011-d5qug.jpg',
    mensagem: `*ELA DEIXOU O EMPREGO DE CONTADORA PRA CUIDAR DA FILHA.* 🤍

Não foi fácil. A renda sumiu. A rotina virou de cabeça pra baixo.

Foi aí que ela começou a fazer cookies.

_Sem experiência. Sem curso caro. Sem saber se ia dar certo._

Na primeira vez que ofereceu, as pessoas *AMARAM.* 😍🔥

Não foi sorte.

Foi o produto certo, feito do jeito certo.

*Cookie não precisa de loja, de delivery sofisticado ou de anos de experiência.*

Precisa de técnica, de método e de coragem pra começar. 👊🏻

_A Eduarda teve os três. E deu certo._

Na terça a gente te mostra o caminho. 🍪

Até lá.`,
  },

  // ── Fase Fixa (todos recebem junto) ──────────────────────────────────────
  {
    id: 'WZ8',
    tipo: 'imagem',
    scheduledTo: '2026-04-19T12:00:00.000Z', // dom 19/04 09h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-01-6e3jq.jpg',
    mensagem: `*TERÇA-FEIRA TEM AULÃO AO VIVO.* 🔥😍

E antes de chegar lá, deixa eu te contar o que você vai sair sabendo depois dessa aula.

🍪 *A massa do Cookie Sandwich do zero: textura, ponto e segredo do Chef*
🍫 *O recheio que faz o cliente fechar o olho na primeira mordida*
🏗️ *Montagem na prática: como fazer bonito E rápido*
✨ *Apresentação que justifica cobrar entre R$ 15,00 e R$ 18,00 por unidade*

_Tudo isso ao vivo, com o Chef Áureo._

Não é teoria. Não é enrolação.

*É o que funciona de verdade pra quem quer viver de confeitaria.* 👊🏻

📅 *Terça-feira, 20h. Salva na agenda agora.*

👇🏻 *Aperta aqui:*
https://www.instagram.com/reel/DSBOOkJDYlR/`,
  },
  {
    id: 'WZ9',
    tipo: 'imagem',
    scheduledTo: '2026-04-20T19:00:00.000Z', // seg 20/04 16h Brasília
    imageUrl: 'https://ik.imagekit.io/pixelnrock/tr:w-600,q-80,f-jpg/chefaureo/cookie-dubai-01-21fto.jpg',
    mensagem: `*AMANHÃ TEM AULÃO E EU PRECISO TE CONTAR UMA COISA.* 🍪🔥

_Isso é só o começo do que o Chef vai te mostrar._

Amanhã você aprende o *Cookie Sandwich* ao vivo: massa, recheio, montagem e apresentação. 😍

Mas depois da aula, o Chef vai te mostrar o que mais existe nesse universo...

*Produtos que NINGUÉM na sua cidade tem.* 👀🔥

_Amanhã você vai ver até onde isso pode chegar._

📅 *Terça-feira, 20h. Aparece.* 👊🏻`,
  },
  {
    id: 'WZ10',
    tipo: 'texto',
    scheduledTo: '2026-04-20T23:00:00.000Z', // seg 20/04 20h Brasília
    mensagem: `*SEU PDF CHEGOU.* 🎁🍪

O Chef Áureo liberou a receita completa do *Cookie Sandwich* pra você chegar preparada na aula de amanhã.

_Dá uma olhada nos ingredientes hoje à noite._

Amanhã ao vivo ele explica cada detalhe, cada segredo, cada técnica por trás dessa receita. 🔥😍

*Quem chega preparada aproveita muito mais.*

👇🏻 *Acessa seu PDF aqui:*
https://link.chefaureomagalhaes.com/sandwich-pdf

📅 *Amanhã, 20h. Te vejo lá.* 👊🏻`,
  },
  {
    id: 'WZ11',
    tipo: 'texto',
    scheduledTo: '2026-04-21T13:00:00.000Z', // ter 21/04 10h Brasília
    mensagem: `*HOJE É O DIA.* 🔥🍪

Hoje à noite, 20h, o Chef Áureo vai ao vivo pra te ensinar o *Cookie Sandwich* do zero.

_Se você ainda não olhou o PDF que chegou ontem, esse é o momento._ 👀

👇🏻 *Acessa aqui:*
https://link.chefaureomagalhaes.com/sandwich-pdf

Separa os ingredientes, prepara o caderno e *APARECE.*

Quem estiver ao vivo vai ter uma surpresa especial depois da aula. 😍🔥

📅 *Hoje, 20h. A gente se vê lá.* 👊🏻`,
  },
  {
    id: 'WZ12',
    tipo: 'texto',
    scheduledTo: '2026-04-21T17:00:00.000Z', // ter 21/04 14h Brasília
    mensagem: `*HOJE À NOITE TEM AULA. MAS ANTES...* 👀🍪

_"Comecei vendendo só pra minha sala. Assei 20 e levei. Na segunda aula já tinha vendido tudo e ainda teve briga por quem ficava com as últimas unidades."_

Isso foi com UM produto.

*Imagina com os 9 produtos que o Chef vai te dar a oportunidade de conhecer hoje ao vivo.* 🔥😍

⚠️ *A aula NÃO tem gravação.*

_Quem não aparecer hoje não vai conseguir assistir depois._

*Vale estar lá até o final.* 👊🏻

📅 *Hoje, 20h. Aparece.*`,
  },
  {
    id: 'WZ13',
    tipo: 'texto',
    scheduledTo: '2026-04-21T22:00:00.000Z', // ter 21/04 19h Brasília
    mensagem: `*FALTA 1 HORA.* ⏳🔥

O Chef Áureo entra ao vivo às 20h pra te ensinar o *Cookie Sandwich* do zero.

_E lembra: a aula NÃO tem gravação._ ⚠️

*Quem estiver lá vai ter acesso a algo que não vai rolar de novo.*

Prepara o caderno. Prepara a cozinha. *APARECE.* 👊🏻🍪`,
  },
  {
    id: 'WZ14',
    tipo: 'texto',
    scheduledTo: '2026-04-21T23:00:00.000Z', // ter 21/04 20h Brasília
    mensagem: `🛑 *ESTAMOS AO VIVO AGORA*

Vem aprender o *Cookie da Disney* em detalhes com o Chef Áureo. *CORRE.* 🔥😍

👇🏻 *Entra aqui:*
https://link.chefaureomagalhaes.com/sandwich-live`,
  },
];

// ─── Execução ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n🗓️  Agendando ${mensagens.length} mensagens WZ no Sendflow`);
  console.log(`   Campanha: ${RELEASE_ID}`);
  console.log(`   Conta:    ${ACCOUNT_ID}`);
  console.log(`   Proxy:    https://${DOMAIN}/img/\n`);

  const resultados = [];

  for (const m of mensagens) {
    const hora = new Date(m.scheduledTo).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    process.stdout.write(`⏳ ${m.id} [${hora}]... `);

    try {
      let res;
      if (m.tipo === 'imagem') {
        res = await agendarMensagemImagem({
          releaseId: RELEASE_ID,
          accountId: ACCOUNT_ID,
          imageUrl: m.imageUrl,
          caption: m.mensagem,
          scheduledTo: m.scheduledTo,
          shippingSpeed: 'none',
        });
      } else {
        res = await agendarMensagemTexto({
          releaseId: RELEASE_ID,
          accountId: ACCOUNT_ID,
          mensagem: m.mensagem,
          scheduledTo: m.scheduledTo,
          shippingSpeed: 'none',
        });
      }
      console.log(`✅ actionId: ${res.data?.actionId || JSON.stringify(res.data)}`);
      resultados.push({ id: m.id, ok: true });
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data)}`
        : err.message;
      console.log(`❌ ${msg}`);
      resultados.push({ id: m.id, ok: false, erro: msg });
    }

    // Pequena pausa entre requisições
    await new Promise(r => setTimeout(r, 500));
  }

  const ok = resultados.filter(r => r.ok).length;
  const falhou = resultados.filter(r => !r.ok);

  console.log(`\n─────────────────────────────────────────`);
  console.log(`✅ ${ok}/${mensagens.length} mensagens agendadas com sucesso`);
  if (falhou.length) {
    console.log(`❌ Falhas: ${falhou.map(r => r.id).join(', ')}`);
  }
  console.log(`\n👉 Sendflow → Campanha → Ações → "Agendado"\n`);
}

main().catch(err => {
  console.error('Erro fatal:', err.message);
  process.exit(1);
});
