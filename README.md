# Finanças do Casal

Sistema simples para controlar entradas, saídas, contas a pagar e investimentos, com gráficos.
Front-end em HTML/JS puro + funções serverless da Vercel + Postgres (Neon, plano grátis).

## Estrutura

```
index.html          # interface (painel, lançamentos, contas, investimentos)
api/login.js        # login/logout (cookie assinado, 30 dias)
api/data.js         # CRUD de transactions, bills, investments + "pagar conta"
api/_lib/db.js      # conexão Neon; cria as tabelas sozinho na 1ª chamada
api/_lib/auth.js    # usuários vindos da variável USERS
```

## Deploy na Vercel (≈10 min)

1. Suba esta pasta para um repositório no GitHub (pode ser privado).
2. Na Vercel: **Add New → Project** → importe o repositório. Framework: **Other**. Não precisa de build command.
3. No projeto, aba **Storage → Create Database → Neon (Postgres)** → conecte ao projeto.
   Isso cria a variável `DATABASE_URL` automaticamente.
4. Em **Settings → Environment Variables**, adicione:
   - `USERS` = `mateus:SuaSenha;esposa:SenhaDela`  (usuário:senha, separados por `;`)
   - `SESSION_SECRET` = um texto longo e aleatório (ex.: saída de `openssl rand -base64 32`)
5. **Redeploy**. Pronto — as tabelas são criadas no primeiro acesso.

> Para trocar senha ou tirar alguém, edite `USERS` e faça redeploy. Mudar o `SESSION_SECRET` desloga todo mundo.
> O nome antes do `:` é o que aparece no campo "Quem" dos lançamentos.

## Rodar local

```bash
npm i
npm i -g vercel
vercel link
vercel env pull .env.local   # traz DATABASE_URL, USERS e SESSION_SECRET
vercel dev
```

## Como funciona

- **Entradas e saídas**: lançamentos por mês, com categoria e quem lançou.
- **Contas a pagar**: ao clicar em *Pagar*, a conta é marcada como paga e vira uma saída automaticamente.
  Se estiver marcada como *mensal*, a conta do mês seguinte é criada sozinha.
- **Investimentos**: cadastre o total aplicado e atualize o *valor atual* de vez em quando para ver o rendimento.
- **WhatsApp**: botão "Enviar no WhatsApp" no Painel (resumo do mês) e em Contas a pagar (só as contas). Abre o WhatsApp com o texto pronto; é só escolher o grupo.
- **Painel**: resumo do mês, saldo em caixa, entradas × saídas dos últimos 6 meses, gastos por categoria,
  evolução do saldo e próximas contas.

Dica: no celular, abra o site e use "Adicionar à tela inicial" para usar como app.
