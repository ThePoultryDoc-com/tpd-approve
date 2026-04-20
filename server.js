const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
const ZAP_WEBHOOK = process.env.ZAP_10B_WEBHOOK || 'https://hooks.zapier.com/hooks/catch/25149853/ujis74a/';

app.get('/approve', async (req, res) => {
  const { approval_id, sender_email, sender_name, subject, draft } = req.query;
  
  if (!approval_id || !sender_email) {
    return res.status(400).send('<h2>Invalid link</h2>');
  }

  try {
    const params = new URLSearchParams({ approval_id, sender_email, sender_name: sender_name||'', subject: subject||'', draft: draft||'' });
    await fetch(ZAP_WEBHOOK + '?' + params);
  } catch(e) {
    console.error('Webhook error:', e);
  }

  res.send(`<!DOCTYPE html>
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
      <h2>Response Approved</h2>
      <p>Your response has been sent to the inquirer.</p>
      <div class="detail">
        <strong>Sent to:</strong> ${sender_name||sender_email} &lt;${sender_email}&gt;<br>
        <strong>Subject:</strong> ${subject||'Your inquiry'}
      </div>
    </div>
    <div class="ftr"><p>The Poultry Doc &mdash; <a href="https://www.thepoultrydoc.com">www.thepoultrydoc.com</a></p></div>
  </div>
</body>
</html>`);
});

app.listen(PORT, () => console.log('TPD Approve running on port', PORT));
