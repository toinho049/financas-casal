import { getSession } from './_lib/auth.js';
import { q, getSetting } from './_lib/db.js';
import { createCheckout, createPix, processPayment, publicPlans, baseUrl, createSubscription, syncSubscription, cancelSubscription } from './_lib/billing.js';

export default async function handler(req, res) {
  const action = req.query.action || '';
  try {
    if (action === 'plans') return res.json(publicPlans());

    // Quantos dias de teste grátis o visitante ganha (padrão ou link de campanha)
    if (action === 'offer') {
      const code = String(req.query.convite || '').trim().toUpperCase().slice(0, 40);
      const [camp] = code ? await q(`SELECT days FROM campaigns WHERE code = $1 AND active`, [code]) : [];
      const days = camp ? camp.days : Math.max(0, Math.trunc(Number(await getSetting('trial_days', 0)) || 0));
      return res.json({ trial_days: days, campaign: camp ? code : null, plans: publicPlans() });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
    const me = await getSession(req);
    if (!me) return res.status(401).json({ error: 'Não autenticado' });

    if (action === 'checkout') {
      const url = await createCheckout({ accountId: me.account_id, email: me.email, plan: req.body?.plan, base: baseUrl(req) });
      return res.json({ url });
    }

    if (action === 'pix') {
      const pix = await createPix({ accountId: me.account_id, email: me.email, plan: req.body?.plan, base: baseUrl(req) });
      return res.json(pix);
    }

    // Assinatura automática no cartão
    if (action === 'subscribe') {
      const [a] = await q(`SELECT paid_until, subscription_status FROM accounts WHERE id = $1`, [me.account_id]);
      if (a?.subscription_status === 'authorized') return res.status(400).json({ error: 'Sua assinatura automática já está ativa' });
      const url = await createSubscription({ accountId: me.account_id, email: me.email, plan: req.body?.plan, base: baseUrl(req), paidUntil: a?.paid_until });
      return res.json({ url });
    }
    if (action === 'confirm-sub') {
      const [a] = await q(`SELECT subscription_id FROM accounts WHERE id = $1`, [me.account_id]);
      const id = String(req.body?.preapproval_id || a?.subscription_id || '').replace(/[^\w-]/g, '');
      if (!id) return res.status(400).json({ error: 'Assinatura não encontrada' });
      const r = await syncSubscription(id);
      if (r.accountId && r.accountId !== me.account_id) return res.status(403).json({ error: 'Assinatura de outra conta' });
      return res.json(r);
    }
    if (action === 'cancel-sub') {
      if (me.role !== 'owner') return res.status(403).json({ error: 'Só o titular pode cancelar a assinatura' });
      return res.json(await cancelSubscription(me.account_id));
    }

    // Retorno do checkout: confere o pagamento na hora, sem esperar o webhook
    if (action === 'confirm') {
      const id = String(req.body?.payment_id || '').replace(/\D/g, '');
      if (!id) return res.status(400).json({ error: 'Pagamento não informado' });
      const r = await processPayment(id);
      if (r.accountId && r.accountId !== me.account_id) return res.status(403).json({ error: 'Pagamento de outra conta' });
      return res.json({ status: r.status, credited: !!r.credited });
    }

    res.status(400).json({ error: 'Ação inválida' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
}
