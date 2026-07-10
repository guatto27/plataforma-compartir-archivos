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
  const subject = `Bienvenido a ${brand} · Tu acceso a la plataforma`;

  const name = esc(displayName || username);
  const company = companyName ? esc(companyName) : '';
  const html = `
  <div style="margin:0;padding:0;background:#0b0b0d;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0b0b0d;">Tu acceso a ${esc(brand)} está listo: usuario y contraseña temporal.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;padding:28px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#15151a;border:1px solid #27272a;border-radius:16px;overflow:hidden;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
          <tr><td style="padding:22px 28px;border-bottom:1px solid #27272a;">
            <span style="font-size:18px;font-weight:700;color:#f4f4f5;">BusinessCool <span style="color:#fbbf24;">AI</span></span>
          </td></tr>
          <tr><td style="padding:30px 28px 4px;">
            <h1 style="margin:0;font-size:24px;line-height:1.25;color:#f4f4f5;">Bienvenido a <span style="color:#fbbf24;">${esc(brand)}</span></h1>
            <p style="margin:12px 0 0;color:#a1a1aa;font-size:15px;line-height:1.6;">Hola ${name}, te damos acceso a la plataforma${company ? ` como parte de <strong style="color:#e4e4e7;">${company}</strong>` : ''}. Desde aquí darás seguimiento a tu proyecto de transformación con Inteligencia Artificial.</p>
          </td></tr>
          <tr><td style="padding:20px 28px 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f12;border:1px solid #3f3f46;border-radius:12px;">
              <tr><td style="padding:16px 18px;">
                <p style="margin:0 0 12px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#71717a;">Tus credenciales de acceso</p>
                <p style="margin:7px 0;color:#a1a1aa;font-size:14px;">Usuario:&nbsp; <strong style="color:#f4f4f5;font-size:15px;">${esc(username)}</strong></p>
                <p style="margin:7px 0;color:#a1a1aa;font-size:14px;">Contraseña temporal:&nbsp; <strong style="color:#f4f4f5;font-size:15px;">${esc(password)}</strong></p>
              </td></tr>
            </table>
          </td></tr>
          <tr><td align="center" style="padding:24px 28px 6px;">
            <a href="${esc(loginUrl)}" style="display:inline-block;background:#fbbf24;color:#1c1c1f;font-weight:700;font-size:15px;text-decoration:none;padding:13px 30px;border-radius:10px;">Entrar a la plataforma</a>
          </td></tr>
          <tr><td style="padding:12px 28px 28px;">
            <p style="margin:0;color:#a1a1aa;font-size:13px;line-height:1.55;">Por seguridad se te pedirá <strong style="color:#e4e4e7;">cambiar la contraseña</strong> en tu primer acceso. No compartas estas credenciales con nadie.</p>
          </td></tr>
          <tr><td style="padding:18px 28px;border-top:1px solid #27272a;background:#101013;">
            <p style="margin:0;color:#71717a;font-size:12px;">${esc(brand)} · Soluciones en IA · <a href="https://businesscool.ai" style="color:#a1a1aa;text-decoration:none;">businesscool.ai</a></p>
            <p style="margin:6px 0 0;color:#52525b;font-size:11px;">Si no esperabas este correo, puedes ignorarlo.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
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

// Notificación de documento enviado (minuta o contrato) — mismo formato que el de bienvenida
async function sendDocumentEmail({ to, displayName, kind, title, companyName }) {
  if (!config.smtp.enabled || !transporter) return { sent: false, error: 'SMTP no configurado' };
  if (!to) return { sent: false, error: 'Sin correo destino' };

  const brand = config.brand.name;
  const loginUrl = `${config.appUrl}/login`;
  const tipo = kind === 'contrato' ? 'contrato' : 'minuta';
  const Tipo = kind === 'contrato' ? 'Contrato' : 'Minuta';
  const subject = `Tienes ${tipo === 'contrato' ? 'un nuevo contrato' : 'una nueva minuta'} para revisar · ${brand}`;

  const name = esc(displayName || to);
  const company = companyName ? esc(companyName) : '';
  const html = `
  <div style="margin:0;padding:0;background:#0b0b0d;">
    <span style="display:none;max-height:0;overflow:hidden;opacity:0;color:#0b0b0d;">${Tipo} disponible en tu portal de ${esc(brand)}.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b0b0d;padding:28px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#15151a;border:1px solid #27272a;border-radius:16px;overflow:hidden;font-family:'Segoe UI',Roboto,Arial,sans-serif;">
          <tr><td style="padding:22px 28px;border-bottom:1px solid #27272a;">
            <span style="font-size:18px;font-weight:700;color:#f4f4f5;">BusinessCool <span style="color:#fbbf24;">AI</span></span>
          </td></tr>
          <tr><td style="padding:30px 28px 4px;">
            <h1 style="margin:0;font-size:24px;line-height:1.25;color:#f4f4f5;">Tienes ${tipo === 'contrato' ? 'un nuevo <span style="color:#fbbf24;">contrato</span>' : 'una nueva <span style="color:#fbbf24;">minuta</span>'}</h1>
            <p style="margin:12px 0 0;color:#a1a1aa;font-size:15px;line-height:1.6;">Hola ${name}, el equipo de <strong style="color:#e4e4e7;">${esc(brand)}</strong> ${tipo === 'contrato' ? 'te compartió un contrato' : 'publicó una minuta'}${company ? ` para <strong style="color:#e4e4e7;">${company}</strong>` : ''}. Ingresa a la plataforma para revisar${tipo === 'contrato' ? 'lo y firmarlo' : 'la'} con tu e.firma.</p>
          </td></tr>
          <tr><td style="padding:20px 28px 4px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f12;border:1px solid #3f3f46;border-radius:12px;">
              <tr><td style="padding:16px 18px;">
                <p style="margin:0 0 8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#71717a;">${Tipo}</p>
                <p style="margin:0;color:#f4f4f5;font-size:16px;font-weight:600;">${esc(title || Tipo)}</p>
              </td></tr>
            </table>
          </td></tr>
          <tr><td align="center" style="padding:24px 28px 6px;">
            <a href="${esc(loginUrl)}" style="display:inline-block;background:#fbbf24;color:#1c1c1f;font-weight:700;font-size:15px;text-decoration:none;padding:13px 30px;border-radius:10px;">Entrar a la plataforma</a>
          </td></tr>
          <tr><td style="padding:12px 28px 28px;">
            <p style="margin:0;color:#a1a1aa;font-size:13px;line-height:1.55;">Encontrarás el documento en <strong style="color:#e4e4e7;">Gestión de Minutas y Contratos</strong> dentro de tu proyecto.</p>
          </td></tr>
          <tr><td style="padding:18px 28px;border-top:1px solid #27272a;background:#101013;">
            <p style="margin:0;color:#71717a;font-size:12px;">${esc(brand)} · Soluciones en IA · <a href="https://businesscool.ai" style="color:#a1a1aa;text-decoration:none;">businesscool.ai</a></p>
            <p style="margin:6px 0 0;color:#52525b;font-size:11px;">Si no esperabas este correo, puedes ignorarlo.</p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;

  const text =
    `Hola ${displayName || to},\n\n` +
    `El equipo de ${brand} te compartió ${tipo === 'contrato' ? 'un contrato' : 'una minuta'}: "${title || Tipo}"${companyName ? ` (${companyName})` : ''}.\n\n` +
    `Ingresa a la plataforma para revisarlo: ${loginUrl}\n`;

  try {
    await transporter.sendMail({ from: config.smtp.from || config.smtp.user, to, subject, text, html });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail, sendDocumentEmail, smtpEnabled: () => config.smtp.enabled };
