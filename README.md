# Finanças do Casal (SaaS)

Controle financeiro para casais e famílias: entradas, saídas, contas a pagar, investimentos,
gráficos e resumo para o WhatsApp. Cada conta tem seus dados isolados, cadastro com e-mail e
senha, e acesso liberado por pagamento no Mercado Pago (Pix ou cartão).

Front-end em HTML/JS puro + funções serverless da Vercel + Postgres (Neon).

## Novidades (setembro/2026)

- **Tema claro, escuro ou automático** (botão no topo e em Mais, no celular); a escolha fica salva no aparelho.
- **Página de vendas** (visual escuro, com prévia animada do app) para quem não está logado (recursos, planos, dúvidas) e imagem de prévia do link (`og.png`).
- **Teste grátis**: padrão para todo cadastro (Admin → Teste grátis) e **links de campanha** `/?convite=CODIGO` com dias próprios.
- **Avisos no sistema**: sininho com contas vencidas/vencendo, orçamento estourando e fim do plano; faixa quando o plano/teste está acabando.
- **Avisos no celular** (Web Push): o cliente ativa em Conta; rotina diária às 8h (`/api/cron`, em `vercel.json`). As chaves são geradas e guardadas no banco sozinhas. Opcional: `CRON_SECRET` na Vercel para proteger a rotina.
- **App instalável** (PWA): `manifest.webmanifest`, `sw.js` e ícones em `/icons`.
- **Forma de pagamento** em cada lançamento: Pix, cartão de crédito, cartão de débito, dinheiro ou boleto (o app lembra a última usada). Aparece na lista, no filtro, na planilha e ao pagar uma conta.
- **Parcelas** (no cartão de crédito): compra em até 48x gera uma saída por mês.
- **Orçamento por categoria** com avisos em 80% e ao estourar.
- **Exportar** o mês em planilha (CSV para Excel) e relatório para PDF.
- **Importar extrato** OFX/CSV (bancos, Nubank) com categorias sugeridas e sem duplicar.
- **Assinatura automática** no cartão (Mercado Pago preapproval), com cancelamento na aba Conta. A 1ª cobrança só acontece quando o acesso atual termina.
- **Termos de Uso** e **Política de Privacidade** (`termos.html`, `privacidade.html`), aceite obrigatório no cadastro. Preencha os campos entre colchetes com seus dados.

## Estrutura

```
index.html              # tela de entrada/cadastro, planos, app e aba Conta
api/auth.js             # sessão, login, cadastro, pessoas da conta, troca de senha
api/data.js             # lançamentos, contas a pagar, investimentos (sempre filtrado pela conta)
api/billing.js          # planos, criação do checkout e confirmação no retorno
api/mp-webhook.js       # notificações do Mercado Pago
api/_lib/db.js          # conexão Neon; cria/migra as tabelas sozinho
api/_lib/auth.js        # cookie de sessão assinado
api/_lib/password.js    # hash de senha (scrypt)
api/_lib/billing.js     # integração Mercado Pago e regra de liberação do acesso
```

## Variáveis de ambiente (Vercel → Settings → Environment Variables)

| Variável | Obrigatória | O que é |
|---|---|---|
| `DATABASE_URL` | sim | Criada sozinha ao conectar o Neon em Storage |
| `SESSION_SECRET` | sim | Texto longo e aleatório. Trocar desloga todo mundo |
| `MP_ACCESS_TOKEN` | sim, para cobrar | Access Token de **produção** do Mercado Pago |
| `PRICE_MENSAL` | não | Preço do plano mensal (padrão `19.90`) |
| `PRICE_ANUAL` | não | Preço do plano anual (padrão `149.90`) |
| `MP_WEBHOOK_SECRET` | não | Assinatura secreta do webhook (camada extra de segurança) |
| `APP_URL` | não | Domínio próprio, ex. `https://financasdocasal.com.br` |
| `ADMIN_EMAILS` | não | E-mails com acesso à aba **Admin**, separados por vírgula |
| `RESEND_API_KEY` | não | Chave do resend.com para o "Esqueci minha senha" por e-mail |
| `MAIL_FROM` | não | Remetente, ex. `Finanças do Casal <nao-responda@seudominio.com.br>` |
| `USERS` | não | Só para a migração da conta antiga (`nome:senha;nome:senha`) |

Depois de mudar variáveis, faça **Redeploy**.

## Mercado Pago

1. Em mercadopago.com.br/developers → **Suas integrações → Criar aplicação**
   (tipo: pagamentos online / Checkout Pro).
2. Em **Credenciais de produção**, copie o **Access Token** para `MP_ACCESS_TOKEN`.
3. (Opcional) Em **Webhooks**, cadastre `https://SEU-DOMINIO/api/mp-webhook` com o evento
   **Pagamentos** e copie a assinatura secreta para `MP_WEBHOOK_SECRET`.
   O sistema já envia o endereço do webhook em cada checkout, então funciona mesmo sem este passo.

Para testar sem cobrar de verdade, use as credenciais de **teste** e os cartões de teste
do Mercado Pago num deploy de preview.

## Como a cobrança funciona

- A pessoa cria a conta e vai para a tela de planos. Sem pagamento aprovado, os dados ficam bloqueados.
- Pagamento aprovado soma o período (1 mês ou 12 meses) à data atual de vencimento.
  Renovar antes do fim não perde dias.
- O sistema nunca confia só na notificação: busca o pagamento na API do Mercado Pago,
  confere o valor e a moeda e credita uma única vez por pagamento.
- Pix pendente: o acesso libera quando o Mercado Pago confirma (webhook ou botão "Já paguei").
- Venceu: a conta volta para a tela de planos. Os dados continuam guardados.

## Conta principal (migração)

Os dados que existiam antes da versão SaaS e os logins da variável `USERS` viram
automaticamente a "Conta principal", com acesso vitalício. Depois do primeiro acesso,
cada um pode trocar a senha na aba **Conta**, e a variável `USERS` pode ser removida.

## Pessoas por conta

O titular adiciona até 5 pessoas na aba **Conta**, com e-mail e senha inicial.
Todos veem e editam os mesmos dados. O titular também pode redefinir a senha de quem ele adicionou.

## Esqueci minha senha

Com `RESEND_API_KEY` configurada, a tela de entrada envia um link por e-mail (vale 1 hora, uso único).
No Resend, verifique seu domínio para enviar para qualquer endereço; sem domínio verificado,
o remetente de teste `onboarding@resend.dev` só entrega no e-mail da sua própria conta Resend.

## Segurança do login

Depois de 8 senhas erradas para o mesmo e-mail (ou 30 do mesmo IP), o login fica bloqueado por 15 minutos.

## Administração

Quem estiver em `ADMIN_EMAILS` vê a aba **Admin**: receita do mês e total, contas pagantes, vencidas e
que nunca pagaram, busca por conta ou e-mail, últimos pagamentos, botão **+ dias** para dar
(ou tirar, com número negativo) dias de acesso manualmente. Clicando no número de pessoas, dá para remover alguém de uma conta; o 🗑 exclui a conta inteira com todos os dados (pede para digitar EXCLUIR). A conta vitalícia não pode ser excluída.

## Como funciona o app

- **Entradas e saídas**: lançamentos por mês, com categoria e quem lançou.
- **Contas a pagar**: ao clicar em *Pagar*, a conta vira uma saída. Contas mensais geram a do mês seguinte.
- **Investimentos**: total aplicado e valor atual para ver o rendimento.
- **WhatsApp**: botão que abre o WhatsApp com o resumo do mês pronto.
- **Painel**: resumo do mês, saldo, entradas × saídas dos últimos 6 meses, gastos por categoria.

Dica: no celular, "Adicionar à tela inicial" deixa o site com cara de app.
