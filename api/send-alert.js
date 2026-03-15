// [DEPLOYMENT REFRESH] Triggering new build to pick up Vercel environment variables.
// ==========================================
// DRIVERWATCH - VERCEL SERVERLESS FUNCTION
// POST /api/send-alert
// Sends a WhatsApp message via Twilio to the
// driver's emergency contact. Credentials
// are kept server-side and never exposed.
// ==========================================

const twilio = require('twilio');

module.exports = async (req, res) => {
    // Only allow POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { to, driverName, mapsLink, time } = req.body;

    if (!to) {
        return res.status(400).json({ error: 'Missing emergency contact phone number.' });
    }

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_WHATSAPP_FROM;

    const missing = [];
    if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
    if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
    if (!from) missing.push('TWILIO_WHATSAPP_FROM');

    if (missing.length > 0) {
        return res.status(500).json({ error: `Missing Vercel Environment Variables: ${missing.join(', ')}` });
    }

    // Strip non-digits from phone number, add whatsapp: prefix
    const cleanPhone = to.replace(/\D/g, '');
    const toWhatsApp = `whatsapp:+${cleanPhone}`;

    const messageBody =
        `🚨 *DRIVERWATCH EMERGENCY ALERT* 🚨\n\n` +
        `*DRIVER:* ${driverName || 'The Driver'}\n` +
        `*STATUS:* Driver detected as UNRESPONSIVE by AI safety system.\n` +
        `*TIME:* ${time || new Date().toLocaleTimeString()}\n\n` +
        `📍 *LIVE LOCATION:*\n${mapsLink || 'Location unavailable'}\n\n` +
        `Please call the driver immediately or contact emergency services.\n` +
        `_This is an automated alert from DriverWatch Enterprise Safety System._`;

    try {
        const client = twilio(accountSid, authToken);
        const message = await client.messages.create({
            from,
            to: toWhatsApp,
            body: messageBody,
        });

        console.log(`WhatsApp alert sent. SID: ${message.sid}`);
        return res.status(200).json({ success: true, sid: message.sid });
    } catch (err) {
        console.error('Twilio Error:', err);
        return res.status(500).json({ error: err.message });
    }
};
