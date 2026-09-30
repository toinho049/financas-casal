import crypto from 'node:crypto';
import { q } from './db.js';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

// Preços configuráveis pelas variáveis PRICE_MENSAL e PRICE_ANUAL
export const PLANS = {
  mensal: { id: 'mensal', title: 'Mensal', period: '1 mês', price: num(process.env.PRICE_MENSAL, 19.9), interval: '1 month' },
  anual: { id: 'anual', title: 'Anual', period: '12 meses', price: num(process.env.PRICE_ANUAL, 149.9), interval: '1 year' },
};

export const publicPlans = () =>
  Object.values(PLANS).map(({ id, title, period, price }) => ({ id, title, period, price }));

export function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `https://${host}`;
}

async function mp(path, { method = 'GET', body, idem } = {}) {
  if (!process.env.MP_ACCESS_TOKEN) throw new Error('Pagamento não configurado (MP_ACCESS_TOKEN).');
  const r = await fetch('https://api.mercadopago.com' + path, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(idem ? { 'X-Idempotency-Key': idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || `Mercado Pago respondeu ${r.status}`);
  return d;
}

// Cria o checkout (Pix ou cartão) e devolve o link de pagamento
export async function createCheckout({ accountId, email, plan, base }) {
  const p = PLANS[plan];
  if (!p) throw new Error('Plano inválido');
  const pref = await mp('/checkout/preferences', {
    method: 'POST',
    idem: crypto.randomUUID(),
    body: {
      items: [{ id: p.id, title: `Finanças do Casal — plano ${p.title}`, quantity: 1, unit_price: p.price, currency_id: 'BRL' }],
      payer: email && email.includes('@') ? { email } : undefined,
      external_reference: `acc:${accountId}:${p.id}`,
      back_urls: { success: `${base}/?pago=ok`, pending: `${base}/?pago=pendente`, failure: `${base}/?pago=falhou` },
      auto_return: 'approved',
      notification_url: `${base}/api/mp-webhook`,
      statement_descriptor: 'FINANCASCASAL',
    },
  });
  return pref.init_point;
}

// Pix direto: devolve o QR code e o "copia e cola" para mostrar no próprio site
export async function createPix({ accountId, email, plan, base }) {
  const p = PLANS[plan];
  if (!p) throw new Error('Plano inválido');
  if (!email || !email.includes('@')) throw new Error('Cadastre seu e-mail em Conta → Meus dados antes de pagar com Pix.');
  // expira em 30 minutos (horário de Brasília)
  const exp = new Date(Date.now() + 30 * 60 * 1000 - 3 * 60 * 60 * 1000).toISOString().replace('Z', '-03:00');
  let pay;
  try {
    pay = await mp('/v1/payments', {
      method: 'POST',
      idem: crypto.randomUUID(),
      body: {
        transaction_amount: p.price,
        description: `Finanças do Casal — plano ${p.title}`,
        payment_method_id: 'pix',
        payer: { email },
        external_reference: `acc:${accountId}:${p.id}`,
        notification_url: `${base}/api/mp-webhook`,
        date_of_expiration: exp,
      },
    });
  } catch (e) {
    if (/key enabled|without key|pix key/i.test(e.message)) {
      throw new Error('A conta do Mercado Pago que recebe ainda não tem chave Pix cadastrada. Use o cartão ou tente mais tarde.');
    }
    throw e;
  }
  const td = pay.point_of_interaction?.transaction_data || {};
  if (!td.qr_code) throw new Error('O Mercado Pago não devolveu o QR code do Pix. Tente de novo ou pague com cartão.');
  return { id: String(pay.id), qr_code: td.qr_code, qr_base64: td.qr_code_base64, amount: p.price, expires: exp };
}

// Busca o pagamento direto no Mercado Pago (fonte da verdade) e libera o acesso.
// Idempotente: o mesmo pagamento nunca soma período duas vezes.
export async function processPayment(paymentId) {
  const pay = await mp(`/v1/payments/${encodeURIComponent(paymentId)}`);
  const m = /^acc:(\d+):(mensal|anual)$/.exec(pay.external_reference || '');
  if (!m) return { ignored: true };
  const accountId = Number(m[1]);
  const p = PLANS[m[2]];

  await q(
    `INSERT INTO payments (id, account_id, plan, amount, status) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
    [String(pay.id), accountId, p.id, pay.transaction_amount, pay.status]
  );

  let credited = false;
  const valid = pay.status === 'approved' && pay.currency_id === 'BRL' && Number(pay.transaction_amount) >= p.price - 0.01;
  if (valid) {
    const rows = await q(
      `WITH c AS (
         UPDATE payments SET credited = true, updated_at = now()
         WHERE id = $1 AND credited = false AND status = 'approved'
         RETURNING account_id, plan
       )
       UPDATE accounts a
          SET paid_until = GREATEST(COALESCE(a.paid_until, now()), now()) + $2::interval,
              plan = CASE WHEN a.plan = 'vitalicio' THEN a.plan ELSE c.plan END
         FROM c WHERE a.id = c.account_id
       RETURNING a.id`,
      [String(pay.id), p.interval]
    );
    credited = rows.length > 0;
  }
  return { accountId, status: pay.status, credited };
}

// Validação opcional da assinatura do webhook (MP_WEBHOOK_SECRET)
export function validWebhookSignature(req, dataId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) return true;
  const header = String(req.headers['x-signature'] || '');
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId).toLowerCase()};request-id:${req.headers['x-request-id'] || ''};ts:${parts.ts};`;
  const calc = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
  return calc.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(parts.v1));
}
