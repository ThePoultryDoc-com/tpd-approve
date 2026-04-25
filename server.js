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
        <strong>Sent to:</strong> ${sender_name || sender_email} &lt;${sender_email}&gt;<br>
        <strong>Subject:</strong> ${subject || 'Your inquiry'}
      </div>
    </div>
    <div class="ftr"><p>The Poultry Doc &mdash; <a href="https://www.thepoultrydoc.com">www.thepoultrydoc.com</a></p></div>
  </div>
</body>
</html>`;

// Approve and send as-is
app.get('/approve', async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, draft, thread_id, message_id, zap } = req.query;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid link</h2>');
  }

  const zapKey = zap || '10b';
  const webhook = WEBHOOKS[zapKey] || WEBHOOKS['10b'];

  try {
    const params = new URLSearchParams({
      approval_id: approval_id || '',
      sender_email: sender_email || '',
      sender_name: sender_name || '',
      subject: subject || '',
      draft: draft || '',
      thread_id: thread_id || '',
      message_id: message_id || ''
    });
    await fetch(webhook + '?' + params);
  } catch(e) {
    console.error('Webhook error:', e);
  }

  res.send(CONFIRMATION_HTML(sender_name, sender_email, subject));
});

// Edit page -- show editable draft
app.get('/edit', (req, res) => {
  const { approval_id, sender_email, sender_name, subject, draft, thread_id, message_id, zap } = req.query;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid link</h2>');
  }

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
          <strong>To:</strong> ${sender_name || sender_email} &lt;${sender_email}&gt;<br>
          <strong>Subject:</strong> ${subject || ''}
        </div>

        <label>Edit Response</label>
        <div class="editor-wrap">
          <textarea id="draft-editor" name="draft">${draft ? draft.replace(/</g, '&lt;').replace(/>/g, '&gt;') : ''}</textarea>
        </div>

        <div class="actions">
          <button class="btn-send" onclick="submitEdit()">Send Edited Response</button>
          <a class="btn-cancel" href="/approve?approval_id=${encodeURIComponent(approval_id || '')}&sender_email=${encodeURIComponent(sender_email || '')}&sender_name=${encodeURIComponent(sender_name || '')}&subject=${encodeURIComponent(subject || '')}&draft=${encodeURIComponent(draft || '')}&thread_id=${encodeURIComponent(thread_id || '')}&message_id=${encodeURIComponent(message_id || '')}&zap=${encodeURIComponent(zap || '10b')}">Send Original Without Edits</a>
        </div>
        <p class="note">Changes are saved when you click Send. The client will receive the edited version.</p>
      </div>
    </div>
  </div>

  <form id="edit-form" method="POST" action="/edit/send" style="display:none">
    <input type="hidden" name="approval_id" value="${approval_id || ''}">
    <input type="hidden" name="sender_email" value="${sender_email || ''}">
    <input type="hidden" name="sender_name" value="${sender_name || ''}">
    <input type="hidden" name="subject" value="${subject || ''}">
    <input type="hidden" name="thread_id" value="${thread_id || ''}">
    <input type="hidden" name="message_id" value="${message_id || ''}">
    <input type="hidden" name="zap" value="${zap || '10b'}">
    <input type="hidden" name="draft" id="form-draft">
  </form>

  <script>
    // Initialize TinyMCE
    tinymce.init({
      selector: '#draft-editor',
      height: 500,
      menubar: false,
      plugins: ['lists', 'link', 'image', 'code'],
      toolbar: 'undo redo | bold italic underline | forecolor backcolor | alignleft aligncenter alignright | bullist numlist | link | code',
      content_style: 'body { font-family: Georgia, serif; font-size: 15px; color: #333; line-height: 1.7; }',
      skin: 'oxide',
      content_css: 'default'
    });

    function submitEdit() {
      const content = tinymce.get('draft-editor').getContent();
      document.getElementById('form-draft').value = content;
      document.getElementById('edit-form').submit();
    }
  </script>
</body>
</html>`);
});

// Handle edited form submission
app.post('/edit/send', async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, draft, thread_id, message_id, zap } = req.body;

  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid submission</h2>');
  }

  const zapKey = zap || '10b';
  const webhook = WEBHOOKS[zapKey] || WEBHOOKS['10b'];

  try {
    const params = new URLSearchParams({
      approval_id: approval_id || '',
      sender_email: sender_email || '',
      sender_name: sender_name || '',
      subject: subject || '',
      draft: draft || '',
      thread_id: thread_id || '',
      message_id: message_id || ''
    });
    await fetch(webhook + '?' + params);
  } catch(e) {
    console.error('Webhook error:', e);
  }

  res.send(CONFIRMATION_HTML(sender_name, sender_email, subject));
});

app.listen(PORT, () => console.log('TPD Approve running on port', PORT));
