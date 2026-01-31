/**
 * Jackrabbit + Telnyx Integration Server
 * 
 * Everything flows from OrgID. One deployment serves all franchises.
 * 
 * OrgID=545911
 *   → OpeningsJson?OrgID=545911   (class data)
 *   → regv2.asp?id=545911         (registration form)
 * 
 * Endpoints:
 *   GET  /classes/:orgId           — Browse classes (JSON)
 *   POST /lookup                   — Voice/chat agent class search
 *   POST /send-link                — Text pre-filled registration link
 *   GET  /register/:orgId/:classId — Pre-filled Jackrabbit form proxy
 */

const express = require('express');
const app = express();
app.use(express.json());

const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ============================================================
// Helper: Fetch classes for any franchise by OrgID
// ============================================================
async function getClasses(orgId) {
  const url = `https://app.jackrabbitclass.com/jr3.0/Openings/OpeningsJson?OrgID=${orgId}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.rows || [];
}

function filterClasses(classes, { level, day, location, time } = {}) {
  let filtered = [...classes];

  if (level) {
    const l = level.toLowerCase();
    filtered = filtered.filter(c =>
      c.category1?.toLowerCase().includes(l) ||
      c.name?.toLowerCase().includes(l)
    );
  }

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
      filtered = filtered.filter(c => c.meeting_days?.[dayKey] === true);
    }
  }

  if (location) {
    const loc = location.toLowerCase();
    filtered = filtered.filter(c =>
      c.location_name?.toLowerCase().includes(loc) ||
      c.location_code?.toLowerCase().includes(loc) ||
      c.room?.toLowerCase().includes(loc)
    );
  }

  if (time) {
    const t = time.toLowerCase();
    filtered = filtered.filter(c => {
      const hour = parseInt(c.start_time?.split(':')[0] || '0');
      if (t === 'morning') return hour < 12;
      if (t === 'afternoon') return hour >= 12 && hour < 17;
      if (t === 'evening') return hour >= 17;
      return true;
    });
  }

  return filtered;
}

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

function formatClassResult(c) {
  return {
    name: c.name,
    class_id: String(c.id),
    category: c.category1,
    day: Object.entries(c.meeting_days).find(([_, v]) => v)?.[0] || 'TBD',
    time: formatTime(c.start_time) + ' - ' + formatTime(c.end_time),
    location: c.location_name,
    location_code: c.location_code,
    address: c.room,
    openings: c.openings?.calculated_openings || 0,
    waitlist: c.waitlist || false,
    tuition: '$' + (c.tuition?.fee || 0),
    registration_link: decodeHtml(c.online_reg_link),
  };
}


// ============================================================
// 1. GET /classes/:orgId — Browse all classes for a franchise
// ============================================================
app.get('/classes/:orgId', async (req, res) => {
  try {
    const classes = await getClasses(req.params.orgId);
    const { level, day, location, time } = req.query;

    const filtered = filterClasses(classes, { level, day, location, time });
    const available = filtered.filter(c => c.openings?.calculated_openings > 0);
    const waitlist = filtered.filter(c => c.openings?.calculated_openings === 0);

    // Get unique locations and categories for this franchise
    const locations = [...new Set(classes.map(c => c.location_name))].filter(Boolean);
    const categories = [...new Set(classes.map(c => c.category1))].filter(Boolean);

    return res.json({
      org_id: req.params.orgId,
      total_classes: classes.length,
      filtered: filtered.length,
      available_count: available.length,
      waitlist_count: waitlist.length,
      locations,
      categories,
      available: available.map(formatClassResult),
      waitlist: waitlist.map(formatClassResult),
    });
  } catch (err) {
    return res.json({ error: err.message });
  }
});


// ============================================================
// 2. POST /lookup — Voice/chat agent class search
// ============================================================
app.post('/lookup', async (req, res) => {
  try {
    const { org_id, level, day, location, time } = req.body;
    const orgId = org_id || '545911';

    const classes = await getClasses(orgId);
    const filtered = filterClasses(classes, { level, day, location, time });

    const available = filtered.filter(c => c.openings?.calculated_openings > 0);
    const waitlistOnly = filtered.filter(c => c.openings?.calculated_openings === 0);

    if (available.length === 0 && waitlistOnly.length === 0) {
      // Suggest what IS available
      const locations = [...new Set(classes.map(c => c.location_name))].filter(Boolean);
      return res.json({
        found: false,
        message: "I couldn't find classes matching that. Could you try a different day, level, or location?",
        available_locations: locations,
        classes: []
      });
    }

    const results = available.map(formatClassResult);

    let speech = '';
    if (results.length > 0) {
      speech = `I found ${results.length} class${results.length > 1 ? 'es' : ''} with openings. `;
      results.slice(0, 3).forEach((r, i) => {
        speech += `Option ${i + 1}: ${r.name}, ${r.time} at ${r.location}, ${r.openings} spot${r.openings > 1 ? 's' : ''} open, ${r.tuition} per month. `;
      });
      if (results.length > 3) speech += `Plus ${results.length - 3} more. `;
    }
    if (waitlistOnly.length > 0 && results.length === 0) {
      speech += `Those classes are full, but I can add you to the waitlist.`;
    }

    return res.json({
      found: true,
      org_id: orgId,
      message: speech,
      available_count: results.length,
      waitlist_count: waitlistOnly.length,
      classes: results,
    });

  } catch (err) {
    return res.json({
      found: false,
      message: "I'm having trouble looking up classes right now.",
      error: err.message
    });
  }
});


// ============================================================
// 3. POST /send-link — Build a pre-filled registration link
//    Returns the URL only. The AI assistant uses the built-in
//    Send Message tool to text it to the caller.
// ============================================================
app.post('/send-link', async (req, res) => {
  try {
    const {
      to,
      org_id = '545911',
      class_name,
      class_id,
      first_name,
      last_name,
      email,
      students, // [{ first, last, gender, bdate, class_id }]
    } = req.body;

    // Build pre-filled registration URL
    const params = new URLSearchParams();
    if (first_name) params.set('first', first_name);
    if (last_name) params.set('last', last_name);
    if (to) params.set('phone', to);
    if (email) params.set('email', email);

    // Handle students
    if (students && Array.isArray(students)) {
      students.forEach((s, i) => {
        const idx = i + 1;
        if (s.first) params.set(`s${idx}first`, s.first);
        if (s.last) params.set(`s${idx}last`, s.last);
        if (s.gender) params.set(`s${idx}gender`, s.gender);
        if (s.bdate) params.set(`s${idx}bdate`, s.bdate);
        if (s.class_id) params.set(`s${idx}class`, s.class_id);
      });
    }

    const useClassId = class_id || (students?.[0]?.class_id) || '';
    const prefillLink = `${BASE_URL}/register/${org_id}/${useClassId}?${params.toString()}`;

    return res.json({
      success: true,
      registration_url: prefillLink,
      class_name: class_name || 'British Swim School',
      message: `Here's your registration link for ${class_name || 'British Swim School'}:\n\n${prefillLink}\n\nYour info is pre-filled — just add payment and submit!`
    });

  } catch (err) {
    return res.json({ success: false, message: 'Failed to build registration link', error: err.message });
  }
});


// ============================================================
// 4. GET /register/:orgId/:classId — Pre-filled form proxy
// ============================================================
app.get('/register/:orgId/:classId', async (req, res) => {
  try {
    const { orgId, classId } = req.params;
    const wl = req.query.wl || '0';

    // Build Jackrabbit form URL
    const jrUrl = `https://app.jackrabbitclass.com/regv2.asp?id=${orgId}&hc=&initEmpty=&hdrColor=&WL=${wl}&preLoadClassID=${classId}&loc=`;

    // Fetch the form HTML
    const response = await fetch(jrUrl);
    const html = await response.text();

    // Map URL params to Jackrabbit field names
    const fieldMap = {
      // Family
      last:        'FamName',
      address:     'Addr',
      city:        'City',
      state:       'State',
      zip:         'Zip',
      phone:       'HPhone',
      // Contact #1
      first:       'MFName',
      clast:       'MLName',
      email:       'MEmail',
      cell:        'MCPhone',
      contactType: 'PG1Type',
      // Contact #2
      c2first:     'FFName',
      c2last:      'FLName',
      c2email:     'FEmail',
      c2cell:      'FCPhone',
      c2type:      'PG2Type',
      // Referral
      source:      'FamSource',
      referral:    'ReferralName',
    };

    // Build prefill data from URL params
    const prefillData = {};

    for (const [param, field] of Object.entries(fieldMap)) {
      const val = req.query[param];
      if (val) {
        prefillData[field] = val;
        // Auto-fill confirm fields
        if (field === 'MEmail') prefillData['ConfirmMEmail'] = val;
        if (field === 'FEmail') prefillData['ConfirmFEmail'] = val;
      }
    }

    // Default: contact last name = family name
    if (!prefillData['MLName'] && prefillData['FamName']) {
      prefillData['MLName'] = prefillData['FamName'];
    }
    // Default: cell = primary phone
    if (!prefillData['MCPhone'] && prefillData['HPhone']) {
      prefillData['MCPhone'] = prefillData['HPhone'];
    }

    // Students (s1-s5)
    for (let i = 1; i <= 5; i++) {
      const sFirst = req.query[`s${i}first`];
      const sLast = req.query[`s${i}last`];
      if (sFirst || sLast) {
        if (sFirst) prefillData[`S${i}FName`] = sFirst;
        prefillData[`S${i}LName`] = sLast || prefillData['FamName'] || '';
        if (req.query[`s${i}gender`]) prefillData[`S${i}Gender`] = req.query[`s${i}gender`];
        if (req.query[`s${i}bdate`]) prefillData[`S${i}BDate`] = req.query[`s${i}bdate`];
        if (req.query[`s${i}promo`]) prefillData[`S${i}_UField1`] = req.query[`s${i}promo`];
      }
    }

    // Build injection script
    const prefillScript = `
    <script>
    (function() {
      var data = ${JSON.stringify(prefillData)};
      
      function fill() {
        var filled = [];
        for (var name in data) {
          var val = data[name];
          var el = document.querySelector('[name="' + name + '"]') || document.getElementById(name);
          if (!el) continue;
          
          if (el.tagName === 'SELECT') {
            var opts = Array.from(el.options);
            var match = opts.find(function(o) {
              return o.value.toLowerCase() === val.toLowerCase() || 
                     o.text.toLowerCase() === val.toLowerCase();
            });
            if (match) {
              el.value = match.value;
              el.dispatchEvent(new Event('change', { bubbles: true }));
              filled.push(name);
            }
          } else {
            el.value = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            filled.push(name);
          }
        }
        
        // Add pre-fill banner
        var banner = document.createElement('div');
        banner.style.cssText = 'background:#e8f5e9;border:2px solid #4caf50;border-radius:8px;padding:16px;margin:16px;font-family:Arial;font-size:14px;text-align:center;';
        banner.innerHTML = '<strong style="color:#2e7d32;">✅ Your information has been pre-filled!</strong><br>' +
          'Please review everything below, then scroll down to add payment details and submit.<br>' +
          '<small style="color:#666;">' + filled.length + ' fields filled automatically</small>';
        var form = document.querySelector('form') || document.body;
        form.insertBefore(banner, form.firstChild);
        
        // Highlight pre-filled fields with subtle green border
        filled.forEach(function(name) {
          var el = document.querySelector('[name="' + name + '"]') || document.getElementById(name);
          if (el) el.style.borderColor = '#4caf50';
        });
      }
      
      if (document.readyState === 'complete' || document.readyState === 'interactive') {
        setTimeout(fill, 500);
      } else {
        window.addEventListener('DOMContentLoaded', function() { setTimeout(fill, 500); });
      }
    })();
    </script>`;

    // Inject before </body>
    const modifiedHtml = html.replace('</body>', prefillScript + '\n</body>');

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(modifiedHtml);

  } catch (err) {
    console.error('Registration proxy error:', err);
    // Fallback: redirect to plain Jackrabbit form
    res.redirect(`https://app.jackrabbitclass.com/regv2.asp?id=${req.params.orgId}&hc=&initEmpty=&hdrColor=&WL=0&preLoadClassID=${req.params.classId}&loc=`);
  }
});


// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  Browse classes:  GET  ${BASE_URL}/classes/:orgId`);
  console.log(`  Search classes:  POST ${BASE_URL}/lookup`);
  console.log(`  Send link:       POST ${BASE_URL}/send-link`);
  console.log(`  Pre-fill form:   GET  ${BASE_URL}/register/:orgId/:classId?first=...&last=...`);
  console.log('');
  console.log('Example:');
  console.log(`  ${BASE_URL}/register/545911/16887507?first=Jane&last=Smith&phone=8325551234&email=jane@test.com&s1first=Emma&s1last=Smith&s1gender=Female&s1bdate=01/15/2019`);
});
