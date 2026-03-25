// ==========================================
// DRIVERWATCH - VERCEL SERVERLESS FUNCTION
// POST /api/send-alert — Twilio WhatsApp (+ optional voice on impact)
// alertType: "drowsy" | "impact" | "speeding"
// ==========================================

const twilio = require('twilio');

function normalizeAlertType(body) {
    const raw = (body.alertType || '').toLowerCase();
    if (raw === 'impact' || raw === 'collision') return 'impact';
    if (raw === 'speeding' || raw === 'speed') return 'speeding';
    if (raw === 'drowsy' || raw === 'unresponsive' || raw === 'fatigue') return 'drowsy';
    if (body.isImpact === true) return 'impact';
    return 'drowsy';
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const {
        to,
        driverName,
        mapsLink,
        time,
        isImpact,
        speedKmh,
        speedLimitKmh
    } = req.body;

    const alertType = normalizeAlertType(req.body);

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

    const cleanPhone = to.replace(/\D/g, '');
    const toWhatsApp = `whatsapp:+${cleanPhone}`;
    const who = driverName || 'The driver';
    const when = time || new Date().toLocaleString();
    const loc = mapsLink || 'Location unavailable';
    const spd = speedKmh != null ? String(speedKmh) : null;
    const lim = speedLimitKmh != null ? String(speedLimitKmh) : null;

    let messageBody;

    if (alertType === 'impact') {
        messageBody =
            `🚨 *DRIVERWATCH — POSSIBLE COLLISION / HIGH IMPACT* 🚨\n\n` +
            `*Driver:* ${who}\n` +
            `*Trigger:* Sudden acceleration / motion consistent with a crash (phone sensor).\n` +
            `*Time:* ${when}\n\n` +
            `📍 *Last known position (maps):*\n${loc}\n\n` +
            `*Action:* Try to call the driver now. If no answer, contact emergency services and share this location.\n` +
            `_Automated message from DriverWatch._`;
    } else if (alertType === 'speeding') {
        const speedLine = spd && lim
            ? `Reported speed about *${spd} km/h* vs posted limit *${lim} km/h*.`
            : `The vehicle may be over the posted speed limit for this road.`;
        messageBody =
            `⚠️ *DRIVERWATCH — SPEED ADVISORY* ⚠️\n\n` +
            `*Driver:* ${who}\n` +
            `${speedLine}\n` +
            `*Time:* ${when}\n\n` +
            `📍 *Approximate location:*\n${loc}\n\n` +
            `This is not a crash alert. Please message or call the driver to slow down.\n` +
            `_Automated message from DriverWatch._`;
    } else {
        messageBody =
            `🚨 *DRIVERWATCH — DRIVER UNRESPONSIVE (AI / FATIGUE)* 🚨\n\n` +
            `*Driver:* ${who}\n` +
            `*Trigger:* Cabin camera indicates the driver may be drowsy or not responding; fatigued-driver workflow was triggered.\n` +
            `*Time:* ${when}\n\n` +
            `📍 *Last known position:*\n${loc}\n\n` +
            `*Action:* Call the driver immediately. If they do not answer, consider contacting emergency services.\n` +
            `_Automated message from DriverWatch._`;
    }

    try {
        const client = twilio(accountSid, authToken);
        const message = await client.messages.create({
            from,
            to: toWhatsApp,
            body: messageBody,
        });

        console.log(`WhatsApp alert sent (${alertType}). SID: ${message.sid}`);

        const doVoice = alertType === 'impact' || isImpact === true;
        if (doVoice) {
            const twiml = new twilio.twiml.VoiceResponse();
            twiml.say(
                `Driver Watch collision alert. ${who} may have been involved in a serious impact at ${when}. ` +
                `Check your WhatsApp for a map link and try to reach them or emergency services.`
            );

            const policeContact = process.env.TWILIO_POLICE_NUMBER || to;
            const cleanPolicePhone = policeContact.replace(/\D/g, '');
            const toPoliceVoice = `+${cleanPolicePhone}`;
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

        return res.status(200).json({ success: true, sid: message.sid, alertType });
    } catch (err) {
        console.error('Twilio Error:', err);
        return res.status(500).json({ error: err.message });
    }
};
