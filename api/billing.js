import { getSession } from './_lib/auth.js';
import { createCheckout, processPayment, publicPlans, baseUrl } from './_lib/billing.js';

export default async function handler(req, res) {
  const action = req.query.action || '';
  try {
    if (action === 'plans') return res.json(publicPlans());

    if (req.method !== 'POST') return res.status(405).json({ error: 'Método não permitido' });
    const me = await getSession(req);
    if (!me) return res.status(401).json({ error: 'Não autenticado' });

    if (action === 'checkout') {
      const url = await createCheckout({ accountId: me.account_id, email: me.email, plan: req.body?.plan, base: baseUrl(req) });
      return res.json({ url });
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
