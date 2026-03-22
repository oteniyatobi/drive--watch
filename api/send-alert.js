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

    const { to, driverName, mapsLink, time, isImpact } = req.body;

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

    const messageBody = isImpact
        ? `🚨 *HIGH IMPACT ACCIDENT DETECTED* 🚨\n\n` +
        `*DRIVER:* ${driverName || 'The Driver'}\n` +
        `*STATUS:* Driver involved in a high-G collision.\n` +
        `*TIME:* ${time || new Date().toLocaleTimeString()}\n\n` +
        `📍 *LIVE LOCATION:*\n${mapsLink || 'Location unavailable'}\n\n` +
        `Police and emergency contacts have been notified via voice.\n` +
        `_This is an automated alert from DriverWatch Enterprise._`

        : `🚨 *DRIVERWATCH EMERGENCY ALERT* 🚨\n\n` +
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

        if (isImpact) {
            const twiml = new twilio.twiml.VoiceResponse();
            twiml.say(
                `Emergency alert. This is an automated message from Driver Watch. ` +
                `${driverName || 'Your contact'} has been involved in a high impact accident at ${time || new Date().toLocaleTimeString()}. ` +
                `Please send immediate assistance to their location. Check your WhatsApp for GPS coordinates.`
            );

            // Clean police phone, fallback to emergency contact if no police env var
            const policeContact = process.env.TWILIO_POLICE_NUMBER || to;
            const cleanPolicePhone = policeContact.replace(/\D/g, '');
            const toPoliceVoice = `+${cleanPolicePhone}`;

            // Clean 'from' number (assuming TWILIO_WHATSAPP_FROM is set like whatsapp:+123456789)
            const fromVoice = process.env.TWILIO_PHONE_NUMBER || from.replace('whatsapp:', '');

            try {
                await client.calls.create({
                    twiml: twiml.toString(),
                    to: toPoliceVoice,
                    from: fromVoice,
                });
                console.log(`Voice call dispatched to ${toPoliceVoice}`);
            } catch (callErr) {
                console.error('Twilio Voice Error:', callErr);
            }
        }

        return res.status(200).json({ success: true, sid: message.sid });
    } catch (err) {
        console.error('Twilio Error:', err);
        return res.status(500).json({ error: err.message });
    }
};
