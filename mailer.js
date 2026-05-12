const nodemailer = require('nodemailer');
const db = require('./db');

function getSmtpConfig() {
  const host = db.prepare("SELECT value FROM settings WHERE key = 'smtp_host'").get()?.value;
  const port = db.prepare("SELECT value FROM settings WHERE key = 'smtp_port'").get()?.value;
  const user = db.prepare("SELECT value FROM settings WHERE key = 'smtp_user'").get()?.value;
  const pass = db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get()?.value;

  if (!host || !port || !user || !pass) return null;
  return { host, port: parseInt(port, 10), user, pass };
}

async function sendEmail(to, subject, text) {
  const config = getSmtpConfig();
  
  if (!config) {
    console.log(`[Mailer - MOCK] Would send email to ${to}: ${subject}`);
    return;
  }

  try {
    let transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465, // true for 465, false for other ports
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    await transporter.sendMail({
      from: `"Ekkoscope" <${config.user}>`,
      to: to,
      subject: subject,
      text: text,
    });
    console.log(`[Mailer] Email sent to ${to}`);
  } catch (error) {
    console.error(`[Mailer] Failed to send email to ${to}:`, error.message);
  }
}

module.exports = { sendEmail };
