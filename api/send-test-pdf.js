// /api/_send_pdf — one-shot endpoint to email the test guide PDF.
// Will be removed after use. Protected by a bearer token.

const RESEND_API_KEY = process.env.RESEND_API_KEY;

export const config = {
  api: {
    bodyParser: { sizeLimit: '4mb' }
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const auth = String(req.headers.authorization || '');
  if (auth !== 'Bearer demohub-temp-pdf-send-026e85e9') return res.status(401).json({ error: 'Unauthorized' });
  if (!RESEND_API_KEY) return res.status(500).json({ error: 'RESEND_API_KEY missing' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { to, subject, html, attachment_b64, attachment_name } = body || {};
    if (!to || !attachment_b64) return res.status(400).json({ error: 'Need to + attachment_b64' });

    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Demohub <david@demohubhq.com>',
        to: Array.isArray(to) ? to : [to],
        subject: subject || 'Demohub testing guide',
        html: html || '<p>Attached.</p>',
        attachments: [{
          filename: attachment_name || 'attachment.pdf',
          content: attachment_b64,
        }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Resend error', detail: j });
    return res.status(200).json({ ok: true, id: j.id });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
