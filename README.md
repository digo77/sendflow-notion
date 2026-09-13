# Sendflow-Notion Automação

Automação que lê agendamentos no Notion, pede confirmação via WhatsApp (Sendflow) e executa as ações aprovadas.

## 1. Instalação

```bash
git clone <url-do-repo>
cd sendflow-notion
npm install
cp .env.example .env
# Preencha os valores no .env
```

## 2. Verificação do .env antes de subir

Antes do primeiro start, rode:

```bash
node check-env.js
```

O script verifica:
- Todas as variáveis obrigatórias estão preenchidas
- Conexão com Notion (lista os bancos Agendamentos e Campanhas)
- Conexão com Sendflow (GET /sendapi/accounts autenticado)
- Se o SENDFLOW_ACCOUNT_ID existe e está conectado

Cada verificação imprime `[OK]` ou `[ERRO]` com detalhes.

## 3. Configuração do Cloudflare Tunnel

O app roda na porta definida em `WEBHOOK_PORT` (padrão `3001`). Para expor o webhook publicamente:

1. Acesse o painel **Cloudflare Zero Trust** → **Networks** → **Tunnels**
2. Selecione seu tunnel existente (ou crie um novo)
3. Adicione um **Public Hostname**:
   - **Subdomínio:** `sendflow`
   - **Domínio:** `pixelnrock.com`
   - **Tipo:** HTTP
   - **URL:** `localhost:3001`
4. No Sendflow, configure o webhook apontando para:
   ```
   https://sendflow.pixelnrock.com/webhook
   ```
5. Configure o header de autenticação no Sendflow:
   - Header: `X-Webhook-Secret`
   - Valor: o mesmo valor de `WEBHOOK_SECRET` no seu `.env`

Nenhuma porta precisa ser aberta no roteador.

## 4. API Sendflow — Endpoints utilizados

Base URL: `https://southamerica-east1-whatsapp-ultimate.cloudfunctions.net`
Auth: `Authorization: Bearer <SENDFLOW_API_TOKEN>`

| Método | Endpoint | Uso |
|--------|----------|-----|
| GET | `/sendapi/accounts` | Listar contas conectadas |
| GET | `/sendapi/releases` | Listar campanhas |
| POST | `/sendapi/send-text-message/{accountId}` | Enviar mensagem direta (confirmação) |
| POST | `/sendapi/actions/send-text-message` | Enviar mensagem para grupos da campanha |
| POST | `/sendapi/actions/send-image-message` | Enviar imagem para grupos da campanha |
| POST | `/sendapi/actions/send-video-message` | Enviar vídeo para grupos da campanha |
| PUT | `/sendapi/release-groups/{releaseGroupId}` | Renomear grupo |

Quando um agendamento do tipo `enviar_mensagem` tem o campo **Mídia (URL)** preenchido no Notion, a mídia (imagem ou vídeo, detectado pela extensão) é enviada primeiro, sem legenda, e o texto do **Parâmetro** vai como mensagem separada logo em seguida.

## 5. Configuração do n8n (workflow de sync de campanhas)

O n8n sincroniza campanhas do Sendflow para a tabela Campanhas no Notion. O Node.js não escreve nessa tabela — apenas lê.

### Passo a passo

1. **Schedule Trigger** — A cada 2 horas
2. **HTTP Request** — GET campanhas do Sendflow
   - URL: `https://southamerica-east1-whatsapp-ultimate.cloudfunctions.net/sendapi/releases`
   - Header: `Authorization: Bearer {{$env.SENDFLOW_API_TOKEN}}`
3. **Split In Batches** — Iterar sobre cada campanha
4. **Notion Query** — Buscar se já existe pelo ID Sendflow
   - Database: Campanhas
   - Filter: `ID Sendflow` equals `{{$json.id}}`
5. **IF** — Resultado tem items?
   - **True (Update):** Notion Update Page com dados atualizados
   - **False (Create):** Notion Create Page com dados novos
6. **Campos mapeados:**
   - Nome da Campanha ← `{{$json.name}}`
   - ID Sendflow ← `{{$json.id}}`
   - Instância ← `{{$json.accountIds[0]}}`
   - Status ← `{{$json.archived ? "encerrada" : "ativa"}}`
   - Última Sync ← `{{$now.toISO()}}`

### JSON do workflow para importar no n8n

Salve o conteúdo abaixo como `n8n-workflow.json` e importe em **Workflows → Import from File**:

```json
{
  "name": "Sync Campanhas Sendflow → Notion",
  "nodes": [
    {
      "parameters": {
        "rule": {
          "interval": [{ "field": "hours", "hoursInterval": 2 }]
        }
      },
      "name": "Schedule Trigger",
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [220, 300]
    },
    {
      "parameters": {
        "method": "GET",
        "url": "https://southamerica-east1-whatsapp-ultimate.cloudfunctions.net/sendapi/releases",
        "authentication": "genericCredentialType",
        "genericAuthType": "httpHeaderAuth",
        "sendHeaders": true,
        "headerParameters": {
          "parameters": [
            {
              "name": "Authorization",
              "value": "=Bearer {{$env.SENDFLOW_API_TOKEN}}"
            }
          ]
        },
        "options": {}
      },
      "name": "GET Campanhas",
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.2,
      "position": [440, 300]
    },
    {
      "parameters": {
        "batchSize": 1,
        "options": {}
      },
      "name": "Loop Campanhas",
      "type": "n8n-nodes-base.splitInBatches",
      "typeVersion": 3,
      "position": [660, 300]
    },
    {
      "parameters": {
        "resource": "databasePage",
        "operation": "getAll",
        "databaseId": "={{$env.NOTION_DATABASE_CAMPANHAS}}",
        "filterType": "formula",
        "filters": {
          "conditions": [
            {
              "key": "ID Sendflow|rich_text",
              "condition": "equals",
              "richTextValue": "={{$json.id}}"
            }
          ]
        },
        "returnAll": false,
        "limit": 1
      },
      "name": "Buscar no Notion",
      "type": "n8n-nodes-base.notion",
      "typeVersion": 2.2,
      "position": [880, 300]
    },
    {
      "parameters": {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "" },
          "conditions": [
            {
              "leftValue": "={{$json.results.length}}",
              "rightValue": 0,
              "operator": { "type": "number", "operation": "gt" }
            }
          ],
          "combinator": "and"
        },
        "options": {}
      },
      "name": "Já existe?",
      "type": "n8n-nodes-base.if",
      "typeVersion": 2,
      "position": [1100, 300]
    },
    {
      "parameters": {
        "resource": "databasePage",
        "operation": "update",
        "pageId": "={{$('Buscar no Notion').item.json.results[0].id}}",
        "propertiesUi": {
          "propertyValues": [
            {
              "key": "Nome da Campanha|title",
              "title": "={{$('Loop Campanhas').item.json.name}}"
            },
            {
              "key": "ID Sendflow|rich_text",
              "richTextValue": "={{$('Loop Campanhas').item.json.id}}"
            },
            {
              "key": "Instância|select",
              "selectValue": "={{$('Loop Campanhas').item.json.accountIds[0]}}"
            },
            {
              "key": "Status|select",
              "selectValue": "={{$('Loop Campanhas').item.json.archived ? 'encerrada' : 'ativa'}}"
            },
            {
              "key": "Última Sync|date",
              "date": "={{$now.toISO()}}"
            }
          ]
        }
      },
      "name": "Update Notion",
      "type": "n8n-nodes-base.notion",
      "typeVersion": 2.2,
      "position": [1320, 200]
    },
    {
      "parameters": {
        "resource": "databasePage",
        "operation": "create",
        "databaseId": "={{$env.NOTION_DATABASE_CAMPANHAS}}",
        "propertiesUi": {
          "propertyValues": [
            {
              "key": "Nome da Campanha|title",
              "title": "={{$('Loop Campanhas').item.json.name}}"
            },
            {
              "key": "ID Sendflow|rich_text",
              "richTextValue": "={{$('Loop Campanhas').item.json.id}}"
            },
            {
              "key": "Instância|select",
              "selectValue": "={{$('Loop Campanhas').item.json.accountIds[0]}}"
            },
            {
              "key": "Status|select",
              "selectValue": "={{$('Loop Campanhas').item.json.archived ? 'encerrada' : 'ativa'}}"
            },
            {
              "key": "Última Sync|date",
              "date": "={{$now.toISO()}}"
            }
          ]
        }
      },
      "name": "Create Notion",
      "type": "n8n-nodes-base.notion",
      "typeVersion": 2.2,
      "position": [1320, 400]
    }
  ],
  "connections": {
    "Schedule Trigger": {
      "main": [[{ "node": "GET Campanhas", "type": "main", "index": 0 }]]
    },
    "GET Campanhas": {
      "main": [[{ "node": "Loop Campanhas", "type": "main", "index": 0 }]]
    },
    "Loop Campanhas": {
      "main": [
        [{ "node": "Buscar no Notion", "type": "main", "index": 0 }],
        []
      ]
    },
    "Buscar no Notion": {
      "main": [[{ "node": "Já existe?", "type": "main", "index": 0 }]]
    },
    "Já existe?": {
      "main": [
        [{ "node": "Update Notion", "type": "main", "index": 0 }],
        [{ "node": "Create Notion", "type": "main", "index": 0 }]
      ]
    },
    "Update Notion": {
      "main": [[{ "node": "Loop Campanhas", "type": "main", "index": 0 }]]
    },
    "Create Notion": {
      "main": [[{ "node": "Loop Campanhas", "type": "main", "index": 0 }]]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}
```

## 6. Como fazer backup manual

```bash
node -e "import('./backup.js').then(m => m.runBackup())"
```

Ou via npm:

```bash
npm run backup
```

- Backups ficam em `backups/` com timestamp no nome (ex: `execucoes_2026-03-18_14-30.json`)
- Os últimos 30 são mantidos automaticamente, os mais antigos são apagados
- Backup automático roda todo dia à meia-noite via cron

## 7. Iniciar o app

### Desenvolvimento

```bash
node index.js
```

### Produção (PM2)

```bash
pm2 start index.js --name sendflow-notion
pm2 save
pm2 startup  # Para iniciar automaticamente no boot
```

### Endpoints

| Rota | Método | Descrição |
|------|--------|-----------|
| `/webhook` | POST | Recebe respostas do Sendflow (requer `X-Webhook-Secret`) |
| `/health` | GET | Health check (retorna status e uptime) |

## Fluxo de execução

```
Cron (5min) → Busca pendentes no Notion → Envia confirmação WhatsApp
                                                    ↓
                                          Usuário responde SIM/NAO
                                                    ↓
Webhook ← Sendflow → Executa ação → Atualiza Notion
```

### Status dos agendamentos

| Status | Descrição |
|--------|-----------|
| `pendente` | Aguardando processamento pelo cron |
| `aguardando_ok` | Confirmação enviada, aguardando resposta |
| `executado` | Ação executada com sucesso |
| `cancelado` | Cancelado pelo usuário ou expirado (60min) |
| `erro` | Falha na execução |

## 8. Tráfego — otimização autônoma de Meta Ads

Módulo em `trafego/`. Roda dentro deste app, sem n8n. Lê métricas do Meta, cruza com o funil real
(leads da pesquisa, entrada nos grupos, compras) e decide o que matar, escalar, ajustar ou observar.

### O que faz

| Quando | O quê |
|---|---|
| A cada hora (`:07`) | Puxa insights por anúncio (7 dias + 7 anteriores), budget e fase de aprendizado dos conjuntos, cruza com leads/compras por anúncio, aplica as regras de `trafego/metas.json`, envia leads qualificados e compras para a Conversions API, executa ações autônomas (só fora do modo sombra). |
| Todo dia às 08:00 (SP) | Cérebro (Claude) lê os vereditos e manda no seu WhatsApp o resumo em dinheiro (quanto queima, quanto deixa na mesa), até 3 ações do dia e propostas de anúncios novos. Cada ação que precisa de aprovação chega como pergunta: responda `SIM T1A2B` ou `NAO T1A2B`. |

### Metas (edite `trafego/metas.json`)

- **Lançamento:** CPL alvo R$3, CPL qualificado alvo R$6, lead é qualificado com score ≥ 60 pela pesquisa.
- **Perpétuo:** ROAS mínimo 1.8, escala a partir de 2.0 (forte a partir de 2.5, duplicando o conjunto).
- **Guardrails:** degraus de 30% (50% em escala forte), 48h entre escalas, máx. 3 pausas/dia por conta, nunca mexe em conjunto em aprendizado. `modo_sombra: true` no início: nada é executado sem `SIM`.
- **Clientes:** um bloco por conta em `clientes`, com `meta_ad_account_id` (`act_...`), `tipo` (`lancamento`|`perpetuo`), `ticket_medio`, `ativo: true`.

Criar anúncio novo **sempre** pede aprovação e o anúncio nasce pausado.

### Etiqueta por anúncio (obrigatório)

Todos os anúncios usam a mesma URL com o parâmetro dinâmico do Meta: `utm_content={{ad.id}}`.
A página de captação manda o lead para cá com esse valor. Sem isso não há atribuição.

### Endpoints públicos (protegidos por `TRAFEGO_WEBHOOK_SECRET`, header `x-trafego-secret` ou `?secret=`)

```
POST /api/trafego/lead      { telefone, nome, email, utm_content|ad_id, fbclid, fbp, cliente, respostas? }
POST /api/trafego/pesquisa  { telefone|email, respostas: { renda: "...", momento: "...", ... } }
POST /api/trafego/evento    { telefone|email, evento: entrou_no_grupo|ficou_24h|clicou_link|compareceu_aula|saiu_do_grupo }
POST /api/trafego/compra    payload da Hotmart (v2) ou { telefone, email, valor, ad_id|sck }
```

As perguntas e pesos da pesquisa ficam em `metas.json` → `pesquisa`. Ajuste as chaves para bater com o formulário real.

### Endpoints do painel (autenticados)

```
GET  /api/trafego/estado          estado, vereditos da última análise, pendentes, log
GET  /api/trafego/leads           resumo e últimos leads
POST /api/trafego/ciclo           roda o ciclo horário agora
POST /api/trafego/relatorio       roda o cérebro e o resumo agora ({ "enviar": false } só devolve)
POST /api/trafego/capi            reenvia eventos pendentes à Conversions API
POST /api/trafego/aprovar/:id     { "acao": "sim" | "nao" }
POST /api/trafego/pausa-geral     { "pausar": true | false }
GET  /api/trafego/testar-meta     valida o token e lista as contas
```

### Env

`META_ACCESS_TOKEN`, `META_PIXEL_ID`, `ANTHROPIC_API_KEY`, `TRAFEGO_DRY_RUN=1` (recomendado na primeira semana), `TRAFEGO_WEBHOOK_SECRET`, `TRAFEGO_HORA_RELATORIO`.

### Ordem de ativação

1. `npm test` verde. Configure o token do Meta e rode `GET /api/trafego/testar-meta`.
2. Preencha `clientes` em `metas.json`. Deixe `modo_sombra: true` e `TRAFEGO_DRY_RUN=1`.
3. Coloque `utm_content={{ad.id}}` nos anúncios novos e aponte a página de captação e a pesquisa para os endpoints acima.
4. Uma semana lendo o resumo diário. Quando confiar, `modo_sombra: false` e `TRAFEGO_DRY_RUN=0`: pausar anúncio sem resultado passa a ser automático; o resto continua pedindo `SIM`.
