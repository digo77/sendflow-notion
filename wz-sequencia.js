/**
 * wz-sequencia.js
 * Lógica de agendamento da sequência de aquecimento WhatsApp (WZ1-WZ14)
 * para o produto Cookie Sandwich – Chef Áureo Magalhães.
 *
 * Todas as horas são em Brasília (UTC-3).
 */
import { agendarMensagemTexto, agendarMensagemImagem } from './sendflow.js';

const IK = 'https://ik.imagekit.io/pixelnrock';

// ─── Definição da sequência ──────────────────────────────────────────────────
// offset: dias em relação ao dia do webinário (0 = terça do webinário, -1 = segunda, etc.)
// hora/min: horário em Brasília

export const WZ_SEQUENCIA = [
  {
    id: 'WZ2',
    label: 'Carrossel · Lucrar com cookie',
    tipo: 'imagem',
    offset: -3, hora: 10, min: 0, // sábado 10h
    imageUrl: `${IK}/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-03-mh3ou.jpg`,
    mensagem:
`*QUANDO ME PERGUNTAM SE DÁ PRA LUCRAR COM COOKIE...* 🍪🔥

Eu poderia responder em uma palavra.

Mas prefiro mostrar. 👀

Fiz um carrossel com tudo que você precisa saber sobre lucrar de verdade com cookie, sem ilusão e sem enrolação.

_Aperta aqui e me conta o que achou._ 😍

👇🏻 *Aperta aqui:*
https://www.instagram.com/p/DWka-PgDSJW/`,
  },
  {
    id: 'WZ8',
    label: 'Domingo · O que você vai aprender',
    tipo: 'imagem',
    offset: -2, hora: 9, min: 0, // domingo 09h
    imageUrl: `${IK}/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-01-6e3jq.jpg`,
    mensagem:
`*TERÇA-FEIRA TEM AULÃO AO VIVO.* 🔥😍

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
    id: 'WZ3',
    label: 'Carrossel · Mentiras sobre cookies',
    tipo: 'imagem',
    offset: -2, hora: 10, min: 0, // domingo 10h
    imageUrl: `${IK}/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-04-zpb08.jpg`,
    mensagem:
`*A maioria das confeiteiras sabe FAZER um bom cookie.* 🍪🔥

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
    label: 'Carrossel · Como começar',
    tipo: 'imagem',
    offset: -1, hora: 8, min: 0, // segunda 08h
    imageUrl: `${IK}/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-05-ve7v5.jpg`,
    mensagem:
`*Você trabalha o dia inteiro na cozinha e no final do mês o dinheiro some.* 😔

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
    label: 'Prova Social · Aluna da faculdade',
    tipo: 'imagem',
    offset: -1, hora: 10, min: 0, // segunda 10h
    imageUrl: `${IK}/chefaureo/depoimentos/depoimento-chef-aureo-06-ik8ho.jpg`,
    mensagem:
`*Ela levou 20 cookies pra faculdade.* 🍪

Vendeu TUDO na primeira aula.

Na segunda semana, já tinha fila. Pessoas de outros cursos pedindo pelo WhatsApp. Encomendas pra semana toda.

_Sem loja. Sem delivery. Sem nada sofisticado._

Só um cookie BOM, feito com técnica. 🔥😍

*Isso é o que acontece quando o produto certo encontra o método certo.*

Na terça a gente te mostra como chegar lá. 👊🏻`,
  },
  {
    id: 'WZ6',
    label: 'Carrossel · Quanto custa 1 cookie?',
    tipo: 'imagem',
    offset: -1, hora: 12, min: 0, // segunda 12h
    imageUrl: `${IK}/tr:w-1000,q-80,f-jpg/chefaureo/cookie-sandwich/carrossel-02-pwd31.jpg`,
    mensagem:
`*VOCÊ SABE QUANTO CUSTA FAZER 1 COOKIE?* 🍪👀

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
    label: 'Prova Social · Eduarda',
    tipo: 'imagem',
    offset: -1, hora: 14, min: 0, // segunda 14h
    imageUrl: `${IK}/chefaureo/depoimentos/depoimento-chef-aureo-011-d5qug.jpg`,
    mensagem:
`*ELA DEIXOU O EMPREGO DE CONTADORA PRA CUIDAR DA FILHA.* 🤍

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
  {
    id: 'WZ9',
    label: 'Segunda · Spoiler + Cookie Dubai',
    tipo: 'imagem',
    offset: -1, hora: 16, min: 0, // segunda 16h
    imageUrl: `${IK}/tr:w-600,q-80,f-jpg/chefaureo/cookie-dubai-01-21fto.jpg`,
    mensagem:
`*AMANHÃ TEM AULÃO E EU PRECISO TE CONTAR UMA COISA.* 🍪🔥

_Isso é só o começo do que o Chef vai te mostrar._

Amanhã você aprende o *Cookie Sandwich* ao vivo: massa, recheio, montagem e apresentação. 😍

Mas depois da aula, o Chef vai te mostrar o que mais existe nesse universo...

*Produtos que NINGUÉM na sua cidade tem.* 👀🔥

_Amanhã você vai ver até onde isso pode chegar._

📅 *Terça-feira, 20h. Aparece.* 👊🏻`,
  },
  {
    id: 'WZ10',
    label: 'Segunda 20h · Entrega do PDF',
    tipo: 'texto',
    offset: -1, hora: 20, min: 0, // segunda 20h
    mensagem:
`*SEU PDF CHEGOU.* 🎁🍪

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
    label: 'Terça 10h · Hoje é o dia',
    tipo: 'texto',
    offset: 0, hora: 10, min: 0,
    mensagem:
`*HOJE É O DIA.* 🔥🍪

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
    label: 'Terça 14h · Prova Social + Urgência',
    tipo: 'texto',
    offset: 0, hora: 14, min: 0,
    mensagem:
`*HOJE À NOITE TEM AULA. MAS ANTES...* 👀🍪

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
    label: 'Terça 19h · Falta 1 hora',
    tipo: 'texto',
    offset: 0, hora: 19, min: 0,
    mensagem:
`*FALTA 1 HORA.* ⏳🔥

O Chef Áureo entra ao vivo às 20h pra te ensinar o *Cookie Sandwich* do zero.

_E lembra: a aula NÃO tem gravação._ ⚠️

*Quem estiver lá vai ter acesso a algo que não vai rolar de novo.*

Prepara o caderno. Prepara a cozinha. *APARECE.* 👊🏻🍪`,
  },
  {
    id: 'WZ14',
    label: 'Terça 20h · Abertura ao vivo',
    tipo: 'texto',
    offset: 0, hora: 20, min: 0,
    mensagem:
`🛑 *ESTAMOS AO VIVO AGORA*

Vem aprender o *Cookie da Disney* em detalhes com o Chef Áureo. *CORRE.* 🔥😍

👇🏻 *Entra aqui:*
https://link.chefaureomagalhaes.com/sandwich-live`,
  },
];

// ─── Calcula horário UTC a partir de data local Brasília ─────────────────────
// dataWebinario: "YYYY-MM-DD" (dia do webinário, terça-feira)
function scheduledTo(dataWebinario, offsetDias, hora, min) {
  const [y, m, d] = dataWebinario.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d + offsetDias, hora + 3, min));
  return base.toISOString();
}

// ─── Preview (sem agendar) ───────────────────────────────────────────────────
export function wzPreview(dataWebinario) {
  return WZ_SEQUENCIA.map((wz) => {
    const at = scheduledTo(dataWebinario, wz.offset, wz.hora, wz.min);
    const horaLocal = new Date(at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
    return {
      id: wz.id,
      label: wz.label,
      tipo: wz.tipo,
      scheduledTo: at,
      horaLocal,
    };
  });
}

// ─── Agendar toda a sequência ────────────────────────────────────────────────
export async function agendarSequenciaWZ({ releaseId, accountId, dataWebinario }) {
  const resultados = [];

  for (const wz of WZ_SEQUENCIA) {
    const at = scheduledTo(dataWebinario, wz.offset, wz.hora, wz.min);
    try {
      let res;
      if (wz.tipo === 'imagem') {
        res = await agendarMensagemImagem({
          releaseId,
          accountId,
          imageUrl: wz.imageUrl,
          caption: wz.mensagem,
          scheduledTo: at,
          shippingSpeed: 'none',
        });
      } else {
        res = await agendarMensagemTexto({
          releaseId,
          accountId,
          mensagem: wz.mensagem,
          scheduledTo: at,
          shippingSpeed: 'none',
        });
      }
      resultados.push({ id: wz.id, ok: true, actionId: res.data?.actionId, scheduledTo: at });
    } catch (err) {
      const erro = err.response
        ? `HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`
        : err.message;
      resultados.push({ id: wz.id, ok: false, erro, scheduledTo: at });
    }

    // Pausa entre requisições
    await new Promise((r) => setTimeout(r, 400));
  }

  return resultados;
}
