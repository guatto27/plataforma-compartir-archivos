'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;
if (config.smtp.enabled) {
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])
  );
}

// Envía el correo de bienvenida con las credenciales. Devuelve {sent, error}.
async function sendWelcomeEmail({ to, displayName, username, password, companyName }) {
  if (!config.smtp.enabled || !transporter) {
    return { sent: false, error: 'SMTP no configurado' };
  }
  if (!to) return { sent: false, error: 'Sin correo destino' };

  const brand = config.brand.name;
  const loginUrl = `${config.appUrl}/login`;
  const subject = `Acceso a la plataforma de ${brand}`;

  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;background:#09090b;color:#f4f4f5;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#161619;border:1px solid #27272a;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 4px;font-size:20px;color:#fbbf24">${esc(brand)}</h1>
      <p style="color:#a1a1aa;margin:0 0 18px">Soluciones en IA</p>
      <p>Hola ${esc(displayName || username)},</p>
      <p>Te damos acceso a la plataforma${companyName ? ` como parte de <strong>${esc(companyName)}</strong>` : ''}. Estas son tus credenciales:</p>
      <div style="background:#1c1c1f;border:1px solid #3f3f46;border-radius:8px;padding:14px 16px;margin:16px 0">
        <p style="margin:6px 0"><span style="color:#a1a1aa">Usuario:</span> <strong>${esc(username)}</strong></p>
        <p style="margin:6px 0"><span style="color:#a1a1aa">Contraseña temporal:</span> <strong>${esc(password)}</strong></p>
      </div>
      <p style="margin:18px 0">
        <a href="${esc(loginUrl)}" style="display:inline-block;background:#fbbf24;color:#1c1c1f;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px">Entrar a la plataforma</a>
      </p>
      <p style="color:#a1a1aa;font-size:13px">Por seguridad, se te pedirá <strong>cambiar la contraseña</strong> en tu primer acceso. No compartas estas credenciales.</p>
      <p style="color:#71717a;font-size:12px;margin-top:20px">Si no esperabas este correo, ignóralo.</p>
    </div>
  </div>`;

  const text =
    `Hola ${displayName || username},\n\n` +
    `Te damos acceso a la plataforma de ${brand}${companyName ? ` (${companyName})` : ''}.\n\n` +
    `Usuario: ${username}\nContraseña temporal: ${password}\n\n` +
    `Entra en: ${loginUrl}\n\n` +
    `Por seguridad, se te pedirá cambiar la contraseña en tu primer acceso.`;

  try {
    await transporter.sendMail({
      from: config.smtp.from || config.smtp.user,
      to,
      subject,
      text,
      html,
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

async function sendPasswordResetEmail({ to, displayName, resetUrl }) {
  if (!config.smtp.enabled || !transporter) {
    return { sent: false, error: 'SMTP no configurado' };
  }
  if (!to) return { sent: false, error: 'Sin correo destino' };

  const brand = config.brand.name;
  const subject = `Restablecer contraseña · ${brand}`;

  const html = `
  <div style="font-family:Segoe UI,Arial,sans-serif;background:#09090b;color:#f4f4f5;padding:24px">
    <div style="max-width:520px;margin:0 auto;background:#161619;border:1px solid #27272a;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 4px;font-size:20px;color:#fbbf24">${esc(brand)}</h1>
      <p style="color:#a1a1aa;margin:0 0 18px">Soluciones en IA</p>
      <p>Hola ${esc(displayName || to)},</p>
      <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta. Haz clic en el botón para continuar:</p>
      <p style="margin:18px 0">
        <a href="${esc(resetUrl)}" style="display:inline-block;background:#fbbf24;color:#1c1c1f;font-weight:700;text-decoration:none;padding:11px 20px;border-radius:8px">Restablecer contraseña</a>
      </p>
      <p style="color:#a1a1aa;font-size:13px">Este enlace es válido por <strong>1 hora</strong>. Si no solicitaste este cambio, ignora este correo.</p>
    </div>
  </div>`;

  const text =
    `Hola ${displayName || to},\n\n` +
    `Recibimos una solicitud para restablecer tu contraseña.\n\n` +
    `Usa este enlace (válido por 1 hora):\n${resetUrl}\n\n` +
    `Si no solicitaste esto, ignora este correo.`;

  try {
    await transporter.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail, smtpEnabled: () => config.smtp.enabled };
