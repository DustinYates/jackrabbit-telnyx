/**
 * Jackrabbit Class Lookup Webhook for Telnyx Voice Agent
 * 
 * This webhook receives search criteria from the Telnyx voice agent,
 * queries Jackrabbit's public JSON API, filters results, and returns
 * matching classes with registration links.
 * 
 * Deploy this as a serverless function (Vercel, AWS Lambda, etc.)
 * or run it as a standalone Express server.
 */

const express = require('express');
const app = express();
app.use(express.json());

const JACKRABBIT_ORG_ID = '545911';
const JACKRABBIT_JSON_URL = `https://app.jackrabbitclass.com/jr3.0/Openings/OpeningsJson?OrgID=${JACKRABBIT_ORG_ID}`;

// Telnyx SMS setup
const TELNYX_API_KEY = process.env.TELNYX_API_KEY; // Set this in your environment!
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER; // Your Telnyx phone number

// ============================================================
// 1. Class Lookup Endpoint (called by Telnyx voice agent)
// ============================================================
app.post('/lookup', async (req, res) => {
  try {
    const { level, day, location, caller_phone } = req.body;

    // Fetch all classes from Jackrabbit
    const response = await fetch(JACKRABBIT_JSON_URL);
    const data = await response.json();
    let classes = data.rows || [];

    // Filter by level (e.g., "Adult Level 1", "Adult Level 2")
    if (level) {
      const levelLower = level.toLowerCase();
      classes = classes.filter(c =>
        c.category1?.toLowerCase().includes(levelLower) ||
        c.name?.toLowerCase().includes(levelLower)
      );
    }

    // Filter by day (e.g., "monday", "thu")
    if (day) {
      const dayMap = {
        'monday': 'mon', 'mon': 'mon',
        'tuesday': 'tue', 'tue': 'tue',
        'wednesday': 'wed', 'wed': 'wed',
        'thursday': 'thu', 'thu': 'thu',
        'friday': 'fri', 'fri': 'fri',
        'saturday': 'sat', 'sat': 'sat',
        'sunday': 'sun', 'sun': 'sun',
      };
      const dayKey = dayMap[day.toLowerCase()];
      if (dayKey) {
        classes = classes.filter(c => c.meeting_days?.[dayKey] === true);
      }
    }

    // Filter by location (e.g., "langham", "spring", "cypress")
    if (location) {
      const locLower = location.toLowerCase();
      classes = classes.filter(c =>
        c.location_name?.toLowerCase().includes(locLower) ||
        c.location_code?.toLowerCase().includes(locLower) ||
        c.room?.toLowerCase().includes(locLower)
      );
    }

    // Separate available vs waitlist
    const available = classes.filter(c => c.openings?.calculated_openings > 0);
    const waitlistOnly = classes.filter(c => c.openings?.calculated_openings === 0);

    // Build response for voice agent
    if (available.length === 0 && waitlistOnly.length === 0) {
      return res.json({
        found: false,
        message: "I couldn't find any classes matching that. Could you try a different day, level, or location?",
        classes: []
      });
    }

    // Format results for the voice agent to read
    const results = available.map(c => ({
      name: c.name,
      day: Object.entries(c.meeting_days).find(([_, v]) => v)?.[0] || 'TBD',
      time: formatTime(c.start_time) + ' - ' + formatTime(c.end_time),
      location: c.location_name,
      address: c.room,
      openings: c.openings.calculated_openings,
      tuition: '$' + c.tuition?.fee,
      registration_link: decodeHtml(c.online_reg_link),
    }));

    const waitlistResults = waitlistOnly.map(c => ({
      name: c.name,
      day: Object.entries(c.meeting_days).find(([_, v]) => v)?.[0] || 'TBD',
      time: formatTime(c.start_time) + ' - ' + formatTime(c.end_time),
      location: c.location_name,
      openings: 0,
      registration_link: decodeHtml(c.online_reg_link),
    }));

    // Build a speakable summary for the voice agent
    let speech = '';
    if (results.length > 0) {
      speech = `I found ${results.length} class${results.length > 1 ? 'es' : ''} with openings. `;
      results.slice(0, 3).forEach((r, i) => {
        speech += `Option ${i + 1}: ${r.name}, ${r.time} at ${r.location}, ${r.openings} spot${r.openings > 1 ? 's' : ''} available, ${r.tuition} per month. `;
      });
      if (results.length > 3) {
        speech += `Plus ${results.length - 3} more options. `;
      }
    }
    if (waitlistResults.length > 0 && results.length === 0) {
      speech += `The classes matching your search are currently full, but I can add you to the waitlist.`;
    }

    return res.json({
      found: true,
      message: speech,
      available_count: results.length,
      waitlist_count: waitlistResults.length,
      classes: results,
      waitlist_classes: waitlistResults,
    });

  } catch (err) {
    console.error('Lookup error:', err);
    return res.json({
      found: false,
      message: "I'm having trouble looking up classes right now. Let me transfer you to someone who can help.",
      error: err.message
    });
  }
});

// ============================================================
// 2. Send SMS Endpoint (voice agent triggers this to text a link)
//    Now supports pre-filling caller info into the registration form
// ============================================================
app.post('/send-link', async (req, res) => {
  try {
    const { to, class_name, registration_link, class_id, first_name, last_name, email } = req.body;

    if (!to) {
      return res.json({ success: false, message: 'Missing phone number' });
    }

    // Build pre-populated registration URL
    // Replace YOUR_DOMAIN with wherever you host register.html
    const WRAPPER_BASE = process.env.WRAPPER_URL || 'https://YOUR-DOMAIN.com/register.html';
    
    const prefillParams = new URLSearchParams({
      classId: class_id || extractClassId(registration_link) || '',
      org: JACKRABBIT_ORG_ID,
      phone: to,
      ...(first_name && { first: first_name }),
      ...(last_name && { last: last_name }),
      ...(email && { email: email }),
    });

    const prefillLink = `${WRAPPER_BASE}?${prefillParams.toString()}`;

    const smsResponse = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: TELNYX_FROM_NUMBER,
        to: to,
        text: `Here's your registration link for ${class_name || 'your class'}:\n\n${prefillLink}\n\nYour name and phone will be pre-filled — just add payment info and submit!`,
      }),
    });

    const smsData = await smsResponse.json();

    return res.json({
      success: true,
      message: `Registration link sent to ${to}`,
      prefill_link: prefillLink,
      sms_id: smsData.data?.id
    });

  } catch (err) {
    console.error('SMS error:', err);
    return res.json({ success: false, message: 'Failed to send SMS' });
  }
});

// ============================================================
// 3. Get All Locations (useful for voice agent prompts)
// ============================================================
app.get('/locations', async (req, res) => {
  try {
    const response = await fetch(JACKRABBIT_JSON_URL);
    const data = await response.json();
    const classes = data.rows || [];

    const locations = [...new Set(classes.map(c => c.location_name))].filter(Boolean);

    return res.json({ locations });
  } catch (err) {
    return res.json({ locations: [], error: err.message });
  }
});

// ============================================================
// Helpers
// ============================================================
function formatTime(time24) {
  if (!time24) return 'TBD';
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, '0')} ${period}`;
}

function decodeHtml(str) {
  if (!str) return '';
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function extractClassId(url) {
  if (!url) return '';
  const match = url.match(/preLoadClassID=(\d+)/);
  return match ? match[1] : '';
}

// ============================================================
// Start server
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Jackrabbit webhook running on port ${PORT}`);
});
