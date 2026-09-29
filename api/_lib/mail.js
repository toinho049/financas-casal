// Envio de e-mail pelo Resend (resend.com). Sem RESEND_API_KEY, não envia.
export const mailEnabled = () => !!process.env.RESEND_API_KEY;

export async function sendMail({ to, subject, html }) {
  if (!mailEnabled()) throw new Error('Envio de e-mail não configurado');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Finanças do Casal <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.message || `Falha ao enviar e-mail (${r.status})`);
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const resetEmail = (name, link) => `
<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#16201b">
  <h2 style="color:#0f8a5f">Finanças do Casal</h2>
  <p>Olá, ${esc(name)}!</p>
  <p>Recebemos um pedido para redefinir a sua senha. Clique no botão abaixo para criar uma nova:</p>
  <p style="margin:28px 0"><a href="${esc(link)}" style="background:#0f8a5f;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Criar nova senha</a></p>
  <p style="color:#6a766f;font-size:13px">O link vale por 1 hora e só pode ser usado uma vez. Se não foi você, ignore este e-mail: sua senha continua a mesma.</p>
</div>`;
