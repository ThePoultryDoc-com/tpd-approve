const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const { google } = require('googleapis');
const { Readable } = require('stream');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.json({ limit: '5mb' }));

// Webhook URLs per zap
const WEBHOOKS = {
  '9b':  process.env.ZAP_9B_WEBHOOK  || 'https://hooks.zapier.com/hooks/catch/25149853/u75wiuk/',
  '10b': process.env.ZAP_10B_WEBHOOK || 'https://hooks.zapier.com/hooks/catch/25149853/ujis74a/',
  '1b':  process.env.ZAP_1B_WEBHOOK  || 'https://hooks.zapier.com/hooks/catch/25149853/uvbkrhj/'
};

// --- Attachment upload (Drive via service account) ----------------------
// Vets attach a file on the /edit page. We hold it in memory (no disk write
// on Railway's ephemeral filesystem), push it to a shared Drive folder using
// a service account, and forward the resulting shareable link to Zapier
// instead of raw bytes (webhook payload is a URL-encoded query string and
// can't carry binary content).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB cap per TPD's stated attachment sizes
});

const ATTACHMENTS_FOLDER_ID = process.env.ATTACHMENTS_FOLDER_ID || '10u-k4lYwOH5nn9cWiklkSc1FFXSCzn06'; // "Email Attachments" folder inside the Business Ops Shared Drive

let driveClient = null;
function getDriveClient() {
  if (driveClient) return driveClient;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!rawKey) {
    console.warn('GOOGLE_SERVICE_ACCOUNT_KEY not set — attachment upload is disabled.');
    return null;
  }
  let credentials;
  try {
    credentials = JSON.parse(rawKey);
  } catch (e) {
    console.error('GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON:', e.message);
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/drive.file']
  });
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

// Uploads a single multer file buffer to the shared Drive folder and returns
// a shareable link. Throws on failure — callers decide how to degrade.
async function uploadAttachmentToDrive(file) {
  const drive = getDriveClient();
  if (!drive) throw new Error('Drive client not configured (missing service account key)');

  const fileMetadata = {
    name: file.originalname,
    parents: [ATTACHMENTS_FOLDER_ID]
  };
  const media = {
    mimeType: file.mimetype,
    body: Readable.from(file.buffer)
  };

  const created = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink, webContentLink',
    supportsAllDrives: true
  });

  const fileId = created.data.id;

  // Make it readable via link so Zapier's "Download File" step (unauthenticated
  // fetch) can retrieve it. Folder-level sharing with the service account only
  // covers write access for the service account itself, not read access for
  // arbitrary link visitors, so this per-file permission is still required.
  await drive.permissions.create({
    fileId,
    requestBody: { role: 'reader', type: 'anyone' },
    supportsAllDrives: true
  });

  // webContentLink is a direct-download URL — what we want for Zapier to fetch
  // raw bytes. Fall back to constructing it if the API didn't return one.
  const downloadUrl = created.data.webContentLink
    || `https://drive.google.com/uc?id=${fileId}&export=download`;

  return {
    id: fileId,
    name: created.data.name,
    url: downloadUrl,
    viewUrl: created.data.webViewLink
  };
}

// --- Approval locking (Postgres) ---------------------------------------
// Railway's Postgres plugin injects DATABASE_URL automatically once the
// plugin is attached to this service. Locally / without a DB attached,
// pool is null and locking is skipped (fails open) so the app still runs.
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

if (!pool) {
  console.warn('DATABASE_URL not set — approval locking is disabled (links will not be locked after use).');
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS approvals (
      approval_id   TEXT PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'pending',
      sender_email  TEXT,
      sender_name   TEXT,
      subject       TEXT,
      approved_at   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
ensureSchema().catch(err => console.error('Failed to initialize approvals table:', err));

// Returns { status: 'pending' | 'approved', approved_at } or
// { status: 'pending' } when locking is disabled (no DB attached).
async function getApprovalStatus(approvalId) {
  if (!pool || !approvalId) return { status: 'pending' };
  const { rows } = await pool.query(
    'SELECT status, approved_at FROM approvals WHERE approval_id = $1',
    [approvalId]
  );
  if (!rows.length) return { status: 'pending' };
  return { status: rows[0].status, approved_at: rows[0].approved_at };
}

// Atomically claims the approval_id for sending. Returns true if this call
// won the race (first send) and false if it was already approved.
// Uses an upsert with a WHERE guard so two simultaneous clicks can't both win.
async function claimApproval(approvalId, meta) {
  if (!pool || !approvalId) return true; // fail open when locking is disabled
  const { sender_email, sender_name, subject } = meta || {};
  const result = await pool.query(
    `INSERT INTO approvals (approval_id, status, sender_email, sender_name, subject, approved_at)
     VALUES ($1, 'approved', $2, $3, $4, now())
     ON CONFLICT (approval_id)
       DO UPDATE SET status = 'approved', approved_at = now()
       WHERE approvals.status <> 'approved'
     RETURNING approval_id`,
    [approvalId, sender_email || null, sender_name || null, subject || null]
  );
  return result.rowCount > 0;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Derive a short, action-oriented button label from a URL by inspecting host + path keywords.
// Used as a fallback when the draft does not provide an explicit [Label](URL) markdown link.
function labelForUrl(url) {
  const u = String(url || '').toLowerCase();
  if (/book|appointment|consult|schedule|calendly|cal\.com|acuity|calendar\.google/.test(u)) return 'Book a Consultation';
  if (/checkout|stripe|invoice|pay(?!\w)|payment/.test(u)) return 'Complete Payment';
  if (/founding-feather|membership|subscribe|signup|newsletter/.test(u)) return 'Join / Subscribe';
  if (/intake|questionnaire|form|survey|typeform|google\.com\/forms/.test(u)) return 'Complete Form';
  if (/zoom\.us|meet\.google|teams\.microsoft|webex/.test(u)) return 'Join Meeting';
  if (/youtu|vimeo|video/.test(u)) return 'Watch Video';
  if (/\.pdf(\?|$)|drive\.google|docs\.google|onedrive|dropbox/.test(u)) return 'View Document';
  if (/thepoultrydoc\.com\/?$/.test(u)) return 'Visit The Poultry Doc';
  return 'Open Link';
}

// Convert plain text draft to HTML for TinyMCE
// Also converts bare URLs into centered TPD-styled buttons
function draftToHtml(draft) {
  if (!draft) return '';

  // Strip bold formatting (HTML tags and markdown) so the salutation is never bolded.
  // Conservative: only targets <strong>/<b> and **...** / __...__ -- leaves italics alone.
  draft = draft
    .replace(/<\/?(strong|b|a)(\s[^>]*)?>/gi, '')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/__([\s\S]*?)__/g, '$1');

    // Markdown action links: [Label](https://url) -> isolate onto their own paragraph
    // using a BTN::: marker that the paragraph renderer below detects to build a styled button.
    draft = draft.replace(/\[([^\]\n]+?)\]\((https?:\/\/[^\s)]+)\)/g, function(_m, label, url) {
          return '\n\nBTN:::' + label.trim() + ':::' + url.trim() + '\n\n';
        });

  // If it already looks like HTML, return as-is
  if (/<\s*(p|div|ul|ol|li|table|tr|td|blockquote|h[1-6])(\s|>|\/)/i.test(draft)) return draft;
  // URL regex
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;

  // Normalize: if no newlines exist, split on sentence-ending punctuation
  // followed by a space and a capital letter (paragraph boundaries)
  let normalized = draft;
    // Always isolate bare URLs onto their own paragraph so they render as buttons
  normalized = normalized.replace(/[^\S\n]+(https?:\/\/[^\s]+)/g, '\n\n$1');
  normalized = normalized.replace(/(https?:\/\/[^\s]+)[^\S\n]+(\S)/g, '$1\n\n$2');
  if (!normalized.includes('\n')) {
    // Insert double newline before greeting-like splits and paragraph starters
    normalized = normalized
      // Split before URLs that appear mid-sentence after a space
      .replace(/ (https?:\/\/)/g, '\n\n$1')
      // Split at sentence end followed by space + capital (new sentence/paragraph)
      .replace(/([.!?])\s+([A-Z])/g, '$1\n\n$2')
      // Split before closing salutations
      .replace(/\s+(Warm regards|Best regards|Sincerely|Thank you,|Best,|Regards,)/g, '\n\n$1');
  }

  // Split into paragraphs on double newlines
  const paragraphs = normalized.split(/\n{2,}/);

  return paragraphs.map(para => {
    const trimmed = para.trim();
    if (!trimmed) return '';

    // Check for explicit BTN:::Label:::URL marker (from [Label](URL) markdown)
    const btnMatch = trimmed.match(/^BTN:::(.+?):::(https?:\/\/\S+)$/);
    if (btnMatch) {
      const btnLabel = btnMatch[1].trim();
      const btnUrl = btnMatch[2].trim();
      return `<p style="text-align:center;margin:20px 0;">
        <a href="${btnUrl}" target="_blank"
           style="display:inline-block;background:#01696F;color:#ffffff;
                  padding:12px 28px;border-radius:6px;text-decoration:none;
                  font-family:Georgia,serif;font-size:15px;font-weight:700;">
          ${btnLabel}</a></p>`;
    }

    // Check if the entire paragraph is just a URL
    if (/^https?:\/\/[^\s]+$/.test(trimmed)) {
      return `<p style="text-align:center;margin:20px 0;">` +
        `<a href="${trimmed}" target="_blank" ` +
        `style="display:inline-block;background:#01696F;color:#ffffff;` +
        `padding:12px 28px;border-radius:6px;text-decoration:none;` +
        `font-family:Georgia,serif;font-size:15px;font-weight:700;">` +
        `${labelForUrl(trimmed)}</a></p>`;
    }
    // Otherwise wrap in <p> and linkify any inline URLs
    const linked = trimmed
      .replace(/\n/g, '<br>')
      .replace(urlRegex, (url) =>
        `<a href="${url}" target="_blank" style="color:#01696F;">${url}</a>`
      );
    return `<p style="margin:0 0 16px;">${linked}</p>`;
  }).filter(Boolean).join('\n');
}

const CONFIRMATION_HTML = (sender_name, sender_email, subject, warning = '') => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Approved - The Poultry Doc</title>
  <style>
    body{margin:0;background:#f0f4f4;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:480px;width:90%;overflow:hidden}
    .hdr{background:#01696F;padding:28px;text-align:center}
    .hdr img{max-width:180px;display:block;margin:0 auto 10px}
    .hdr p{color:rgba(255,255,255,.85);margin:0;font-size:13px}
    .div{background:#F5C842;height:4px}
    .bod{padding:36px;text-align:center}
    .ic{font-size:52px;color:#01696F;margin-bottom:12px}
    h2{color:#01696F;margin:0 0 10px;font-size:21px}
    p{color:#555;font-size:14px;line-height:1.6;margin:0}
    .detail{background:#f0f7f7;border-radius:6px;padding:16px;margin-top:20px;text-align:left;font-size:14px;color:#444}
    .detail strong{color:#01696F}
    .ftr{background:#01696F;padding:14px;text-align:center}
    .ftr p{color:rgba(255,255,255,.7);font-size:12px;margin:0}
    .ftr a{color:#F5C842;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="hdr">
      <img src="https://thepoultrydoc.wpenginepowered.com/wp-content/uploads/2026/04/TPD-new-logo-lg-ctp-1.png" alt="The Poultry Doc">
      <p>Veterinary Consultation for Backyard Flocks</p>
    </div>
    <div class="div"></div>
    <div class="bod">
      <div class="ic">&#10003;</div>
      <h2>Response Sent</h2>
      <p>Your response has been sent to the client.</p>
      <div class="detail">
        <strong>Sent to:</strong> ${escapeHtml(sender_name || sender_email)} &lt;${escapeHtml(sender_email)}&gt;<br>
        <strong>Subject:</strong> ${escapeHtml(subject || '')}
      </div>
      ${warning ? `<p style="margin-top:16px;color:#a15c00;font-size:13px;">${escapeHtml(warning)}</p>` : ''}
    </div>
    <div class="ftr"><p>The Poultry Doc &mdash; <a href="https://www.thepoultrydoc.com">www.thepoultrydoc.com</a></p></div>
  </div>
</body>
</html>`;

// Shown when a link is reopened after it has already been used to send.
const ALREADY_APPROVED_HTML = (sender_name, sender_email, subject, approvedAt) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Already Sent - The Poultry Doc</title>
  <style>
    body{margin:0;background:#f0f4f4;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:480px;width:90%;overflow:hidden}
    .hdr{background:#01696F;padding:28px;text-align:center}
    .hdr img{max-width:180px;display:block;margin:0 auto 10px}
    .hdr p{color:rgba(255,255,255,.85);margin:0;font-size:13px}
    .div{background:#F5C842;height:4px}
    .bod{padding:36px;text-align:center}
    .ic{font-size:52px;color:#888;margin-bottom:12px}
    h2{color:#01696F;margin:0 0 10px;font-size:21px}
    p{color:#555;font-size:14px;line-height:1.6;margin:0}
    .detail{background:#f0f7f7;border-radius:6px;padding:16px;margin-top:20px;text-align:left;font-size:14px;color:#444}
    .detail strong{color:#01696F}
    .ftr{background:#01696F;padding:14px;text-align:center}
    .ftr p{color:rgba(255,255,255,.7);font-size:12px;margin:0}
    .ftr a{color:#F5C842;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="hdr">
      <img src="https://thepoultrydoc.wpenginepowered.com/wp-content/uploads/2026/04/TPD-new-logo-lg-ctp-1.png" alt="The Poultry Doc">
      <p>Veterinary Consultation for Backyard Flocks</p>
    </div>
    <div class="div"></div>
    <div class="bod">
      <div class="ic">&#128274;</div>
      <h2>Already Sent</h2>
      <p>This response was already approved and sent. This link has been used and can't be actioned again.</p>
      <div class="detail">
        <strong>Sent to:</strong> ${escapeHtml(sender_name || sender_email)} &lt;${escapeHtml(sender_email)}&gt;<br>
        <strong>Subject:</strong> ${escapeHtml(subject || '')}<br>
        ${approvedAt ? `<strong>Sent at:</strong> ${escapeHtml(new Date(approvedAt).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }))} CT` : ''}
      </div>
    </div>
    <div class="ftr"><p>The Poultry Doc &mdash; <a href="https://www.thepoultrydoc.com">www.thepoultrydoc.com</a></p></div>
  </div>
</body>
</html>`;

app.get('/', (req, res) => {
  res.send('TPD Approve is running.');
});

// Approve -- show confirmation page (prevents email scanner double-fire)
app.get('/approve', async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, cc, bcc } = req.query;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid link</h2>');
  }

  const existing = await getApprovalStatus(approval_id).catch(() => ({ status: 'pending' }));
  if (existing.status === 'approved') {
    return res.send(ALREADY_APPROVED_HTML(sender_name, sender_email, subject, existing.approved_at));
  }

  // Hidden inputs for everything EXCEPT cc/bcc (those become visible text inputs)
  const hiddenInputs = Object.entries(req.query)
    .filter(([k]) => k !== 'cc' && k !== 'bcc')
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('\n    ');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Approval - The Poultry Doc</title>
  <style>
    body{margin:0;background:#f0f4f4;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
    .card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:480px;width:100%;overflow:hidden}
    .hdr{background:#01696F;padding:28px;text-align:center}
    .hdr img{max-width:180px;display:block;margin:0 auto 10px}
    .hdr p{color:rgba(255,255,255,.85);margin:0;font-size:13px}
    .div{background:#F5C842;height:4px}
    .bod{padding:36px;text-align:center}
    h2{color:#01696F;margin:0 0 10px;font-size:21px}
    p{color:#555;font-size:14px;line-height:1.6;margin:0 0 20px}
    .detail{background:#f0f7f7;border-radius:6px;padding:16px;margin-bottom:20px;text-align:left;font-size:14px;color:#444}
    .detail strong{color:#01696F}
    .field{text-align:left;margin-bottom:14px}
    .field label{display:block;font-size:12px;font-weight:700;color:#01696F;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-family:Arial,sans-serif}
    .field input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d4ede8;border-radius:6px;font-family:Georgia,serif;font-size:14px;color:#333}
    .field input:focus{outline:none;border-color:#01696F}
    .hint{font-size:12px;color:#888;margin-top:4px;font-family:Arial,sans-serif}
    .btn{background:#01696F;color:#fff;border:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:700;cursor:pointer;font-family:Georgia,serif;width:100%;margin-top:8px}
    .btn:hover{background:#015a5f}
    .ftr{background:#01696F;padding:14px;text-align:center}
    .ftr p{color:rgba(255,255,255,.7);font-size:12px;margin:0}
    .ftr a{color:#F5C842;text-decoration:none}
  </style>
</head>
<body>
  <div class="card">
    <div class="hdr">
      <img src="https://thepoultrydoc.wpenginepowered.com/wp-content/uploads/2026/04/TPD-new-logo-lg-ctp-1.png" alt="The Poultry Doc">
      <p>Veterinary Consultation for Backyard Flocks</p>
    </div>
    <div class="div"></div>
    <div class="bod">
      <h2>Confirm and Send</h2>
      <p>Click the button below to approve and send this response to the client.</p>
      <div class="detail">
        <strong>To:</strong> ${escapeHtml(sender_name || sender_email)} &lt;${escapeHtml(sender_email)}&gt;<br>
        <strong>Subject:</strong> ${escapeHtml(subject || 'Your inquiry')}
      </div>
      <form method="POST" action="/approve/confirm">
        ${hiddenInputs}
        <div class="field">
          <label for="cc">CC (optional)</label>
          <input type="text" id="cc" name="cc" value="${escapeHtml(cc || '')}" placeholder="name@example.com, other@example.com" autocomplete="off">
          <div class="hint">Comma-separated. Recipients see these addresses.</div>
        </div>
        <div class="field">
          <label for="bcc">BCC (optional)</label>
          <input type="text" id="bcc" name="bcc" value="${escapeHtml(bcc || '')}" placeholder="name@example.com, other@example.com" autocomplete="off">
          <div class="hint">Comma-separated. Hidden from recipients.</div>
        </div>
        <button type="submit" class="btn">Confirm and Send to Client</button>
      </form>
    </div>
    <div class="ftr"><p>The Poultry Doc &mdash; <a href="https://www.thepoultrydoc.com">www.thepoultrydoc.com</a></p></div>
  </div>
</body>
</html>`);
});

// Approve confirm -- fires webhook after vet clicks confirm button
app.post('/approve/confirm', async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, zap } = req.body;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid submission</h2>');
  }

  // Atomically claim this approval_id. If someone already sent it (double
  // click, second reviewer with the same link, etc.) this returns false and
  // we short-circuit before firing the webhook again.
  const won = await claimApproval(approval_id, { sender_email, sender_name, subject }).catch(err => {
    console.error('claimApproval error:', err);
    return true; // fail open on DB errors so a send is never silently swallowed
  });
  if (!won) {
    const existing = await getApprovalStatus(approval_id).catch(() => ({ status: 'approved' }));
    return res.send(ALREADY_APPROVED_HTML(sender_name, sender_email, subject, existing.approved_at));
  }

  const zapKey = zap || '10b';
  const webhook = WEBHOOKS[zapKey] || WEBHOOKS['10b'];

  try {
    const params = new URLSearchParams(req.body);
    await fetch(webhook + '?' + params);
  } catch(e) {
    console.error('Webhook error:', e);
  }

  res.send(CONFIRMATION_HTML(sender_name, sender_email, subject));
});

// Edit page -- show editable draft with TinyMCE
app.get('/edit', async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, draft, thread_id, message_id, zap, cc, bcc } = req.query;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid link</h2>');
  }

  const existing = await getApprovalStatus(approval_id).catch(() => ({ status: 'pending' }));
  if (existing.status === 'approved') {
    return res.send(ALREADY_APPROVED_HTML(sender_name, sender_email, subject, existing.approved_at));
  }

  // Convert plain text draft to HTML (handles URLs as centered buttons)
  const htmlDraft = draftToHtml(draft);

  // Pass all original querystring params to hidden form fields EXCEPT draft, cc, bcc
  // (draft comes from TinyMCE; cc/bcc become visible text inputs)
  const allParams = Object.entries(req.query)
    .filter(([k]) => k !== 'draft' && k !== 'cc' && k !== 'bcc')
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('\n    ');

  const cancelUrl = '/approve?' + new URLSearchParams(req.query).toString();

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Edit Response - The Poultry Doc</title>
  <script src="https://cdn.tiny.cloud/1/0fdodg5iffga60i75lha5mayclwv66lr80cb9101ubf17iwv/tinymce/6/tinymce.min.js" referrerpolicy="origin"></script>
  <style>
    *{box-sizing:border-box}
    body{margin:0;background:#f0f4f4;font-family:Georgia,serif;padding:24px}
    .wrap{max-width:760px;margin:0 auto}
    .card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);overflow:hidden;margin-bottom:20px}
    .hdr{background:#01696F;padding:20px 28px;display:flex;align-items:center;gap:16px}
    .hdr img{max-width:140px}
    .hdr p{color:rgba(255,255,255,.85);margin:0;font-size:13px}
    .div{background:#F5C842;height:4px}
    .body{padding:28px}
    .meta{background:#f0f7f7;border-left:4px solid #01696F;border-radius:4px;padding:16px;margin-bottom:20px;font-size:14px;color:#444}
    .meta strong{color:#01696F}
    label{display:block;font-size:13px;font-weight:700;color:#01696F;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;font-family:Arial,sans-serif}
    .editor-wrap{border:1px solid #d4ede8;border-radius:6px;overflow:hidden;margin-bottom:20px}
    .field{margin-bottom:14px}
    .field label{display:block;font-size:12px;font-weight:700;color:#01696F;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;font-family:Arial,sans-serif}
    .field input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d4ede8;border-radius:6px;font-family:Georgia,serif;font-size:14px;color:#333}
    .field input:focus{outline:none;border-color:#01696F}
    .hint{font-size:12px;color:#888;margin-top:4px;font-family:Arial,sans-serif}
    .actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}
    .btn-send{background:#01696F;color:#fff;border:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif}
    .btn-send:hover{background:#015a5f}
    .btn-cancel{background:#fff;color:#01696F;border:2px solid #01696F;padding:14px 24px;border-radius:6px;font-size:15px;font-weight:700;cursor:pointer;font-family:Arial,sans-serif;text-decoration:none;display:inline-block}
    .note{font-size:13px;color:#888;margin-top:12px;font-family:Georgia,serif}
  </style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="hdr">
        <img src="https://thepoultrydoc.wpenginepowered.com/wp-content/uploads/2026/04/TPD-new-logo-lg-ctp-1.png" alt="The Poultry Doc">
        <p>Edit Response Before Sending</p>
      </div>
      <div class="div"></div>
      <div class="body">
        <div class="meta">
          <strong>To:</strong> ${escapeHtml(sender_name || sender_email)} &lt;${escapeHtml(sender_email)}&gt;<br>
          <strong>Subject:</strong> ${escapeHtml(subject || '')}
        </div>

        <div class="field">
          <label for="cc-input">CC (optional)</label>
          <input type="text" id="cc-input" value="${escapeHtml(cc || '')}" placeholder="name@example.com, other@example.com" autocomplete="off">
          <div class="hint">Comma-separated. Recipients see these addresses.</div>
        </div>
        <div class="field">
          <label for="bcc-input">BCC (optional)</label>
          <input type="text" id="bcc-input" value="${escapeHtml(bcc || '')}" placeholder="name@example.com, other@example.com" autocomplete="off">
          <div class="hint">Comma-separated. Hidden from recipients.</div>
        </div>
        <div class="field">
          <label for="attachment-input">Attachment (optional)</label>
          <input type="file" id="attachment-input" name="attachment" form="edit-form" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png">
          <div class="hint">PDF, Word doc, or image, up to 10MB. Sent as a file attachment on the email.</div>
        </div>

        <label>Edit Response</label>
        <div class="editor-wrap">
          <textarea id="draft-editor"></textarea>
        </div>

        <div class="actions">
          <button type="button" class="btn-send" onclick="submitEdit()">Send Edited Response</button>
          <a class="btn-cancel" href="${escapeHtml(cancelUrl)}">Send Original Without Edits</a>
        </div>
        <p class="note">Changes are sent when you click Send. The client will receive the edited version.</p>
      </div>
    </div>
  </div>

  <form id="edit-form" method="POST" action="/edit/send" enctype="multipart/form-data" style="display:none">
    ${allParams}
    <input type="hidden" name="draft" id="form-draft">
    <input type="hidden" name="cc" id="form-cc">
    <input type="hidden" name="bcc" id="form-bcc">
  </form>

  <script>
    // HTML content loaded from server (plain text already converted to HTML)
    const initialContent = ${JSON.stringify(htmlDraft)};

    tinymce.init({
      selector: '#draft-editor',
      height: 520,
      menubar: false,
      plugins: ['lists', 'link', 'code', 'autolink'],
      toolbar: 'undo redo | bold italic underline | forecolor | alignleft aligncenter alignright | bullist numlist | link | code',
      content_style: 'body { font-family: Georgia, serif; font-size: 15px; color: #333; line-height: 1.7; padding: 12px; }',
      skin: 'oxide',
      content_css: 'default',
      // Auto-convert pasted bare URLs into centered buttons
      paste_preprocess: function(plugin, args) {
        const urlRegex = /^(https?:\\/\\/[^\\s]+)$/;
        const trimmed = args.content.trim();
        if (urlRegex.test(trimmed)) {
          args.content = '<p style="text-align:center;margin:20px 0;">' +
            '<a href="' + trimmed + '" target="_blank" ' +
            'style="display:inline-block;background:#01696F;color:#ffffff;' +
            'padding:12px 28px;border-radius:6px;text-decoration:none;' +
            'font-family:Georgia,serif;font-size:15px;font-weight:700;">' +
            'View Document</a></p>';
        }
      },
      setup: function(editor) {
        editor.on('init', function() {
          editor.setContent(initialContent);
        });
      }
    });

    async function submitEdit() {
      const btn = document.querySelector('.btn-send');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }

      const editor = tinymce.get('draft-editor');
      const content = editor ? editor.getContent() : '';

      // Build FormData by hand instead of relying on the file input's
      // form="edit-form" association + form.submit() -- that pairing is
      // spec-legal but has proven unreliable in practice (the attachment
      // silently failed to ride along). Grabbing the file directly here
      // guarantees it's included.
      const formEl = document.getElementById('edit-form');
      const fd = new FormData(formEl);
      fd.set('draft', content);
      fd.set('cc', document.getElementById('cc-input').value.trim());
      fd.set('bcc', document.getElementById('bcc-input').value.trim());

      const fileInput = document.getElementById('attachment-input');
      if (fileInput && fileInput.files && fileInput.files[0]) {
        fd.set('attachment', fileInput.files[0]);
      }

      try {
        const res = await fetch(formEl.action, { method: 'POST', body: fd });
        const html = await res.text();
        document.open();
        document.write(html);
        document.close();
      } catch (e) {
        if (btn) { btn.disabled = false; btn.textContent = 'Send Edited Response'; }
        alert('Send failed: ' + e.message + ' -- please try again.');
      }
    }
  </script>
</body>
</html>`);
});

// Handle edited form submission (multipart -- may include an attachment file)
app.post('/edit/send', upload.single('attachment'), async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, zap } = req.body;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid submission</h2>');
  }

  const won = await claimApproval(approval_id, { sender_email, sender_name, subject }).catch(err => {
    console.error('claimApproval error:', err);
    return true; // fail open on DB errors so a send is never silently swallowed
  });
  if (!won) {
    const existing = await getApprovalStatus(approval_id).catch(() => ({ status: 'approved' }));
    return res.send(ALREADY_APPROVED_HTML(sender_name, sender_email, subject, existing.approved_at));
  }

  const zapKey = zap || '10b';
  const webhook = WEBHOOKS[zapKey] || WEBHOOKS['10b'];

  // If the vet attached a file, push it to Drive first and forward the link.
  // Never block the send on an attachment failure -- log it and let the email
  // go out without the attachment rather than silently dropping the whole reply.
  let attachmentUrl = '';
  let attachmentName = '';
  let attachmentError = '';
  if (req.file) {
    try {
      const uploaded = await uploadAttachmentToDrive(req.file);
      attachmentUrl = uploaded.url;
      attachmentName = uploaded.name;
    } catch (e) {
      console.error('Attachment upload error:', e);
      attachmentError = 'attachment_failed';
    }
  }

  try {
    const payload = { ...req.body };
    if (attachmentUrl) {
      payload.attachment_url = attachmentUrl;
      payload.attachment_name = attachmentName;
    }
    if (attachmentError) {
      payload.attachment_error = attachmentError;
    }
    const params = new URLSearchParams(payload);
    await fetch(webhook + '?' + params);
  } catch(e) {
    console.error('Webhook error:', e);
  }

  res.send(CONFIRMATION_HTML(sender_name, sender_email, subject, attachmentError ? 'Note: the attached file could not be uploaded, so this email was sent without it.' : ''));
});

// Multer errors (e.g. file too large) land here instead of the route handler
app.use((err, req, res, next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).send('<h2>Attachment too large</h2><p>Please attach a file under 10MB and try again.</p>');
    }
    return res.status(400).send(`<h2>Attachment error</h2><p>${escapeHtml(err.message)}</p>`);
  }
  next(err);
});

app.listen(PORT, () => console.log('TPD Approve running on port', PORT));
