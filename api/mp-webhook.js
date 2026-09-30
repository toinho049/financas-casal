import { processPayment, validWebhookSignature, syncSubscription, processAuthorizedPayment } from './_lib/billing.js';

// Notificações do Mercado Pago. O conteúdo da notificação não é confiável por si só:
// o pagamento/assinatura é sempre buscado de novo na API do Mercado Pago antes de liberar acesso.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });
  const query = req.query || {};
  const body = req.body || {};
  const type = String(query.type || query.topic || body.type || body.topic || '');
  const id = query['data.id'] || body.data?.id || query.id;

  const handlers = {
    payment: processPayment,
    subscription_preapproval: syncSubscription,
    preapproval: syncSubscription,
    subscription_authorized_payment: processAuthorizedPayment,
    authorized_payment: processAuthorizedPayment,
  };
  const fn = handlers[type];
  if (!fn || !id) return res.status(200).json({ ignored: true });
  if (!validWebhookSignature(req, query['data.id'] || body.data?.id || id)) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }
  try {
    const r = await fn(String(id));
    res.status(200).json(r);
  } catch (e) {
    console.error('mp-webhook', type, e);
    res.status(500).json({ error: e.message }); // o Mercado Pago tenta de novo
  }
}
