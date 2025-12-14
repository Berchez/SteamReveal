import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const FEEDBACK_RESEND_EMAIL = process.env.FEEDBACK_RESEND_EMAIL ?? '';

function escapeHtml(unsafe: string) {
  return unsafe
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function sendFeedbackEmail(data: {
  message: string;
  type: string;
  page: string;
  language: string;
  userAgent: string;
}) {
  if (!FEEDBACK_RESEND_EMAIL) {
    throw new Error('Missing FEEDBACK_RESEND_EMAIL env var');
  }

  // Sanitize
  const safeMessage = escapeHtml(data.message);

  const html = `
    <p><strong>Message:</strong></p>
    <pre style="white-space:pre-wrap">${safeMessage}</pre>
    <hr />
    <p>Page: ${escapeHtml(data.page)}</p>
    <p>Language: ${escapeHtml(data.language)}</p>
    <p>User Agent: ${escapeHtml(data.userAgent)}</p>
  `;

  const text = [
    `Message:\n${data.message}`,
    `Page: ${data.page}`,
    `Language: ${data.language}`,
    `User Agent: ${data.userAgent}`,
  ].join('\n\n');

  try {
    await resend.emails.send({
      from: 'SteamReveal <onboarding@resend.dev>',
      to: FEEDBACK_RESEND_EMAIL,
      subject: `[Feedback][${data.type}] SteamReveal`,
      html,
      text,
    });
  } catch (err) {
    // log full error for server logs
    console.error('sendFeedbackEmail error:', err);
    throw err; // let the caller handle HTTP response
  }
}

export default sendFeedbackEmail;
