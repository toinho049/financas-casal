import crypto from 'node:crypto';
import { q, getSetting, setSetting } from './_lib/db.js';
import { getSession } from './_lib/auth.js';
import { isAdmin } from './_lib/security.js';
import { baseUrl } from './_lib/billing.js';
import { parseMessage, parseCommand, norm } from './_lib/parse.js';
import { createInstallments, payBill } from './data.js';

// Robô que lança gastos por mensagem: Telegram (privado ou grupo) e WhatsApp oficial (Meta Cloud API).
//
// Variáveis na Vercel:
//   TELEGRAM_BOT_TOKEN   token do @BotFather (depois, Admin → Robô → Ativar Telegram)
//   WHATSAPP_TOKEN       token permanente do app na Meta
//   WHATSAPP_PHONE_ID    "Phone number ID" do número do robô
//   WHATSAPP_APP_SECRET  (recomendado) "App secret" do app, para conferir que a mensagem veio da Meta

const SECRET = process.env.SESSION_SECRET || '';
const hmac = (k) => crypto.createHmac('sha256', SECRET).update(k).digest('hex');
const tgSecret = () => hmac('tg-webhook').slice(0, 48);
export const waVerifyToken = () => hmac('wa-verify').slice(0, 32);
const WA_VER = process.env.WHATSAPP_API_VERSION || 'v23.0';
const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const hoje = () => new Date(Date.now() - 3 * 3600e3);    // horário de Brasília

/* ---------- Enviar mensagens ---------- */
async function tg(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN não configurado');
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(d.description || `Telegram respondeu ${r.status}`);
  return d.result;
}
async function waSend(to, text) {
  const r = await fetch(`https://graph.facebook.com/${WA_VER}/${process.env.WHATSAPP_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }),
  });
  if (!r.ok) console.error('whatsapp send', r.status, (await r.text()).slice(0, 300));
}
async function reply(ch, chatId, text) {
  try {
    if (ch === 'tg') await tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
    else await waSend(chatId, text);
  } catch (e) { console.error('bot reply', ch, e.message); }
}

/* ---------- Textos ---------- */
const EXEMPLOS = `• gastei 100 em alimentação
• mercado 250,90 no débito
• uber 23,50 pix
• tv 1.200 em 10x nubank
• recebi 5000 salário
• farmácia 45 ontem
• paguei a luz (dá baixa na conta a pagar)`;
const AJUDA = `Oi! Eu lanço seus gastos no Finanças do Casal 💚

É só mandar o valor e o que foi, do jeito que você fala:
${EXEMPLOS}

Outros comandos:
• resumo — como está o mês
• contas — o que vence nos próximos dias
• desfazer — apaga o último lançamento
• sair — desconecta este chat`;
const NAO_CONECTADO = (site) => `Oi! Para eu lançar seus gastos, conecte sua conta primeiro:

1. Abra ${site}
2. Vá em Conta → Lançar por mensagem
3. Toque em Conectar

Ainda não tem conta? Crie em ${site}`;

/* ---------- Ações ---------- */
async function linkCode(ch, extId, code, label) {
  const [c] = await q(
    `DELETE FROM bot_codes WHERE code = $1 AND expires_at > now() RETURNING user_id`, [code]);
  if (!c) return '❌ Código inválido ou vencido. No app, vá em Conta → Lançar por mensagem e gere um novo.';
  await q(
    `INSERT INTO bot_links (channel, ext_id, user_id, label) VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel, ext_id) DO UPDATE SET user_id = EXCLUDED.user_id, label = EXCLUDED.label, created_at = now()`,
    [ch, String(extId), c.user_id, label ? String(label).slice(0, 60) : null]);
  const [u] = await q(`SELECT u.name, a.name AS acc FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1`, [c.user_id]);
  return `✅ Pronto, ${u.name.split(' ')[0]}! Este chat está ligado à conta "${u.acc}".

Agora é só mandar, por exemplo:
${EXEMPLOS}

Mande "ajuda" quando quiser ver os comandos.`;
}

async function summary(me) {
  const d = hoje(), ini = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
  const [m] = await q(
    `SELECT COALESCE(sum(amount) FILTER (WHERE type = 'entrada'), 0)::float8 AS ent,
            COALESCE(sum(amount) FILTER (WHERE type = 'saida'), 0)::float8 AS sai
     FROM transactions WHERE account_id = $1 AND date >= $2::date AND date < ($2::date + interval '1 month')`, [me.account_id, ini]);
  const top = await q(
    `SELECT COALESCE(NULLIF(category, ''), 'Sem categoria') AS c, sum(amount)::float8 AS v FROM transactions
     WHERE account_id = $1 AND type = 'saida' AND date >= $2::date AND date < ($2::date + interval '1 month')
     GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [me.account_id, ini]);
  const [b] = await q(
    `SELECT count(*)::int AS n, COALESCE(sum(amount), 0)::float8 AS v FROM bills
     WHERE account_id = $1 AND NOT paid AND due_date < ($2::date + interval '1 month')`, [me.account_id, ini]);
  const MES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'][d.getUTCMonth()];
  const r = m.ent - m.sai;
  return `📊 Resumo de ${MES}
Entrou: ${brl(m.ent)}
Saiu: ${brl(m.sai)}
${r >= 0 ? 'Sobrou' : 'Faltou'}: ${brl(Math.abs(r))}
${top.length ? '\nOnde mais gastou:\n' + top.map((t) => `• ${t.c}: ${brl(t.v)}`).join('\n') : ''}
${b.n ? `\n📅 Falta pagar no mês: ${b.n} conta(s), ${brl(b.v)}` : '\n✅ Nenhuma conta pendente no mês'}`.trim();
}

async function bills(me) {
  const rows = await q(
    `SELECT description, amount::float8 AS amount, due_date::text AS d FROM bills
     WHERE account_id = $1 AND NOT paid AND due_date <= (now() AT TIME ZONE 'America/Sao_Paulo')::date + 7
     ORDER BY due_date LIMIT 10`, [me.account_id]);
  if (!rows.length) return '✅ Nenhuma conta vencida nem vencendo nos próximos 7 dias.';
  const t = hoje().toISOString().slice(0, 10);
  return '📅 Contas a pagar:\n' + rows.map((b) => `• ${b.description}: ${brl(b.amount)} — ${b.d < t ? '⚠️ venceu ' : b.d === t ? 'vence HOJE ' : 'vence '}${b.d.slice(8)}/${b.d.slice(5, 7)}`).join('\n')
    + '\n\nPara dar baixa, mande "paguei a luz" (o nome da conta).';
}

async function undo(me) {
  const [t] = await q(
    `SELECT id, description, amount::float8 AS amount, installment_group, bill_id FROM transactions
     WHERE account_id = $1 AND bot_user = $2 AND created_at > now() - interval '2 days'
     ORDER BY created_at DESC, id DESC LIMIT 1`, [me.account_id, me.id]);
  if (!t) return 'Não achei lançamento recente feito por aqui para apagar.';
  if (t.installment_group) await q(`DELETE FROM transactions WHERE account_id = $1 AND installment_group = $2`, [me.account_id, t.installment_group]);
  else await q(`DELETE FROM transactions WHERE id = $1 AND account_id = $2`, [t.id, me.account_id]);
  if (t.bill_id) {
    await q(`UPDATE bills SET paid = false, paid_at = NULL WHERE id = $1 AND account_id = $2`, [t.bill_id, me.account_id]);
    // a conta do mês seguinte criada ao pagar (se recorrente) também sai
    await q(`DELETE FROM bills WHERE id = (SELECT max(id) FROM bills WHERE account_id = $1 AND description = (SELECT description FROM bills WHERE id = $2) AND NOT paid AND id > $2)`,
      [me.account_id, t.bill_id]);
  }
  return `↩️ Apaguei: ${t.description} (${brl(t.amount)}).`;
}

// Aviso de orçamento depois de lançar
async function budgetNote(accountId, category, date) {
  if (!category) return '';
  const [b] = await q(
    `SELECT b.amount::float8 AS lim, COALESCE((SELECT sum(amount) FROM transactions t WHERE t.account_id = b.account_id AND t.type = 'saida'
        AND lower(COALESCE(t.category, '')) = lower(b.category) AND date_trunc('month', t.date) = date_trunc('month', $3::date)), 0)::float8 AS gasto
     FROM budgets b WHERE b.account_id = $1 AND lower(b.category) = lower($2)`, [accountId, category, date]);
  if (!b) return '';
  const p = Math.round(b.gasto / b.lim * 100);
  if (p >= 100) return `\n🚨 ${category}: ${brl(b.gasto)} de ${brl(b.lim)} no mês — estourou o orçamento (${p}%).`;
  if (p >= 80) return `\n⚠️ ${category}: ${brl(b.gasto)} de ${brl(b.lim)} no mês (${p}%).`;
  return `\n${category}: ${brl(b.gasto)} de ${brl(b.lim)} no mês (${p}%).`;
}

const quando = (d) => {
  const t = hoje(); const ts = t.toISOString().slice(0, 10);
  t.setUTCDate(t.getUTCDate() - 1);
  return d === ts ? 'hoje' : d === t.toISOString().slice(0, 10) ? 'ontem' : `${d.slice(8)}/${d.slice(5, 7)}`;
};

async function launch(me, text) {
  const [cats, cards] = await Promise.all([
    q(`SELECT DISTINCT category AS c FROM transactions WHERE account_id = $1 AND category IS NOT NULL AND category <> ''
       UNION SELECT category FROM budgets WHERE account_id = $1`, [me.account_id]),
    q(`SELECT id, name FROM cards WHERE account_id = $1 ORDER BY id`, [me.account_id]),
  ]);
  const p = parseMessage(text, { now: hoje(), cats: cats.map((r) => r.c), cards });

  // "paguei a luz": dá baixa numa conta a pagar com esse nome (o valor é opcional)
  const nt = ' ' + norm(text).replace(/[!?.,;]+/g, ' ') + ' ';
  if ((!p || p.type === 'saida') && /\b(paguei|pago|pagamos|quitei)\b/.test(nt)) {
    const open = await q(
      `SELECT id, description, amount::float8 AS amount FROM bills WHERE account_id = $1 AND NOT paid ORDER BY due_date LIMIT 50`, [me.account_id]);
    const bill = open.find((b) => { const n = norm(b.description); return n.length >= 3 && nt.includes(' ' + n + ' ') && (!p?.amount || Math.abs(p.amount - b.amount) <= Math.max(1, b.amount * 0.1)); });
    if (bill) {
      const m0 = ['Pix', 'Cartão de débito', 'Cartão de crédito', 'Dinheiro', 'Boleto'].find((m) => nt.includes(' ' + norm(m).split(' ').pop() + ' ')) || null;
      await payBill(bill.id, { date: p?.date || hoje().toISOString().slice(0, 10), person: me.name, method: p?.method || m0 }, me);
      await q(`UPDATE transactions SET bot_user = $1 WHERE account_id = $2 AND bill_id = $3`, [me.id, me.account_id, bill.id]);
      return `✅ Conta paga: ${bill.description} — ${brl(bill.amount)}\nJá lancei a saída${p?.method || m0 ? ` (${p?.method || m0})` : ''}. Para desfazer, mande "desfazer".`;
    }
  }
  if (!p) return null;

  const base = { type: p.type, description: p.description, amount: p.amount, category: p.category, date: p.date, person: me.name, method: p.method, card_id: p.card_id };
  if (p.installments > 1) {
    const rows = await createInstallments({ ...base, installments: p.installments }, me.account_id);
    await q(`UPDATE transactions SET bot_user = $1 WHERE account_id = $2 AND installment_group = $3`, [me.id, me.account_id, rows[0].installment_group]);
  } else {
    await q(
      `INSERT INTO transactions (type, description, amount, category, date, person, method, card_id, account_id, bot_user)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [base.type, base.description, base.amount, base.category, base.date, base.person, base.method, base.card_id, me.account_id, me.id]);
  }
  const info = [p.category ? `🏷️ ${p.category}` : '🏷️ sem categoria', p.method ? `💳 ${p.method}${p.card_name ? ' ' + p.card_name : ''}` : null, `📅 ${quando(p.date)}`]
    .filter(Boolean).join(' · ');
  const valor = p.installments > 1 ? `${p.installments}x de ${brl(p.amount / p.installments)} (total ${brl(p.amount)})` : brl(p.amount);
  return `✅ ${p.type === 'entrada' ? 'Entrada' : 'Saída'} lançada: ${p.description} — ${valor}
${info}${p.type === 'saida' ? await budgetNote(me.account_id, p.category, p.date) : ''}
Errou? Mande "desfazer".`;
}

// Mensagem que chegou de qualquer canal
async function handle({ ch, extId, chatId, text, label, group, key }, site) {
  if (!text) return;
  const ins = await q(`INSERT INTO bot_seen (key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key`, [key]);
  if (!ins.length) return;                                   // mensagem repetida (reentrega)
  const clean = String(text).replace(/^\/(\w+)@\w+/, '/$1').trim();
  const cmd = parseCommand(clean);
  if (cmd?.cmd === 'link') return reply(ch, chatId, await linkCode(ch, extId, cmd.code, label));

  const [me] = await q(
    `SELECT u.id, u.name, u.account_id, (a.paid_until IS NOT NULL AND a.paid_until > now()) AS active
     FROM bot_links l JOIN users u ON u.id = l.user_id JOIN accounts a ON a.id = u.account_id
     WHERE l.channel = $1 AND l.ext_id = $2`, [ch, String(extId)]);
  if (!me) {
    if (!group && (cmd || /\d/.test(clean) || clean.length < 40)) await reply(ch, chatId, NAO_CONECTADO(site));
    return;
  }
  if (cmd?.cmd === 'help') return reply(ch, chatId, AJUDA);
  if (cmd?.cmd === 'unlink') {
    await q(`DELETE FROM bot_links WHERE channel = $1 AND ext_id = $2`, [ch, String(extId)]);
    return reply(ch, chatId, '👋 Desconectado. Para voltar, gere um novo código no app em Conta → Lançar por mensagem.');
  }
  if (!me.active) return reply(ch, chatId, `⏳ Seu acesso ao Finanças do Casal venceu. Renove em ${site} para continuar lançando por aqui.`);
  if (cmd?.cmd === 'summary') return reply(ch, chatId, await summary(me));
  if (cmd?.cmd === 'bills') return reply(ch, chatId, await bills(me));
  if (cmd?.cmd === 'undo') return reply(ch, chatId, await undo(me));

  const out = await launch(me, clean);
  if (out) return reply(ch, chatId, out);
  if (!group) return reply(ch, chatId, `Não entendi 🤔 Mande o valor e o que foi, por exemplo:\n${EXEMPLOS}`);
}

/* ---------- Corpo cru (para conferir a assinatura do WhatsApp) ---------- */
function rawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return Promise.resolve(req.rawBody);
  if (req.readableEnded || req.complete && !req.readable) return Promise.resolve(null);
  return new Promise((resolve) => {
    const ch = []; let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => ch.push(c)); req.on('end', () => fin(Buffer.concat(ch))); req.on('error', () => fin(null));
    setTimeout(() => fin(ch.length ? Buffer.concat(ch) : null), 3000);
  });
}

async function botStatus() {
  const tgOn = !!process.env.TELEGRAM_BOT_TOKEN, waOn = !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);
  const info = (await getSetting('bot_info', {})) || {};
  return { telegram: tgOn && info.tg_username ? info.tg_username : null, telegram_token: tgOn, telegram_ready: tgOn && !!info.tg_webhook,
    whatsapp: waOn ? (info.wa_number || null) : null, whatsapp_on: waOn };
}

export default async function handler(req, res) {
  const action = req.query.action || '';
  const site = process.env.APP_URL || 'https://www.financasdocasal.sbs';
  try {
    // WhatsApp: verificação do webhook pela Meta
    if (req.method === 'GET' && req.query['hub.mode'] === 'subscribe') {
      if (req.query['hub.verify_token'] === waVerifyToken()) return res.status(200).send(String(req.query['hub.challenge'] || ''));
      return res.status(403).send('forbidden');
    }

    // Telegram
    if (req.method === 'POST' && req.query.ch === 'tg') {
      if (!SECRET || req.headers['x-telegram-bot-api-secret-token'] !== tgSecret()) return res.status(401).json({ error: 'unauthorized' });
      const msg = req.body?.message;
      if (msg?.text && msg.from && !msg.from.is_bot) {
        await handle({
          ch: 'tg', extId: msg.from.id, chatId: msg.chat.id, text: msg.text,
          label: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username,
          group: msg.chat.type !== 'private', key: `tg:${req.body.update_id}`,
        }, site);
      }
      return res.status(200).json({ ok: true });
    }

    // WhatsApp (Meta Cloud API)
    if (req.method === 'POST' && (req.query.ch === 'wa' || !action)) {
      const raw = await rawBody(req);
      const appSecret = process.env.WHATSAPP_APP_SECRET;
      if (appSecret) {
        const sig = String(req.headers['x-hub-signature-256'] || '');
        const calc = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw || '').digest('hex');
        if (!raw || sig.length !== calc.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(calc))) return res.status(401).json({ error: 'assinatura inválida' });
      }
      let body = req.body;
      if (raw) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = {}; } }
      if (body?.object !== 'whatsapp_business_account') return res.status(200).json({ ignored: true });
      for (const e of body.entry || []) for (const c of e.changes || []) {
        const v = c.value || {};
        const names = Object.fromEntries((v.contacts || []).map((x) => [x.wa_id, x.profile?.name]));
        for (const m of v.messages || []) {
          if (m.type !== 'text') {
            await handle({ ch: 'wa', extId: m.from, chatId: m.from, text: 'ajuda', key: `wa:${m.id}`, label: names[m.from] }, site);
            continue;
          }
          await handle({ ch: 'wa', extId: m.from, chatId: m.from, text: m.text?.body, label: names[m.from], group: false, key: `wa:${m.id}` }, site);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // Daqui para baixo: telas do app (precisa estar logado)
    const me = await getSession(req);
    if (!me) return res.status(401).json({ error: 'Não autenticado' });

    if (req.method === 'GET' && action === 'status') {
      const links = await q(
        `SELECT id, channel, label, (created_at AT TIME ZONE 'America/Sao_Paulo')::date::text AS since FROM bot_links WHERE user_id = $1 ORDER BY id`, [me.id]);
      return res.json({ ...(await botStatus()), links });
    }
    if (req.method === 'POST' && action === 'code') {
      await q(`DELETE FROM bot_codes WHERE user_id = $1 OR expires_at < now()`, [me.id]);
      let code;
      for (let i = 0; i < 5; i++) {
        code = String(crypto.randomInt(100000, 1000000));
        const r = await q(`INSERT INTO bot_codes (code, user_id, expires_at) VALUES ($1, $2, now() + interval '15 minutes') ON CONFLICT DO NOTHING RETURNING code`, [code, me.id]);
        if (r.length) break;
      }
      return res.json({ code, ...(await botStatus()) });
    }
    if (req.method === 'POST' && action === 'unlink') {
      await q(`DELETE FROM bot_links WHERE id = $1 AND user_id = $2`, [Number(req.body?.id), me.id]);
      return res.json({ ok: true });
    }

    // Admin: ligar o Telegram e ver os dados para configurar o WhatsApp
    if (action === 'setup' || action === 'admin') {
      if (!isAdmin(me)) return res.status(403).json({ error: 'Acesso restrito' });
      const base = baseUrl(req), info = (await getSetting('bot_info', {})) || {};
      const out = { errors: [] };
      if (req.method === 'POST' && action === 'setup') {
        if (process.env.TELEGRAM_BOT_TOKEN) {
          try {
            const meBot = await tg('getMe', {});
            await tg('setWebhook', { url: `${base}/api/bot?ch=tg`, secret_token: tgSecret(), allowed_updates: ['message'], drop_pending_updates: true });
            await tg('setMyCommands', { commands: [
              { command: 'resumo', description: 'Como está o mês' }, { command: 'contas', description: 'O que vence nos próximos dias' },
              { command: 'desfazer', description: 'Apaga o último lançamento' }, { command: 'ajuda', description: 'Exemplos de como lançar' }] }).catch(() => {});
            info.tg_username = meBot.username; info.tg_webhook = `${base}/api/bot?ch=tg`;
          } catch (e) { out.errors.push('Telegram: ' + e.message); }
        }
        if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) {
          try {
            const r = await fetch(`https://graph.facebook.com/${WA_VER}/${process.env.WHATSAPP_PHONE_ID}?fields=display_phone_number,verified_name`,
              { headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` } });
            const d = await r.json();
            if (d.display_phone_number) info.wa_number = d.display_phone_number.replace(/\D/g, '');
            else out.errors.push('WhatsApp: ' + (d.error?.message || 'não consegui ler o número'));
          } catch (e) { out.errors.push('WhatsApp: ' + e.message); }
        }
        await setSetting('bot_info', info);
      }
      const [n] = await q(`SELECT count(*) FILTER (WHERE channel = 'tg')::int AS tg, count(*) FILTER (WHERE channel = 'wa')::int AS wa FROM bot_links`);
      return res.json({ ...out, ...(await botStatus()), wa_webhook: `${base}/api/bot?ch=wa`, wa_verify: waVerifyToken(),
        wa_secret: !!process.env.WHATSAPP_APP_SECRET, linked: n });
    }

    res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error('bot', e);
    // Webhooks recebem 200 para o Telegram/Meta não ficarem reenviando sem parar
    res.status(req.query.ch ? 200 : 500).json({ error: e.message });
  }
}
