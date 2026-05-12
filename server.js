const express = require('express');
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

  // If it already looks like HTML, return as-is
  if (/<\s*(p|div|ul|ol|li|table|tr|td|blockquote|h[1-6])(\s|>|\/)/i.test(draft)) return draft;
  // URL regex
  const urlRegex = /(https?:\/\/[^\s<>"]+)/g;

  // Normalize: if no newlines exist, split on sentence-ending punctuation
  // followed by a space and a capital letter (paragraph boundaries)
  let normalized = draft;
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

    // Check if the entire paragraph is just a URL
    if (/^https?:\/\/[^\s]+$/.test(trimmed)) {
      return `<p style="text-align:center;margin:20px 0;">` +
        `<a href="${trimmed}" target="_blank" ` +
        `style="display:inline-block;background:#01696F;color:#ffffff;` +
        `padding:12px 28px;border-radius:6px;text-decoration:none;` +
        `font-family:Georgia,serif;font-size:15px;font-weight:700;">` +
        `View Document</a></p>`;
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

const CONFIRMATION_HTML = (sender_name, sender_email, subject) => `<!DOCTYPE html>
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
    </div>
    <div class="ftr"><p>The Poultry Doc &mdash; <a href="https://www.thepoultrydoc.com">www.thepoultrydoc.com</a></p></div>
  </div>
</body>
</html>`;

app.get('/', (req, res) => {
  res.send('TPD Approve is running.');
});

// Approve -- show confirmation page (prevents email scanner double-fire)
app.get('/approve', (req, res) => {
  const { approval_id, sender_email, sender_name, subject } = req.query;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid link</h2>');
  }

  const hiddenInputs = Object.entries(req.query)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v)}">`)
    .join('\n    ');

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Confirm Approval - The Poultry Doc</title>
  <style>
    body{margin:0;background:#f0f4f4;font-family:Georgia,serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
    .card{background:#fff;border-radius:10px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:480px;width:90%;overflow:hidden}
    .hdr{background:#01696F;padding:28px;text-align:center}
    .hdr img{max-width:180px;display:block;margin:0 auto 10px}
    .hdr p{color:rgba(255,255,255,.85);margin:0;font-size:13px}
    .div{background:#F5C842;height:4px}
    .bod{padding:36px;text-align:center}
    h2{color:#01696F;margin:0 0 10px;font-size:21px}
    p{color:#555;font-size:14px;line-height:1.6;margin:0 0 20px}
    .detail{background:#f0f7f7;border-radius:6px;padding:16px;margin-bottom:24px;text-align:left;font-size:14px;color:#444}
    .detail strong{color:#01696F}
    .btn{background:#01696F;color:#fff;border:none;padding:14px 32px;border-radius:6px;font-size:15px;font-weight:700;cursor:pointer;font-family:Georgia,serif;width:100%}
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
app.get('/edit', (req, res) => {
  const { approval_id, sender_email, sender_name, subject, draft, thread_id, message_id, zap } = req.query;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid link</h2>');
  }

  // Convert plain text draft to HTML (handles URLs as centered buttons)
  const htmlDraft = draftToHtml(draft);

  // Pass ALL original querystring params to hidden form fields
  const allParams = Object.entries(req.query)
    .filter(([k]) => k !== 'draft') // draft comes from TinyMCE
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
    .actions{display:flex;gap:12px;flex-wrap:wrap}
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

  <form id="edit-form" method="POST" action="/edit/send" style="display:none">
    ${allParams}
    <input type="hidden" name="draft" id="form-draft">
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

    function submitEdit() {
      const editor = tinymce.get('draft-editor');
      const content = editor ? editor.getContent() : '';
      document.getElementById('form-draft').value = content;
      document.getElementById('edit-form').submit();
    }
  </script>
</body>
</html>`);
});

// Handle edited form submission
app.post('/edit/send', async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, zap } = req.body;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid submission</h2>');
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

app.listen(PORT, () => console.log('TPD Approve running on port', PORT));
