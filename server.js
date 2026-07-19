require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ──
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// ── RATE LIMITING ──
// General API limit — 100 requests per minute per IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Too many requests — please slow down' },
  standardHeaders: true,
  legacyHeaders: false
}));

// Strict limit on AI endpoints — 20 per minute per IP
app.use('/api/generate', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many AI requests — please wait a moment' }
}));
app.use('/api/chat', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many AI requests — please wait a moment' }
}));
app.use('/api/staff-chat', rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many AI requests — please wait a moment' }
}));

// Strict limit on auth endpoints — 10 per 15 minutes per IP
app.use('/api/team/invite', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many invite attempts — please try again later' }
}));
app.use('/api/team/accept-invite', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many attempts — please try again later' }
}));
// ── STRIPE WEBHOOK — must be before express.json() ──
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: 'Webhook signature failed' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const jobId = session.metadata?.job_id;
    const ownerId = session.metadata?.owner_user_id;
    if (!jobId) return res.json({ received: true });

    await supabase.from('jobs').update({
      status: 'Paid',
      updated_at: new Date().toISOString()
    }).eq('id', jobId);

    await supabase.from('job_activity').insert({
      job_id: jobId,
      user_id: ownerId,
      user_name: 'Auto',
      action: 'payment received via Stripe — job marked Paid'
    });

    await sendPushToUser(ownerId, 'Payment received', `Invoice paid via Stripe`, '/');
  }

  res.json({ received: true });
});

app.use(express.json());

// ── SUPABASE ──
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── CONSTANTS ──
const PLAN_LIMITS = {
  free:  50,
  starter: 100,
  pro: 500,
  power: 2000
};

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const PDFDocument = require('pdfkit');
const { Resend } = require('resend');
const webpush = require('web-push');

// ── RESEND EMAIL SETUP ──
const resend = new Resend(process.env.RESEND_API_KEY);

// ── STRIPE SETUP ──
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── WEB PUSH SETUP ──
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_MAILTO || 'mailto:admin@tradieai.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// ── HELPERS ──
function getSystemPrompt(template, profile) {
  const base = `Business: ${profile.bizname || profile.name}${profile.licence ? ` | Licence: ${profile.licence}` : ''}${profile.abn ? ` | ABN: ${profile.abn}` : ''} | Trade: ${profile.trade} | State: ${profile.state}`;

const standardRules = `
- Write in plain text only. No asterisks, no markdown, no bullet points, no dashes as decoration, no bold, no symbols.
- Use plain natural English. Do not use Australian slang or informal expressions such as "mate", "G'day", "reckon", "arvo", "no worries", "keen" or similar.
- Write professionally but in a friendly and approachable tone — like a confident small business owner.
- Use short paragraphs separated by blank lines.`;

  const prompts = {
    quote: `You are Tradie AI, a professional assistant for Australian tradies. Write a clean professional trade quote.
${base}
Rules:
${standardRules}
- Always include GST breakdown: price ex GST, then 10% GST, then total inc GST.
- Include "Quote valid for 30 days" and the payment terms.
- Start with a greeting to the customer by first name if known.
- Sign off with the business name and phone number.
- Reference relevant Australian standards where appropriate in plain text.
- Output the quote text only, ready to copy and send. No commentary.`,

    email: `You are Tradie AI, helping a tradie write a professional customer email.
${base}
Rules:
${standardRules}
- Tone: professional but warm. Not corporate, not grovelling, not desperate.
- Start with "Hi [first name]," and end with "Kind regards," followed by the business name.
- Include a subject line at the top as: Subject: [subject here]
- Output the email text only. No commentary.`,

    jobad: `You are Tradie AI, helping a tradie write an effective job advertisement.
${base}
Rules:
${standardRules}
- Comply with Fair Work requirements — no discriminatory language, accurate pay information.
- Use clear plain text headings such as "About the role", "What you will be doing", "What we are looking for", "What we offer".
- Write in an approachable tone that attracts good applicants.
- Output the job ad text only, ready to paste into Seek or Gumtree. No commentary.`,

    complaint: `You are Tradie AI, helping a tradie respond professionally to a customer complaint.
${base}
Rules:
${standardRules}
- Acknowledge the concern without admitting fault unnecessarily.
- Be calm, firm and professional. Protect the business while keeping the customer relationship intact.
- Start with "Hi [first name]," and end with "Kind regards," followed by the business name.
- Output the reply text only. No commentary.`,

    followup: `You are Tradie AI, helping a tradie write a professional follow-up message.
${base}
Rules:
${standardRules}
- Keep it short — 3 to 4 sentences maximum.
- Sound like a busy professional following up, not someone chasing work desperately.
- Start with "Hi [first name]," and end with "Kind regards," followed by the business name and phone number.
- Output the message text only. No commentary.`,

    chat: `You are Tradie AI, a helpful business assistant for tradies. You help with quotes, emails, job ads, business advice, pricing, customer handling, and anything else a tradie needs.
${base}
Rules:
${standardRules}
- Be helpful, direct and concise.
- No jargon. Keep answers practical and easy to understand.`,

    swms: `You are Tradie AI, generating a Safe Work Method Statement (SWMS) for an Australian tradie.
${base}
Rules:
${standardRules}
- Use numbered steps and clear plain text headings such as "Step 1 — Task description".
- Include: job details and location, high risk tasks as numbered steps, hazards and risk rating (Low, Medium, High) and control measures for each step, PPE required, emergency procedures, sign-off section.
- Reference relevant Australian WHS legislation in plain text.
- Use plain English that workers on site can understand.
- Output the SWMS text only, ready to print or share. No commentary.`,

    jsa: `You are Tradie AI, generating a Job Safety Analysis (JSA) for an Australian tradie.
${base}
Rules:
${standardRules}
- Use numbered steps and clear plain text headings.
- Include: job description and location, job broken into numbered steps, hazards and control measures for each step, PPE required, sign-off section.
- Keep it simple and practical — this is for everyday non-high-risk work.
- Use plain English that workers on site can understand.
- Output the JSA text only, ready to print or share. No commentary.`,

    smartquote: `You are Tradie AI, generating a detailed quote for an Australian tradie.
${base}
Rules: Generate a structured quote as JSON only — no other text, no markdown, no backticks. Return exactly this format:
{"items":[{"description":"Labour — description here","qty":1,"unit":"hrs","unitPrice":120,"total":120},{"description":"Materials — item name","qty":2,"unit":"ea","unitPrice":45,"total":90}],"subtotalExGST":210,"gst":21,"totalIncGST":231,"notes":"Any relevant notes"}
Use real Australian pricing for the trade and state. Include labour and materials as separate line items. GST is always 10%.`
  };

  return prompts[template] || prompts.chat;
}

// ── AUTH MIDDLEWARE ──
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

// ── ROUTES ──

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Tradie AI backend running', version: '2.0.0' });
});

// ── AUTH: SIGNUP ──
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, profile } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (authError) return res.status(400).json({ error: authError.message });

  const { error: profileError } = await supabase.from('profiles').insert({
    id: authData.user.id,
    email,
    name: profile?.name || '',
    bizname: profile?.bizname || '',
    trade: profile?.trade || '',
    state: profile?.state || '',
    licence: profile?.licence || '',
    abn: profile?.abn || '',
    plan: 'free',
    usage_count: 0,
    usage_reset: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString()
  });
  if (profileError) return res.status(400).json({ error: profileError.message });

  res.json({ success: true, user: authData.user });
});

// ── AUTH: LOGIN ──
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: data.user
  });
});

// ── AUTH: LOGOUT ──
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  const token = req.headers.authorization.replace('Bearer ', '');
  await supabase.auth.admin.signOut(token);
  res.json({ success: true });
});

// ── PROFILE: GET ──
app.get('/api/profile', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(404).json({ error: 'Profile not found' });
  res.json(data);
});

// ── PROFILE: UPDATE ──
app.put('/api/profile', requireAuth, async (req, res) => {
  const { name, bizname, trade, state, licence, abn } = req.body;
  const { data, error } = await supabase
    .from('profiles')
    .update({ name, bizname, trade, state, licence, abn, updated_at: new Date().toISOString() })
    .eq('id', req.user.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── STAFF PROFILE: SELF-EDIT (limited fields) ──
app.put('/api/staff/profile', requireAuth, async (req, res) => {
  const { phone, emergency_contact_name, emergency_contact_phone, license_number } = req.body;
  
  // Only allow staff to edit these specific fields
  const updateData = {};
  if (phone !== undefined) updateData.phone = phone;
  if (emergency_contact_name !== undefined) updateData.emergency_contact_name = emergency_contact_name;
  if (emergency_contact_phone !== undefined) updateData.emergency_contact_phone = emergency_contact_phone;
  if (license_number !== undefined) updateData.license_number = license_number;
  updateData.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('profiles')
    .update(updateData)
    .eq('id', req.user.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  // Also update the team_members record so owner/supervisor can see it
  const teamMemberSync = {};
  if (phone !== undefined) teamMemberSync.phone = phone;
  if (emergency_contact_name !== undefined) teamMemberSync.emergency_contact_name = emergency_contact_name;
  if (emergency_contact_phone !== undefined) teamMemberSync.emergency_contact_phone = emergency_contact_phone;
  if (license_number !== undefined) teamMemberSync.license_number = license_number;
  if (Object.keys(teamMemberSync).length > 0) {
    await supabase.from('team_members').update(teamMemberSync).eq('user_id', req.user.id);
  }

  res.json(data);
});

// ── AI: GENERATE ──
app.post('/api/generate', requireAuth, async (req, res) => {
  const { template, message } = req.body;
  if (!template || !message) return res.status(400).json({ error: 'Template and message required' });

// Each user has their own usage count — fetch caller's own profile
  // But fetch owner profile separately for business context (bizname, trade etc)
  const profileUserId = req.user.id;
  const staffCtx = await getStaffMember(req.user.id);

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', profileUserId)
    .single();
  if (profileError) return res.status(404).json({ error: 'Profile not found' });

  // For AI context, use owner's business profile if supervisor/team member
  let contextProfile = profile;
  if (staffCtx?.teams?.owner_user_id) {
    const { data: ownerProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', staffCtx.teams.owner_user_id)
      .single();
    if (ownerProfile) contextProfile = ownerProfile;
  }

  // Reset usage if new month
  const now = new Date();
  const resetDate = new Date(profile.usage_reset);
  if (now >= resetDate) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    await supabase.from('profiles').update({ usage_count: 0, usage_reset: nextReset }).eq('id', profileUserId);
    profile.usage_count = 0;
  }

  const limit = PLAN_LIMITS[profile.plan] || PLAN_LIMITS.free;
  if (profile.usage_count >= limit) {
    return res.status(429).json({
      error: 'Monthly message limit reached',
      limit,
      used: profile.usage_count,
      plan: profile.plan
    });
  }

  try {
 const systemPrompt = getSystemPrompt(template, contextProfile);
    const deepseekRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 1000,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message }
        ]
      })
    });

    if (!deepseekRes.ok) {
      const errText = await deepseekRes.text();
      console.error('DeepSeek error:', errText);
      return res.status(502).json({ error: 'AI service error — please try again' });
    }

    const aiData = await deepseekRes.json();
    const output = aiData.choices[0].message.content;
    const tokensUsed = aiData.usage?.total_tokens || 0;

    const newCount = profile.usage_count + 1;
    await supabase.from('profiles').update({ usage_count: newCount }).eq('id', profileUserId);

    const { data: historyItem } = await supabase.from('history').insert({
      user_id: profileUserId,
      template,
      input: message,
      output,
      tokens_used: tokensUsed,
      created_at: new Date().toISOString()
    }).select().single();

    res.json({
      output,
      tokens_used: tokensUsed,
      usage: { used: newCount, limit, plan: profile.plan },
      history_id: historyItem?.id
    });

  } catch (err) {
    console.error('Generate error:', err);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// ── AI: STAFF CHAT (team member Ask AI — own usage pool) ──
app.post('/api/staff-chat', requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

const limit = PLAN_LIMITS[profile.plan] || PLAN_LIMITS.free;
  const now = new Date();
  const resetDate = new Date(profile.usage_reset);
  if (now >= resetDate) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    await supabase.from('profiles').update({ usage_count: 0, usage_reset: nextReset }).eq('id', req.user.id);
    profile.usage_count = 0;
  }

  if (profile.usage_count >= limit) {
    return res.status(429).json({ error: 'Monthly message limit reached', limit });
  }

  const staffCtx = await getStaffMember(req.user.id);
  const ownerId = staffCtx?.teams?.owner_user_id;
  let ownerProfile = null;
  if (ownerId) {
    const { data } = await supabase.from('profiles').select('bizname, name, trade, state, licence, abn').eq('id', ownerId).single();
    ownerProfile = data;
  }

  const base = ownerProfile
    ? `Business: ${ownerProfile.bizname || ownerProfile.name} | Trade: ${ownerProfile.trade} | State: ${ownerProfile.state}`
    : 'Australian trade business';

const systemPrompt = `You are a helpful AI assistant for a team member at an Australian trade business.
${base}
You can help with absolutely anything — general knowledge, trade questions, safety, WHS, 
writing messages, tidying up notes, maths, spelling, how-to questions, industry standards, 
or just general chat. There are no restrictions on what topics you can discuss.
Be helpful, friendly and practical. Keep answers clear and easy to understand.
Do not use Australian slang. Write in plain, clear English.`;

  try {
    const deepseekRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 400,
        messages: [{ role: 'system', content: systemPrompt }, ...messages.slice(-10)]
      })
    });

    if (!deepseekRes.ok) return res.status(502).json({ error: 'AI service error — please try again' });

    const aiData = await deepseekRes.json();
    const reply = aiData.choices[0].message.content;

    await supabase.from('profiles').update({ usage_count: profile.usage_count + 1 }).eq('id', req.user.id);

    await supabase.from('history').insert({
      user_id: req.user.id,
      template: 'chat',
      input: messages[messages.length - 1]?.content || '',
      output: reply,
      created_at: new Date().toISOString()
    });

    res.json({ reply });
  } catch (err) {
    console.error('Staff chat error:', err);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// ── AI: CHAT (multi-turn) ──
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });

  // Supervisor uses owner's profile for context
  const profileUserId = req.user.id;
  const staffCtx = await getStaffMember(req.user.id);

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', profileUserId).single();
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  // Use owner profile for AI business context
  let contextProfile = profile;
  if (staffCtx?.teams?.owner_user_id) {
    const { data: ownerProfile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', staffCtx.teams.owner_user_id)
      .single();
    if (ownerProfile) contextProfile = ownerProfile;
  }

  const limit = PLAN_LIMITS[profile.plan] || PLAN_LIMITS.free;
  if (profile.usage_count >= limit) {
    return res.status(429).json({ error: 'Monthly message limit reached', limit, plan: profile.plan });
  }

  try {
    const systemPrompt = getSystemPrompt('chat', contextProfile);
    const deepseekRes = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        max_tokens: 600,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages.slice(-10)
        ]
      })
    });

    if (!deepseekRes.ok) return res.status(502).json({ error: 'AI service error — please try again' });

    const aiData = await deepseekRes.json();
    const reply = aiData.choices[0].message.content;
await supabase.from('profiles').update({ usage_count: profile.usage_count + 1 }).eq('id', req.user.id);

    res.json({ reply, usage: { used: profile.usage_count + 1, limit, plan: profile.plan } });

  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'Something went wrong — please try again' });
  }
});

// ── HISTORY: GET ──
app.get('/api/history', requireAuth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const { data, error } = await supabase
    .from('history')
    .select('id, template, input, output, tokens_used, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── HISTORY: GET ONE ──
app.get('/api/history/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('history')
    .select('*')
    .eq('id', req.params.id)
    .eq('user_id', req.user.id)
    .single();
  if (error) return res.status(404).json({ error: 'Not found' });
  res.json(data);
});

// ── HISTORY: DELETE ──
app.delete('/api/history/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('history')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ── USAGE: GET ──
app.get('/api/usage', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('plan, usage_count, usage_reset')
    .eq('id', req.user.id)
    .single();
  if (error) return res.status(400).json({ error: error.message });
  const limit = PLAN_LIMITS[data.plan] || PLAN_LIMITS.free;
  res.json({ plan: data.plan, used: data.usage_count, limit, reset: data.usage_reset });
});

// ══════════════════════════════════════════════════
// ── TEAM MANAGEMENT ──
// ══════════════════════════════════════════════════

// ── TEAM: GET OR CREATE TEAM FOR OWNER ──
async function getOrCreateTeam(userId) {
  let { data: team } = await supabase.from('teams').select('*').eq('owner_user_id', userId).single();
  if (!team) {
    const { data: newTeam } = await supabase.from('teams').insert({ owner_user_id: userId }).select().single();
    team = newTeam;
  }
  return team;
}

// ── TEAM: GET STAFF MEMBER CONTEXT (works for both supervisor and team_member) ──
async function getStaffMember(userId) {
  const { data } = await supabase
    .from('team_members')
    .select('*, teams(owner_user_id)')
    .eq('user_id', userId)
    .eq('status', 'active')
   .in('role', ['owner', 'supervisor', 'team_member'])
    .single();
  return data || null;
}

// Legacy alias
async function getStaffContext(userId) {
  return getStaffMember(userId);
}

// Helper — true if staff member has owner-level access
function isOwnerLevel(staffCtx) {
  return staffCtx && (staffCtx.role === 'supervisor' || staffCtx.role === 'owner');
}

// ── JOB SCOPE HELPER — resolves ownerId and fetches job, enforcing ownership ──
// Returns { job, ownerId } or throws with a status code attached
async function getJobScoped(jobId, userId, { allowTeamMember = false } = {}) {
  const staffCtx = await getStaffMember(userId);

  // Team members can only access jobs assigned to them
  if (staffCtx && staffCtx.role === 'team_member') {
    if (!allowTeamMember) {
      const err = new Error('Access denied');
      err.status = 403;
      throw err;
    }
    const { data: job } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .eq('assigned_to', userId)
      .single();
    if (!job) {
      const err = new Error('Job not found');
      err.status = 404;
      throw err;
    }
    return { job, ownerId: staffCtx.teams.owner_user_id };
  }

  // Supervisors and owners — scope to owner's jobs
  const ownerId = staffCtx ? staffCtx.teams.owner_user_id : userId;
  const { data: job } = await supabase
    .from('jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', ownerId)
    .single();
  if (!job) {
    const err = new Error('Job not found');
    err.status = 404;
    throw err;
  }
  return { job, ownerId };
}

// ── TEAM: INVITE STAFF ──
app.post('/api/team/invite', requireAuth, async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  // Supervisors can only invite team_member, never another supervisor
  const staffCtx = await getStaffMember(req.user.id);
  const memberRole = (staffCtx && staffCtx.role === 'supervisor')
    ? 'team_member'
    : (role === 'supervisor' ? 'supervisor' : 'team_member');

  const ownerIdForTeam = (staffCtx && staffCtx.role === 'supervisor')
    ? staffCtx.teams.owner_user_id
    : req.user.id;

  const team = await getOrCreateTeam(ownerIdForTeam);
  if (!team) return res.status(500).json({ error: 'Could not create team' });

  const { data: existing } = await supabase
    .from('team_members')
    .select('id')
    .eq('team_id', team.id)
    .eq('email', email)
    .single();
  if (existing) return res.status(400).json({ error: 'This person has already been invited' });

  const crypto = require('crypto');
  const inviteToken = crypto.randomBytes(32).toString('hex');

  const { data: member, error: memberError } = await supabase
    .from('team_members')
    .insert({
      team_id: team.id,
      user_id: null,
      name,
      email,
      role: memberRole,
      status: 'pending',
      invite_token: inviteToken
    })
    .select()
    .single();
  if (memberError) return res.status(400).json({ error: memberError.message });

  const frontendUrl = process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com';
  const inviteLink = `${frontendUrl}?invite=${inviteToken}`;

  res.json({ success: true, member, link: inviteLink });
});

// ── TEAM: LIST MEMBERS ──
app.get('/api/team/members', requireAuth, async (req, res) => {
  // Check if user is a supervisor — if so, get their team
  const staffCtx = await getStaffMember(req.user.id);
  let team;
  if (staffCtx && staffCtx.role === 'supervisor') {
    // Supervisor can view team members (read-only)
    const { data } = await supabase.from('teams').select('*').eq('owner_user_id', staffCtx.teams.owner_user_id).single();
    team = data;
  } else {
    team = await getOrCreateTeam(req.user.id);
  }
  if (!team) return res.json([]);

const { data, error } = await supabase
    .from('team_members')
    .select('*')
    .eq('team_id', team.id)
    .order('invited_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// ── TEAM: REMOVE MEMBER (owner only — soft delete) ──
app.delete('/api/team/members/:id', requireAuth, async (req, res) => {
  const team = await getOrCreateTeam(req.user.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const { error } = await supabase
    .from('team_members')
.update({ status: 'inactive', removed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('team_id', team.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ── TEAM: UPDATE MEMBER ROLE (owner only) ──
app.put('/api/team/members/:id/role', requireAuth, async (req, res) => {
  const { role } = req.body;
 if (!role || !['owner', 'supervisor', 'team_member'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be owner, supervisor or team_member.' });
  }

  const team = await getOrCreateTeam(req.user.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const { data, error } = await supabase
    .from('team_members')
    .update({ role })
    .eq('id', req.params.id)
    .eq('team_id', team.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── TEAM: ACTIVATE MEMBER VIA TOKEN ──
app.post('/api/team/activate', requireAuth, async (req, res) => {
  const { invite_token } = req.body || {};

  let member;

  if (invite_token) {
    const { data, error } = await supabase
      .from('team_members')
      .update({ status: 'active', user_id: req.user.id, joined_at: new Date().toISOString() })
      .eq('invite_token', invite_token)
      .select('*, teams(owner_user_id)')
      .single();
    if (error || !data) return res.status(404).json({ error: 'Invalid invite token' });
    member = data;
  } else {
    const { data, error } = await supabase
      .from('team_members')
      .update({ status: 'active', user_id: req.user.id, joined_at: new Date().toISOString() })
      .eq('email', req.user.email)
      .in('status', ['pending', 'active'])
      .select('*, teams(owner_user_id)')
      .single();
    if (error || !data) return res.status(200).json({ success: true, member: null });
    member = data;
  }

  const { data: existingProfile } = await supabase.from('profiles').select('id').eq('id', req.user.id).single();
  if (!existingProfile) {
    await supabase.from('profiles').insert({
      id: req.user.id,
      email: req.user.email,
      name: member.name,
      firstname: member.name.split(' ')[0],
      plan: 'free',
      usage_count: 0,
      usage_reset: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString()
    });
  }
  res.json({ success: true, member });
});

// ── TEAM: GET MY ROLE ──
app.get('/api/team/my-role', requireAuth, async (req, res) => {
  // Check by user_id first (already activated)
  const staffContext = await getStaffMember(req.user.id);
  if (staffContext) {
    return res.json({ role: staffContext.role, owner_id: staffContext.teams.owner_user_id, member: staffContext });
  }

  // Check by email (pending — first login)
  const { data: pendingMember } = await supabase
    .from('team_members')
    .select('*, teams(owner_user_id)')
    .eq('email', req.user.email)
    .in('status', ['pending', 'active'])
    .single();

  if (pendingMember) {
    return res.json({ role: pendingMember.role, owner_id: pendingMember.teams.owner_user_id, member: pendingMember });
  }

  // They are an owner
  const { data: team } = await supabase.from('teams').select('id').eq('owner_user_id', req.user.id).single();
  res.json({ role: 'owner', team_id: team?.id || null });
});

// ── JOBS: GET ALL TEAM JOBS (for supervisors) ──
app.get('/api/team/jobs', requireAuth, async (req, res) => {
  const staffCtx = await getStaffMember(req.user.id);
  if (!staffCtx || !isOwnerLevel(staffCtx)) {
    return res.status(403).json({ error: 'Supervisors only' });
  }

  const ownerId = staffCtx.teams.owner_user_id;
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// ── JOBS: SUPERVISOR ASSIGN JOB ──
app.put('/api/team/jobs/:id/assign', requireAuth, async (req, res) => {
  const { assigned_to } = req.body;
  const staffCtx = await getStaffMember(req.user.id);
  if (!staffCtx || !isOwnerLevel(staffCtx)) {
    return res.status(403).json({ error: 'Supervisors only' });
  }

  const ownerId = staffCtx.teams.owner_user_id;
  const { data, error } = await supabase
    .from('jobs')
    .update({ assigned_to: assigned_to || null, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── JOBS: SUPERVISOR UPDATE STATUS ──
app.put('/api/team/jobs/:id/status', requireAuth, async (req, res) => {
const { status } = req.body;
  const staffCtx = await getStaffMember(req.user.id);
  if (!staffCtx || !isOwnerLevel(staffCtx)) {
    return res.status(403).json({ error: 'Supervisors only' });
  }

  const validStatuses = ['New', 'Quoted', 'Accepted', 'Declined', 'In Progress', 'Completed', 'Invoiced', 'Paid'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const ownerId = staffCtx.teams.owner_user_id;
  const { data, error } = await supabase
    .from('jobs')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', ownerId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  // Notify owner when supervisor marks job complete
  if (status === 'Completed') {
    await sendPushToUser(
      ownerId,
      'Job completed',
      `"${data.customer_name}" marked complete by your supervisor`,
      `/`
    );
  }

  res.json(data);
});

// ── TEAM: GET CUSTOMERS (for supervisors) ──
app.get('/api/team/customers', requireAuth, async (req, res) => {
  const staffCtx = await getStaffMember(req.user.id);
  if (!staffCtx || !isOwnerLevel(staffCtx)) {
    return res.status(403).json({ error: 'Supervisors only' });
  }

  const ownerId = staffCtx.teams.owner_user_id;
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('user_id', ownerId)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// ── JOBS: GET FOR STAFF (only assigned jobs) ──
app.get('/api/jobs/assigned', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('assigned_to', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// ── JOBS: DELETE ──
app.delete('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    // Only owners and supervisors can delete — scoped to their team's jobs
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx && staffCtx.role === 'team_member') {
      return res.status(403).json({ error: 'Team members cannot delete jobs' });
    }

    let job, profileId;
    try {
      ({ job, ownerId: profileId } = await getJobScoped(req.params.id, req.user.id));
    } catch (e) {
      return res.status(e.status || 404).json({ error: e.message });
    }

    // Get deleter name
    const { data: profile } = await supabase
      .from('profiles')
      .select('firstname, name')
      .eq('id', req.user.id)
      .single();

    const deletedByName = profile?.firstname || profile?.name || 'Unknown';

    // Save to deleted_jobs before deleting
    await supabase.from('deleted_jobs').insert({
      job_number: job.job_number,
      customer_name: job.customer_name,
      description: job.description,
      value: job.value,
      status: job.status,
      deleted_by_user_id: req.user.id,
      deleted_by_name: deletedByName,
      deleted_at: new Date().toISOString(),
      owner_user_id: profileId
    });

    // Now delete the job
    const { error } = await supabase
      .from('jobs')
      .delete()
      .eq('id', req.params.id);

    if (error) return res.status(400).json({ error: error.message });

    res.json({ success: true });

  } catch (err) {
    console.error('Delete job error:', err);
    res.status(500).json({ error: 'Could not delete job' });
  }
});

// ── JOBS: GET DELETED (for activity feed) ──
app.get('/api/jobs/deleted', requireAuth, async (req, res) => {
  try {
    let profileId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) profileId = staffCtx.teams.owner_user_id;

    const { data, error } = await supabase
      .from('deleted_jobs')
      .select('*')
      .eq('owner_user_id', profileId)
      .order('deleted_at', { ascending: false })
      .limit(20);

    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);

  } catch (err) {
    res.status(500).json({ error: 'Could not get deleted jobs' });
  }
});

// ── JOB ACTIVITY: LOG ──
app.post('/api/jobs/:id/activity', requireAuth, async (req, res) => {
  const { action, user_name } = req.body;
  if (!action) return res.status(400).json({ error: 'Action required' });
  try { await getJobScoped(req.params.id, req.user.id, { allowTeamMember: true }); }
  catch (e) { return res.status(e.status || 404).json({ error: e.message }); }

  const { data, error } = await supabase.from('job_activity').insert({
    job_id: req.params.id,
    user_id: req.user.id,
    user_name: user_name || 'Unknown',
    action
  }).select().single();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// ── JOB ACTIVITY: GET ──
app.get('/api/jobs/:id/activity', requireAuth, async (req, res) => {
  try { await getJobScoped(req.params.id, req.user.id, { allowTeamMember: true }); }
  catch (e) { return res.status(e.status || 404).json({ error: e.message }); }

  const { data, error } = await supabase
    .from('job_activity')
    .select('*')
    .eq('job_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
});

// ── TEAM: ACCEPT INVITE ──
app.post('/api/team/accept-invite', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    // Validate token
    const { data: invite, error: tokenErr } = await supabase
      .from('invite_tokens')
      .select('*, team_members(*)')
      .eq('token', token)
      .single();

    if (tokenErr || !invite) return res.status(400).json({ error: 'Invalid or expired invite link' });
    if (invite.used_at) return res.status(400).json({ error: 'This invite has already been used' });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired — ask your team owner to resend it' });

    const member = invite.team_members;
    if (!member) return res.status(400).json({ error: 'Team member record not found' });

    // Check if user already exists in Supabase auth
    const { data: existingUsers } = await supabase.auth.admin.listUsers();
    const existingUser = existingUsers?.users?.find(u => u.email === invite.email);

    let userId;
    if (existingUser) {
      const { error: updateErr } = await supabase.auth.admin.updateUserById(
        existingUser.id, { password }
      );
      if (updateErr) return res.status(400).json({ error: updateErr.message });
      userId = existingUser.id;
    } else {
      const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
        email: invite.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: member.name }
      });
      if (createErr) return res.status(400).json({ error: createErr.message });
      userId = newUser.user.id;
      await supabase.from('profiles').upsert({
        id: userId,
        name: member.name,
        email: invite.email,
        created_at: new Date().toISOString()
      });
    }

    // Activate team member
    await supabase
      .from('team_members')
      .update({ status: 'active', user_id: userId, activated_at: new Date().toISOString() })
      .eq('id', member.id);

    // Mark token used
    await supabase
      .from('invite_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('token', token);

    res.json({ success: true, message: 'Account set up successfully — you can now log in' });
  } catch (err) {
    console.error('Accept invite error:', err);
    res.status(500).json({ error: 'Could not accept invite' });
  }
});

// ── TEAM: REACTIVATE MEMBER ──
app.post('/api/team/members/:id/reactivate', requireAuth, async (req, res) => {
  try {
    let ownerId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx && staffCtx.role === 'supervisor') {
      ownerId = staffCtx.teams.owner_user_id;
    } else if (staffCtx && staffCtx.role === 'team_member') {
      return res.status(403).json({ error: 'Team members cannot reactivate staff' });
    }
    const team = await getOrCreateTeam(ownerId);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const { data: member, error } = await supabase
      .from('team_members')
      .update({ status: 'active', removed_at: null })
      .eq('id', req.params.id)
      .eq('team_id', team.id)
      .select()
      .single();
    if (error) return res.status(400).json({ error: error.message });
    if (!member) return res.status(404).json({ error: 'Member not found' });

    // Send reactivation email via Resend
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('bizname, name, phone')
        .eq('id', ownerId)
        .single();
      const businessName = profile?.bizname || profile?.name || 'Your team';
      const firstName = member.name.split(' ')[0];
      const loginUrl = process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com';

      await resend.emails.send({
        from: `${businessName} <noreply@mailoncall.net>`,
        to: member.email,
        subject: `You've been reactivated on ${businessName}`,
        text: `Hi ${firstName},\n\nGood news — your access to ${businessName} on Tradie AI has been reactivated.\n\nYou can log back in here:\n${loginUrl}\n\nCheers,\n${businessName}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
          <h2 style="color:#0F6E56;margin-bottom:4px;">${businessName}</h2>
          <p style="color:#555;margin-bottom:24px;">Your access has been reactivated</p>
          <div style="background:#F4F3EF;border-radius:12px;padding:20px;margin-bottom:24px;">
            <p style="font-size:15px;color:#1A1A1A;margin:0;">Hi ${firstName},</p>
            <p style="font-size:14px;color:#555;margin:12px 0 0;">Good news — your access to <strong>${businessName}</strong> on Tradie AI has been reactivated. You can log back in using your existing email and password.</p>
          </div>
          <a href="${loginUrl}" style="display:block;background:#0F6E56;color:#ffffff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;margin-bottom:12px;">Log back in</a>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
          <p style="font-size:13px;color:#555;">Cheers,<br><strong>${businessName}</strong>${profile?.phone ? '<br>' + profile.phone : ''}</p>
        </div>`
      });
    } catch (emailErr) {
      console.error('Reactivation email error:', emailErr);
      // Don't block reactivation if email fails
    }

    res.json({ success: true, member });
  } catch (err) {
    console.error('Reactivate member error:', err);
    res.status(500).json({ error: 'Could not reactivate member' });
  }
});

// ── TEAM: SEND INVITE (via Resend, no Supabase email limits) ──
app.post('/api/team/invite', requireAuth, async (req, res) => {
  try {
    const { email, name, role } = req.body;
    if (!email || !name) return res.status(400).json({ error: 'Name and email required' });

    // Resolve owner
    let ownerId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx && staffCtx.role === 'supervisor') {
      ownerId = staffCtx.teams.owner_user_id;
    } else if (staffCtx && staffCtx.role === 'team_member') {
      return res.status(403).json({ error: 'Team members cannot invite staff' });
    }

    const team = await getOrCreateTeam(ownerId);
    if (!team) return res.status(404).json({ error: 'Team not found' });

    // Check if already an active/pending member
    const { data: existing } = await supabase
      .from('team_members')
      .select('id, status')
      .eq('team_id', team.id)
      .eq('email', email)
      .single();

    if (existing && existing.status === 'active') {
      return res.status(400).json({ error: 'This person is already an active team member' });
    }
    if (existing && existing.status === 'pending') {
     // Update role and resend — don't block re-invites
      await supabase
        .from('team_members')
        .update({ role: role || 'team_member', name, invited_at: new Date().toISOString() })
        .eq('id', existing.id);
    }

    // Get owner profile for email branding
    const { data: profile } = await supabase
      .from('profiles')
      .select('bizname, name, phone')
      .eq('id', ownerId)
      .single();
    const businessName = profile?.bizname || profile?.name || 'Your team';

    // Create team member record (pending)
    let memberId;
    if (existing && existing.status === 'inactive') {
      // Reuse existing record
      const { data: updated } = await supabase
        .from('team_members')
        .update({ status: 'pending', name, role: role || 'team_member', invited_at: new Date().toISOString() })
        .eq('id', existing.id)
        .select()
        .single();
      memberId = updated.id;
    } else {
      const { data: member, error: memberErr } = await supabase
        .from('team_members')
        .insert({
          team_id: team.id,
          owner_user_id: ownerId,
          name,
          email,
          role: role || 'team_member',
          status: 'pending',
          invited_at: new Date().toISOString()
        })
        .select()
        .single();
      if (memberErr) return res.status(400).json({ error: memberErr.message });
      memberId = member.id;
    }

    // Generate secure invite token
    const token = require('crypto').randomBytes(32).toString('hex');
    const { error: tokenErr } = await supabase
      .from('invite_tokens')
      .insert({
        token,
        email,
        team_member_id: memberId,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
      });
    if (tokenErr) return res.status(500).json({ error: 'Could not generate invite token' });

    const inviteUrl = `${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}?invite=${token}`;
    const firstName = name.split(' ')[0];

    // Send invite email via Resend
    await resend.emails.send({
      from: `${businessName} <noreply@mailoncall.net>`,
      to: email,
      subject: `You've been invited to join ${businessName}`,
      text: `Hi ${firstName},\n\n${businessName} has invited you to join their team on Tradie AI.\n\nClick the link below to set up your account:\n${inviteUrl}\n\nThis link expires in 7 days.\n\nCheers,\n${businessName}`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#0F6E56;margin-bottom:4px;">${businessName}</h2>
        <p style="color:#555;margin-bottom:24px;">You've been invited to join the team</p>
        <div style="background:#F4F3EF;border-radius:12px;padding:20px;margin-bottom:24px;">
          <p style="font-size:15px;color:#1A1A1A;margin:0;">Hi ${firstName},</p>
          <p style="font-size:14px;color:#555;margin:12px 0 0;">${businessName} has invited you to join their team on Tradie AI — a job management app that keeps the whole team in sync.</p>
        </div>
        <a href="${inviteUrl}" style="display:block;background:#0F6E56;color:#ffffff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;margin-bottom:12px;">Accept invite & set up account</a>
        <p style="font-size:12px;color:#aaa;text-align:center;">This invite expires in 7 days.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="font-size:13px;color:#555;">Cheers,<br><strong>${businessName}</strong>${profile?.phone ? '<br>' + profile.phone : ''}</p>
      </div>`
    });

    res.json({ success: true, message: 'Invite sent via email' });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Could not send invite' });
  }
});

// ── TEAM: RESEND INVITE ──
app.post('/api/team/resend-invite', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  const { error } = await supabase.auth.admin.inviteUserByEmail(email, {
    redirectTo: `${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}/index.html`
  });

  if (error) {
    const { data: users } = await supabase.auth.admin.listUsers();
    const user = users?.users?.find(u => u.email === email);
    if (user) {
      const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
        type: 'magiclink',
        email
      });
      if (linkError) return res.status(400).json({ error: linkError.message });
      return res.json({ success: true, link: linkData.properties.action_link });
    }
    return res.status(400).json({ error: error.message });
  }

  res.json({ success: true });
});

// ── TEAM: VALIDATE INVITE TOKEN (public) ──
// ── QUOTE: ACCEPT/DECLINE (public — no auth required) ──
app.post('/api/quote/:token/respond', async (req, res) => {
  const { action } = req.body;
  if (!['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'Invalid action' });
  }

  const { data: job, error } = await supabase
    .from('jobs')
    .select('*')
    .eq('quote_token', req.params.token)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Quote not found' });
  if (job.quote_token_used) return res.status(400).json({ error: 'This quote has already been responded to' });
  if (job.status !== 'Quoted') return res.status(400).json({ error: 'This quote is no longer available' });

  const newStatus = action === 'accept' ? 'Accepted' : 'Declined';

  await supabase.from('jobs').update({
    status: newStatus,
    quote_token_used: true,
    updated_at: new Date().toISOString()
  }).eq('id', job.id);

  await supabase.from('job_activity').insert({
    job_id: job.id,
    user_id: job.user_id,
    user_name: job.customer_name,
    action: `customer ${action}ed the quote via email link`
  });

  await sendPushToUser(
    job.user_id,
    action === 'accept' ? 'Quote accepted!' : 'Quote declined',
    `${job.customer_name} ${action}ed the quote for ${job.job_number}`,
    '/'
  );

  res.json({ success: true, status: newStatus, customer_name: job.customer_name, job_number: job.job_number });
});

// ── QUOTE: GET DETAILS (public — for acceptance page) ──
app.get('/api/quote/:token', async (req, res) => {
  const { data: job, error } = await supabase
    .from('jobs')
    .select('job_number, customer_name, description, value, status, quote_token_used')
    .eq('quote_token', req.params.token)
    .single();

  if (error || !job) return res.status(404).json({ error: 'Quote not found' });
  res.json(job);
});
app.get('/api/team/invite/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('team_members')
    .select('name, email, status, role, teams(owner_user_id)')
    .eq('invite_token', req.params.token)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Invalid or expired invite link' });
  if (data.status === 'active') return res.status(400).json({ error: 'This invite has already been used' });

  let bizname = null;
  if (data.teams?.owner_user_id) {
    const { data: ownerProfile } = await supabase
      .from('profiles')
      .select('bizname, name')
      .eq('id', data.teams.owner_user_id)
      .single();
    bizname = ownerProfile?.bizname || ownerProfile?.name || null;
  }

  res.json({ name: data.name, email: data.email, role: data.role, bizname });
});
// ── PUSH: SAVE SUBSCRIPTION ──
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription) return res.status(400).json({ error: 'Subscription required' });

    await supabase.from('push_subscriptions').upsert({
      user_id: req.user.id,
      subscription,
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    res.json({ success: true });
  } catch (err) {
    console.error('Push subscribe error:', err);
    res.status(500).json({ error: 'Could not save subscription' });
  }
});

// ── PUSH: SEND TO USER (internal helper) ──
async function sendPushToUser(userId, title, body, url = '/') {
  if (!process.env.VAPID_PUBLIC_KEY) return; // Skip if VAPID not configured

  try {
    const { data: subs } = await supabase
      .from('push_subscriptions')
      .select('subscription')
      .eq('user_id', userId);

    for (const row of subs || []) {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({ title, body, url })
        );
      } catch (err) {
        // Subscription expired or invalid — remove it
        if (err.statusCode === 404 || err.statusCode === 410) {
          await supabase.from('push_subscriptions').delete().eq('user_id', userId);
        }
      }
    }
  } catch (err) {
    console.error('sendPushToUser error:', err);
  }
}

// ── PUSH: GET VAPID PUBLIC KEY ──
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});
// ── JOBS: GENERATE PDF (quote or invoice) ──
app.post('/api/jobs/:id/generate-pdf', requireAuth, async (req, res) => {
  try {
    const { type } = req.body;
    if (!['quote', 'invoice'].includes(type)) {
      return res.status(400).json({ error: 'Type must be quote or invoice' });
    }

    let job, profileId;
    try {
      ({ job, ownerId: profileId } = await getJobScoped(req.params.id, req.user.id));
    } catch (e) {
      return res.status(e.status || 404).json({ error: e.message });
    }

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', profileId)
      .single();
    if (profileError || !profile) return res.status(404).json({ error: 'Profile not found' });

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => {
      const pdfBuffer = Buffer.concat(chunks);
      const base64 = pdfBuffer.toString('base64');
      res.json({ pdf: base64, filename: `${type}-${job.job_number}.pdf` });
    });

    const isInvoice = type === 'invoice';
    const green = '#0F6E56';
    const lightGreen = '#E1F5EE';
    const textDark = '#1A1A1A';
    const textMuted = '#666660';

    // Header band
    doc.rect(0, 0, doc.page.width, 110).fill(green);
if(profile.logo_url){
      try{
        const logoRes=await fetch(profile.logo_url);
        const logoBuffer=Buffer.from(await logoRes.arrayBuffer());
        doc.image(logoBuffer,50,20,{fit:[80,70],align:'left'});
      }catch(e){
        doc.fillColor('#FFFFFF').fontSize(24).font('Helvetica-Bold')
           .text(profile.bizname || profile.name || 'Tradie AI', 50, 30);
      }
    }else{
      doc.fillColor('#FFFFFF').fontSize(24).font('Helvetica-Bold')
         .text(profile.bizname || profile.name || 'Tradie AI', 50, 30);
    }
    doc.fontSize(13).font('Helvetica')
       .text(isInvoice ? 'INVOICE' : 'QUOTE', 0, 40, { align: 'right', width: doc.page.width - 50 });
    doc.fontSize(10)
       .text(job.job_number, 0, 58, { align: 'right', width: doc.page.width - 50 });

    // Business details
    doc.fillColor(textMuted).fontSize(9).font('Helvetica');
    let detailY = 125;
    if (profile.address) { doc.text(profile.address, 50, detailY); detailY += 13; }
    if (profile.phone)   { doc.text(profile.phone, 50, detailY);   detailY += 13; }
    if (profile.abn)     { doc.text(`ABN: ${profile.abn}`, 50, detailY); detailY += 13; }
    if (profile.licence) { doc.text(`Licence: ${profile.licence}`, 50, detailY); detailY += 13; }

    const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    doc.fillColor(textMuted).fontSize(9)
       .text(`Date: ${today}`, 0, 125, { align: 'right', width: doc.page.width - 50 });
    if (!isInvoice) {
      doc.text('Valid for 30 days', 0, 138, { align: 'right', width: doc.page.width - 50 });
    }

    // Divider
    const dividerY = Math.max(detailY, 160) + 10;
    doc.moveTo(50, dividerY).lineTo(doc.page.width - 50, dividerY)
       .strokeColor('#E0DED8').lineWidth(0.5).stroke();

    // Bill to
    let contentY = dividerY + 20;
    doc.fillColor(green).fontSize(9).font('Helvetica-Bold').text('BILL TO', 50, contentY);
    contentY += 14;
    doc.fillColor(textDark).fontSize(11).font('Helvetica-Bold').text(job.customer_name, 50, contentY);
    contentY += 14;
    if (job.customer_phone) { doc.fillColor(textMuted).fontSize(9).font('Helvetica').text(job.customer_phone, 50, contentY); contentY += 12; }
    if (job.customer_email) { doc.fillColor(textMuted).fontSize(9).text(job.customer_email, 50, contentY); contentY += 12; }
    if (job.job_address)    { doc.fillColor(textMuted).fontSize(9).text(job.job_address, 50, contentY); contentY += 12; }
    contentY += 20;

    // Table header
    doc.rect(50, contentY, doc.page.width - 100, 24).fill(green);
    doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
    doc.text('DESCRIPTION', 60, contentY + 8);
    doc.text('AMOUNT', 0, contentY + 8, { align: 'right', width: doc.page.width - 60 });
    contentY += 24;

    // Table row
    const jobValue = parseFloat(job.value) || 0;
    const exGST = jobValue / 1.1;
    const gst = jobValue - exGST;
    doc.rect(50, contentY, doc.page.width - 100, 40).fill(lightGreen);
    doc.fillColor(textDark).fontSize(10).font('Helvetica')
       .text(job.description, 60, contentY + 8, { width: doc.page.width - 200, height: 28, ellipsis: true });
    doc.text(`$${exGST.toFixed(2)}`, 0, contentY + 14, { align: 'right', width: doc.page.width - 60 });
    contentY += 50;

    // Totals
    doc.fillColor(textMuted).fontSize(9).font('Helvetica');
    doc.text('Subtotal (ex GST)', doc.page.width - 220, contentY);
    doc.text(`$${exGST.toFixed(2)}`, 0, contentY, { align: 'right', width: doc.page.width - 50 });
    contentY += 16;
    doc.text('GST (10%)', doc.page.width - 220, contentY);
    doc.text(`$${gst.toFixed(2)}`, 0, contentY, { align: 'right', width: doc.page.width - 50 });
    contentY += 16;
    doc.moveTo(doc.page.width - 220, contentY).lineTo(doc.page.width - 50, contentY)
       .strokeColor('#E0DED8').lineWidth(0.5).stroke();
    contentY += 10;
    doc.fillColor(textDark).fontSize(12).font('Helvetica-Bold').text('TOTAL (inc GST)', doc.page.width - 220, contentY);
    doc.fillColor(green).fontSize(14).text(`$${jobValue.toFixed(2)}`, 0, contentY - 2, { align: 'right', width: doc.page.width - 50 });
    contentY += 40;

// Payment terms
    if (profile.terms || isInvoice) {
      doc.rect(50, contentY, doc.page.width - 100, 36).fill(lightGreen);
      doc.fillColor(green).fontSize(8).font('Helvetica-Bold').text('PAYMENT TERMS', 60, contentY + 6);
      doc.fillColor(textDark).fontSize(9).font('Helvetica')
         .text(profile.terms || 'Payment due within 14 days', 60, contentY + 18);
      contentY += 50;
    }

    // Payment details — invoices only
    if (isInvoice && (profile.bank_name || profile.bsb || profile.account_number || profile.pay_id)) {
      const payLines = [];
      if (profile.bank_name)     payLines.push({ label: 'Bank', value: profile.bank_name });
      if (profile.account_name)  payLines.push({ label: 'Account Name', value: profile.account_name });
      if (profile.bsb)           payLines.push({ label: 'BSB', value: profile.bsb });
      if (profile.account_number)payLines.push({ label: 'Account No', value: profile.account_number });
      if (profile.pay_id)        payLines.push({ label: 'PayID', value: profile.pay_id });

      const boxHeight = 16 + (payLines.length * 14);
      doc.rect(50, contentY, doc.page.width - 100, boxHeight).fill(lightGreen);
      doc.fillColor(green).fontSize(8).font('Helvetica-Bold')
         .text('PAYMENT DETAILS', 60, contentY + 6);
      contentY += 18;

      payLines.forEach(line => {
        doc.fillColor(textMuted).fontSize(9).font('Helvetica-Bold')
           .text(line.label + ':', 60, contentY);
        doc.fillColor(textDark).font('Helvetica')
           .text(line.value, 160, contentY);
        contentY += 14;
      });
      contentY += 10;
    }

    // Footer
    doc.fillColor(textMuted).fontSize(8).font('Helvetica')
       .text(`Thank you for your business. Generated by Tradie AI — ${profile.bizname || profile.name}`,
         50, doc.page.height - 60, { align: 'center', width: doc.page.width - 100 });

doc.end();

    // Log PDF generated to activity
    await supabase.from('job_activity').insert({
      job_id: req.params.id,
      user_id: req.user.id,
      user_name: profile.firstname || profile.name || 'Unknown',
      action: 'generated ' + type + ' PDF'
    });

  } catch (err) {
    console.error('PDF generation error:', err);
    res.status(500).json({ error: 'Could not generate PDF — please try again' });
  }
});

// ── JOBS: EMAIL PDF TO CUSTOMER ──
app.post('/api/jobs/:id/email-pdf', requireAuth, async (req, res) => {
  try {
    const { pdf, filename, type, customerEmail } = req.body;
    if (!pdf || !customerEmail) {
      return res.status(400).json({ error: 'PDF data and customer email required' });
    }

    let profileId;
    try {
      ({ ownerId: profileId } = await getJobScoped(req.params.id, req.user.id));
    } catch (e) {
      return res.status(e.status || 404).json({ error: e.message });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('bizname, name, email')
      .eq('id', profileId)
      .single();

 const businessName = profile?.bizname || profile?.name || 'Tradie AI';
    const isInvoice = type === 'invoice';
    const subject = isInvoice ? `Invoice from ${businessName}` : `Quote from ${businessName}`;

    // Generate payment link for invoices
    let paymentLink = null;
    if (isInvoice) {
      try {
        const { data: job } = await supabase.from('jobs').select('*').eq('id', req.params.id).single();
        if (job && parseFloat(job.value || 0) > 0) {
          const existingSession = job.stripe_session_id
            ? await stripe.checkout.sessions.retrieve(job.stripe_session_id).catch(() => null)
            : null;
          if (existingSession && existingSession.status === 'open') {
            paymentLink = existingSession.url;
          } else {
            const session = await stripe.checkout.sessions.create({
              payment_method_types: ['card'],
              line_items: [{
                price_data: {
                  currency: 'aud',
                  product_data: { name: `Invoice — ${job.job_number}`, description: job.description },
                  unit_amount: Math.round(parseFloat(job.value) * 100)
                },
                quantity: 1
              }],
              mode: 'payment',
              success_url: `${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}?payment=success`,
              cancel_url: `${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}?payment=cancelled`,
              metadata: { job_id: job.id, owner_user_id: profileId }
            });
            paymentLink = session.url;
            await supabase.from('jobs').update({ stripe_payment_link: session.url, stripe_session_id: session.id }).eq('id', job.id);
          }
        }
      } catch (err) {
        console.error('Payment link in email error:', err);
      }
    }

    const bodyText = isInvoice
      ? `Please find your invoice attached.\n\n${paymentLink ? `Pay now: ${paymentLink}\n\n` : ''}Thank you for your business.\n\n${businessName}`
      : `Please find your quote attached. This quote is valid for 30 days.\n\nPlease don't hesitate to get in touch if you have any questions.\n\n${businessName}`;

const htmlBody = isInvoice ? `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#0F6E56;">${businessName}</h2>
        <p>Please find your invoice attached.</p>
        ${paymentLink ? `
        <div style="margin:24px 0;">
          <a href="${paymentLink}" style="background:#0F6E56;color:#ffffff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;display:inline-block;">
            Pay now
          </a>
        </div>
        <p style="font-size:12px;color:#888;">Or copy this link: <a href="${paymentLink}">${paymentLink}</a></p>
        ` : ''}
        <p>Thank you for your business.</p>
        <p style="color:#555;">${businessName}</p>
      </div>` : `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#0F6E56;">${businessName}</h2>
        <p>Please find your quote attached. This quote is valid for 30 days.</p>
        <p>Please don't hesitate to get in touch if you have any questions.</p>
        <p style="color:#555;">${businessName}</p>
      </div>`;

    await resend.emails.send({
      from: `${businessName} <noreply@mailoncall.net>`,
      to: customerEmail,
      subject,
      text: bodyText,
      html: htmlBody,
      attachments: [{
        filename: filename || `${type}.pdf`,
        content: pdf
      }]
    });

// Log PDF emailed to activity
    await supabase.from('job_activity').insert({
      job_id: req.params.id,
      user_id: req.user.id,
      user_name: profile?.name || 'Unknown',
      action: (isInvoice ? 'invoice' : 'quote') + ' PDF emailed to ' + customerEmail
    });

    res.json({ success: true, message: `${isInvoice ? 'Invoice' : 'Quote'} sent to ${customerEmail}` });

  } catch (err) {
    console.error('Email PDF error:', err);
    res.status(500).json({ error: 'Could not send email — please check your email settings' });
  }
});
// ── JOBS: TIMESHEETS — CLOCK IN ──
app.post('/api/jobs/:id/timesheets/clockin', requireAuth, async (req, res) => {
  try {
    const { user_name } = req.body;
    try { await getJobScoped(req.params.id, req.user.id, { allowTeamMember: true }); }
    catch (e) { return res.status(e.status || 404).json({ error: e.message }); }

    // Check if already clocked in
    const { data: existing } = await supabase
      .from('job_timesheets')
      .select('id')
      .eq('job_id', req.params.id)
      .eq('user_id', req.user.id)
      .is('clocked_out_at', null)
      .single();

    if (existing) return res.status(400).json({ error: 'Already clocked in to this job' });

    const { data, error } = await supabase
      .from('job_timesheets')
      .insert({
        job_id: req.params.id,
        user_id: req.user.id,
        user_name: user_name || 'Unknown',
        clocked_in_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Log to activity
    await supabase.from('job_activity').insert({
      job_id: req.params.id,
      user_id: req.user.id,
      user_name: user_name || 'Unknown',
      action: 'clocked in'
    });

    res.json(data);
  } catch (err) {
    console.error('Clock in error:', err);
    res.status(500).json({ error: 'Could not clock in' });
  }
});

// ── JOBS: TIMESHEETS — CLOCK OUT ──
app.post('/api/jobs/:id/timesheets/clockout', requireAuth, async (req, res) => {
  try {
    const { user_name } = req.body;
    try { await getJobScoped(req.params.id, req.user.id, { allowTeamMember: true }); }
    catch (e) { return res.status(e.status || 404).json({ error: e.message }); }

    // Find active clock in
    const { data: entry } = await supabase
      .from('job_timesheets')
      .select('*')
      .eq('job_id', req.params.id)
      .eq('user_id', req.user.id)
      .is('clocked_out_at', null)
      .single();

    if (!entry) return res.status(400).json({ error: 'Not currently clocked in to this job' });

    const clockedOut = new Date();
    const clockedIn = new Date(entry.clocked_in_at);
    const hours = Math.round(((clockedOut - clockedIn) / (1000 * 60 * 60)) * 100) / 100;

    const { data, error } = await supabase
      .from('job_timesheets')
      .update({
        clocked_out_at: clockedOut.toISOString(),
        hours
      })
      .eq('id', entry.id)
      .select()
      .single();

    if (error) return res.status(400).json({ error: error.message });

    // Log to activity
    await supabase.from('job_activity').insert({
      job_id: req.params.id,
      user_id: req.user.id,
      user_name: user_name || 'Unknown',
      action: 'clocked out — ' + hours + ' hrs'
    });

    res.json(data);
  } catch (err) {
    console.error('Clock out error:', err);
    res.status(500).json({ error: 'Could not clock out' });
  }
});

// ── JOBS: TIMESHEETS — GET ──
app.get('/api/jobs/:id/timesheets', requireAuth, async (req, res) => {
  try {
    try { await getJobScoped(req.params.id, req.user.id, { allowTeamMember: true }); }
    catch (e) { return res.status(e.status || 404).json({ error: e.message }); }

    const { data, error } = await supabase
      .from('job_timesheets')
      .select('*')
      .eq('job_id', req.params.id)
      .order('clocked_in_at', { ascending: false });

    if (error) return res.status(400).json({ error: error.message });
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: 'Could not get timesheets' });
  }
});

// ── JOBS: CREATE (owner or supervisor — bypasses RLS via service key) ──
app.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    let ownerId = req.user.id;
   const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) {
      if (!isOwnerLevel(staffCtx)) {
        return res.status(403).json({ error: 'Only owners or supervisors can create jobs' });
      }
      ownerId = staffCtx.teams.owner_user_id;
    }

    const {
      assigned_to, job_address, customer_name, customer_phone, customer_email,
      description, value, due_date, due_time, status, notes
    } = req.body;

    if (!customer_name || !description) {
      return res.status(400).json({ error: 'Customer name and description are required' });
    }

 const { data: team, error: teamErr } = await supabase
      .from('teams')
      .select('id')
      .eq('owner_user_id', ownerId)
      .single();
    if (teamErr || !team) throw teamErr || new Error('Team not found');

    const { data: counterData, error: counterErr } = await supabase
      .rpc('increment_job_counter', { p_team_id: team.id });
    if (counterErr || !counterData) throw counterErr || new Error('Could not generate job number');
    const job_number = `JOB-${String(counterData).padStart(4, '0')}`;

    const { data: job, error } = await supabase
      .from('jobs')
      .insert({
        user_id: ownerId,
        job_number,
        assigned_to: assigned_to || null,
        job_address: job_address || '',
        customer_name,
        customer_phone: customer_phone || '',
        customer_email: customer_email || '',
        description,
        value: parseFloat(value) || 0,
        due_date: due_date || null,
        due_time: due_time || null,
        status: status || 'New',
        notes: notes || '',
        updated_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;

    await supabase.from('job_activity').insert({
      job_id: job.id,
      user_id: req.user.id,
      user_name: req.user.email,
      action: 'job created'
    });

    res.json(job);
  } catch (err) {
    console.error('create job error:', err);
    res.status(500).json({ error: 'Could not create job — please try again' });
  }
});

// ── JOBS: UPDATE (owner or supervisor — bypasses RLS via service key) ──
app.put('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    let ownerId = req.user.id;
   const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) {
      if (!isOwnerLevel(staffCtx)) {
        return res.status(403).json({ error: 'Only owners or supervisors can edit jobs' });
      }
      ownerId = staffCtx.teams.owner_user_id;
    }

    const {
      assigned_to, job_address, customer_name, customer_phone, customer_email,
      description, value, due_date, due_time, status, notes
    } = req.body;

    const { data: job, error } = await supabase
      .from('jobs')
      .update({
        assigned_to: assigned_to || null,
        job_address: job_address || '',
        customer_name,
        customer_phone: customer_phone || '',
        customer_email: customer_email || '',
        description,
        value: parseFloat(value) || 0,
        due_date: due_date || null,
        due_time: due_time || null,
        status: status || 'New',
        notes: notes || '',
        updated_at: new Date().toISOString()
      })
      .eq('id', req.params.id)
      .eq('user_id', ownerId)
      .select()
      .single();

    if (error) throw error;
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.json(job);
  } catch (err) {
    console.error('update job error:', err);
    res.status(500).json({ error: 'Could not save job — please try again' });
  }
});

// ── JOBS: NEXT NUMBER (server-side, prevents duplicates) ──
app.get('/api/jobs/next-number', requireAuth, async (req, res) => {
  try {
    let ownerId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) ownerId = staffCtx.teams.owner_user_id;

    // Use a running counter on the team, not a live row count,
    // so deleted jobs never cause a number to be reused
    const { data: team, error: teamErr } = await supabase
      .from('teams')
      .select('id, job_counter')
      .eq('owner_user_id', ownerId)
      .single();
    if (teamErr || !team) throw teamErr || new Error('Team not found');

    const nextCounter = (team.job_counter || 0) + 1;
    await supabase.from('teams').update({ job_counter: nextCounter }).eq('id', team.id);

    const nextNum = String(nextCounter).padStart(4, '0');
    res.json({ job_number: `JOB-${nextNum}` });

  } catch (err) {
    console.error('next-number error:', err);
    res.status(500).json({ error: 'Could not generate job number' });
  }
});
// ── STRIPE: CREATE PAYMENT LINK FOR INVOICE ──
app.post('/api/jobs/:id/payment-link', requireAuth, async (req, res) => {
  try {
    let job, profileId;
    try {
      ({ job, ownerId: profileId } = await getJobScoped(req.params.id, req.user.id));
    } catch (e) {
      return res.status(e.status || 404).json({ error: e.message });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('bizname, name')
      .eq('id', profileId)
      .single();

    const businessName = profile?.bizname || profile?.name || 'Tradie AI';
    const jobValue = Math.round(parseFloat(job.value || 0) * 100); // cents
    if (jobValue <= 0) return res.status(400).json({ error: 'Job has no value set' });

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'aud',
          product_data: {
            name: `Invoice — ${job.job_number}`,
            description: job.description
          },
          unit_amount: jobValue
        },
        quantity: 1
      }],
      mode: 'payment',
success_url: `${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}?payment=success`,
cancel_url: `${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}?payment=cancelled`,
      metadata: { job_id: job.id, owner_user_id: profileId }
    });

    // Save payment link to job
    await supabase.from('jobs').update({
      stripe_payment_link: session.url,
      stripe_session_id: session.id
    }).eq('id', job.id);

    await supabase.from('job_activity').insert({
      job_id: job.id,
      user_id: req.user.id,
      user_name: businessName,
      action: 'payment link created'
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Payment link error:', err);
    res.status(500).json({ error: 'Could not create payment link' });
  }
});


// ══════════════════════════════════════════════════
// ── AUTOMATION ENGINE ──
// ══════════════════════════════════════════════════

// ── QUOTE TOKEN GENERATOR ──
async function ensureQuoteToken(jobId) {
  const crypto = require('crypto');
  const token = crypto.randomBytes(32).toString('hex');
  await supabase.from('jobs').update({ quote_token: token }).eq('id', jobId);
  return token;
}

// ── CUSTOMER STATUS EMAIL HELPER ──
async function generateJobPdf(job, profile, type = 'quote') {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const green = '#0F6E56';
    const lightGreen = '#E1F5EE';
    const textDark = '#1A1A1A';
    const textMuted = '#666660';
    const isInvoice = type === 'invoice';

    doc.rect(0, 0, doc.page.width, 110).fill(green);
    doc.fillColor('#FFFFFF').fontSize(24).font('Helvetica-Bold')
       .text(profile.bizname || profile.name || 'Tradie AI', 50, 30);
    doc.fontSize(13).font('Helvetica')
       .text(isInvoice ? 'INVOICE' : 'QUOTE', 0, 40, { align: 'right', width: doc.page.width - 50 });
    doc.fontSize(10)
       .text(job.job_number, 0, 58, { align: 'right', width: doc.page.width - 50 });

    doc.fillColor(textMuted).fontSize(9).font('Helvetica');
    let detailY = 125;
    if (profile.address) { doc.text(profile.address, 50, detailY); detailY += 13; }
    if (profile.phone)   { doc.text(profile.phone, 50, detailY);   detailY += 13; }
    if (profile.abn)     { doc.text(`ABN: ${profile.abn}`, 50, detailY); detailY += 13; }
    if (profile.licence) { doc.text(`Licence: ${profile.licence}`, 50, detailY); detailY += 13; }

    const today = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });
    doc.fillColor(textMuted).fontSize(9)
       .text(`Date: ${today}`, 0, 125, { align: 'right', width: doc.page.width - 50 });
    if (!isInvoice) {
      doc.text('Valid for 30 days', 0, 138, { align: 'right', width: doc.page.width - 50 });
    }

    const dividerY = Math.max(detailY, 160) + 10;
    doc.moveTo(50, dividerY).lineTo(doc.page.width - 50, dividerY)
       .strokeColor('#E0DED8').lineWidth(0.5).stroke();

    let contentY = dividerY + 20;
    doc.fillColor(green).fontSize(9).font('Helvetica-Bold').text('BILL TO', 50, contentY);
    contentY += 14;
    doc.fillColor(textDark).fontSize(11).font('Helvetica-Bold').text(job.customer_name, 50, contentY);
    contentY += 14;
    if (job.customer_phone) { doc.fillColor(textMuted).fontSize(9).font('Helvetica').text(job.customer_phone, 50, contentY); contentY += 12; }
    if (job.customer_email) { doc.fillColor(textMuted).fontSize(9).text(job.customer_email, 50, contentY); contentY += 12; }
    if (job.job_address)    { doc.fillColor(textMuted).fontSize(9).text(job.job_address, 50, contentY); contentY += 12; }
    contentY += 20;

    doc.rect(50, contentY, doc.page.width - 100, 24).fill(green);
    doc.fillColor('#FFFFFF').fontSize(9).font('Helvetica-Bold');
    doc.text('DESCRIPTION', 60, contentY + 8);
    doc.text('AMOUNT', 0, contentY + 8, { align: 'right', width: doc.page.width - 60 });
    contentY += 24;

    const jobValue = parseFloat(job.value) || 0;
    const exGST = jobValue / 1.1;
    const gst = jobValue - exGST;
    doc.rect(50, contentY, doc.page.width - 100, 40).fill(lightGreen);
    doc.fillColor(textDark).fontSize(10).font('Helvetica')
       .text(job.description, 60, contentY + 8, { width: doc.page.width - 200, height: 28, ellipsis: true });
    doc.text(`$${exGST.toFixed(2)}`, 0, contentY + 14, { align: 'right', width: doc.page.width - 60 });
    contentY += 50;

    doc.fillColor(textMuted).fontSize(9).font('Helvetica');
    doc.text('Subtotal (ex GST)', doc.page.width - 220, contentY);
    doc.text(`$${exGST.toFixed(2)}`, 0, contentY, { align: 'right', width: doc.page.width - 50 });
    contentY += 16;
    doc.text('GST (10%)', doc.page.width - 220, contentY);
    doc.text(`$${gst.toFixed(2)}`, 0, contentY, { align: 'right', width: doc.page.width - 50 });
    contentY += 16;
    doc.moveTo(doc.page.width - 220, contentY).lineTo(doc.page.width - 50, contentY)
       .strokeColor('#E0DED8').lineWidth(0.5).stroke();
    contentY += 10;
    doc.fillColor(textDark).fontSize(12).font('Helvetica-Bold').text('TOTAL (inc GST)', doc.page.width - 220, contentY);
    doc.fillColor(green).fontSize(14).text(`$${jobValue.toFixed(2)}`, 0, contentY - 2, { align: 'right', width: doc.page.width - 50 });
    contentY += 40;

    if (profile.terms) {
      doc.rect(50, contentY, doc.page.width - 100, 36).fill(lightGreen);
      doc.fillColor(green).fontSize(8).font('Helvetica-Bold').text('PAYMENT TERMS', 60, contentY + 6);
      doc.fillColor(textDark).fontSize(9).font('Helvetica')
         .text(profile.terms, 60, contentY + 18);
      contentY += 50;
    }

    doc.fillColor(textMuted).fontSize(8).font('Helvetica')
       .text(`Thank you for your business. Generated by Tradie AI — ${profile.bizname || profile.name}`,
         50, doc.page.height - 60, { align: 'center', width: doc.page.width - 100 });

    doc.end();
  });
}

async function sendCustomerStatusEmail(job, profile, newStatus) {
  if (!job.customer_email) return;
  const businessName = profile.bizname || profile.name || 'Tradie AI';
  const firstName = job.customer_name ? job.customer_name.split(' ')[0] : 'there';
  const value = parseFloat(job.value || 0).toFixed(2);
  const dueDate = job.due_date ? new Date(job.due_date).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const phone = profile.phone || '';

const frontendUrl = process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com';
 const quoteToken = job.quote_token || await ensureQuoteToken(job.id);
  const quoteUrl = `${frontendUrl}?quote=${quoteToken}`;

  const msgs = {
   'Quoted': {
      subject: 'Quote from ' + businessName,
      body: 'Hi ' + firstName + ',\n\nThanks for getting in touch. We\'ve prepared a quote for you.\n\nJob: ' + job.description + '\nAmount: $' + value + ' inc GST\n\nView and respond to your quote here:\n' + `${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}?quote=${quoteToken}` + '\n\nCheers,\n' + businessName,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;">
        <h2 style="color:#0F6E56;margin-bottom:4px;">${businessName}</h2>
        <p style="color:#555;margin-bottom:24px;">Quote for ${firstName}</p>
        <div style="background:#F4F3EF;border-radius:12px;padding:20px;margin-bottom:24px;">
          <div style="font-size:13px;color:#888;margin-bottom:4px;">JOB</div>
          <div style="font-size:15px;color:#1A1A1A;margin-bottom:16px;">${job.description}</div>
          <div style="font-size:13px;color:#888;margin-bottom:4px;">AMOUNT</div>
          <div style="font-size:28px;font-weight:700;color:#0F6E56;">$${value} <span style="font-size:14px;font-weight:400;color:#888;">inc GST</span></div>
        </div>
        <a href="${process.env.FRONTEND_URL || 'https://tradieai-frontend.onrender.com'}?quote=${quoteToken}" style="display:block;background:#0F6E56;color:#ffffff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px;margin-bottom:12px;">View &amp; respond to quote</a>
        <p style="font-size:12px;color:#aaa;text-align:center;">This quote is valid for 30 days.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
        <p style="font-size:13px;color:#555;">Questions? Reply to this email or call us directly.</p>
        <p style="font-size:13px;color:#555;">Cheers,<br><strong>${businessName}</strong>${phone ? '<br>' + phone : ''}</p>
      </div>`
    },
    'Accepted': {
      subject: 'Job confirmed — ' + businessName,
      body: 'Hi ' + firstName + ',\n\nGreat news — your job has been confirmed.\n\nJob: ' + job.description + (dueDate ? '\nScheduled: ' + dueDate : '') + (job.job_address ? '\nAddress: ' + job.job_address : '') + '\n\nWe\'ll be in touch with any updates.\n\nCheers,\n' + businessName + (phone ? '\n' + phone : '')
    },
    'In Progress': {
      subject: 'Work has started — ' + businessName,
      body: 'Hi ' + firstName + ',\n\nJust letting you know we\'ve started work on your job.\n\nJob: ' + job.description + (job.job_address ? '\nAddress: ' + job.job_address : '') + '\n\nWe\'ll keep you updated on progress.\n\nCheers,\n' + businessName + (phone ? '\n' + phone : '')
    },
    'Completed': {
      subject: 'Job completed — ' + businessName,
      body: 'Hi ' + firstName + ',\n\nGood news — your job has been completed.\n\nJob: ' + job.description + (job.job_address ? '\nAddress: ' + job.job_address : '') + '\n\nIf you have any questions, don\'t hesitate to get in touch.\n\nCheers,\n' + businessName + (phone ? '\n' + phone : '')
    }
  };

  const template = msgs[newStatus];
  if (!template) return;

  try {
const emailPayload = {
      from: businessName + ' <noreply@mailoncall.net>',
      to: job.customer_email,
      subject: template.subject,
      text: template.body,
      ...(template.html ? { html: template.html } : {})
    };

    // Attach PDF for Quoted and Completed status emails
    if (newStatus === 'Quoted' || newStatus === 'Completed') {
      try {
        const pdfType = newStatus === 'Quoted' ? 'quote' : 'quote';
        const pdfBuffer = await generateJobPdf(job, profile, pdfType);
        const filename = `${pdfType}-${job.job_number}.pdf`;
        emailPayload.attachments = [{
          filename,
          content: pdfBuffer.toString('base64')
        }];
      } catch (pdfErr) {
        console.error('PDF attachment error — sending email without PDF:', pdfErr);
        // Don't block the email if PDF fails
      }
    }

    await resend.emails.send(emailPayload);
    console.log('Status email sent to ' + job.customer_email + ' for status ' + newStatus);
  } catch (err) {
    console.error('Status email error:', err);
  }
}

// ── JOBS: UPDATE STATUS (with auto customer email) ──
app.post('/api/jobs/:id/update-status', requireAuth, async (req, res) => {
  const { status, notes } = req.body;
  const validStatuses = ['New', 'Quoted', 'Accepted', 'Declined', 'In Progress', 'Completed', 'Invoiced', 'Paid'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  // Team members can only update status on jobs assigned to them
  // and only to In Progress or Completed
  const staffCtx = await getStaffMember(req.user.id);
  if (staffCtx && staffCtx.role === 'team_member') {
    if (!['In Progress', 'Completed'].includes(status)) {
      return res.status(403).json({ error: 'Team members can only set In Progress or Completed' });
    }
  }

  let scopedJob, profileId;
  try {
    ({ job: scopedJob, ownerId: profileId } = await getJobScoped(req.params.id, req.user.id, { allowTeamMember: true }));
  } catch (e) {
    return res.status(e.status || 404).json({ error: e.message });
  }

  const updateData = { status: status, updated_at: new Date().toISOString() };
  if (status === 'Invoiced') updateData.invoiced_at = new Date().toISOString();
  if (notes !== undefined) updateData.notes = notes;

  const { data: job, error } = await supabase
    .from('jobs')
    .update(updateData)
    .eq('id', req.params.id)
    .eq('user_id', profileId)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

// Send customer status email
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', profileId).single();
  if (profile) {
    await sendCustomerStatusEmail(job, profile, status);
    // Log email sent to activity
    if (['Quoted','Accepted','In Progress','Completed'].includes(status) && job.customer_email) {
      await supabase.from('job_activity').insert({
        job_id: job.id,
        user_id: profileId,
        user_name: 'Auto',
        action: 'status email sent to ' + job.customer_email
      });
    }
  }

// Push to owner and supervisors on every status change
  const pushTitle = job.job_number + ' — ' + status;
  const pushBody = job.customer_name + ' — updated to ' + status;

  // Notify owner
  await sendPushToUser(profileId, pushTitle, pushBody, '/');

  // Notify all active supervisors on the same team
  const { data: team } = await supabase.from('teams').select('id').eq('owner_user_id', profileId).single();
  if (team) {
    const { data: supervisors } = await supabase
      .from('team_members')
      .select('user_id')
      .eq('team_id', team.id)
      .eq('role', 'supervisor')
      .eq('status', 'active');
    for (const sup of supervisors || []) {
      if (sup.user_id !== req.user.id) {
        await sendPushToUser(sup.user_id, pushTitle, pushBody, '/');
      }
    }
  }

  res.json({ success: true, job: job });
});

// ── CRON: DAILY TASKS (payment chase + job reminders) ──
app.post('/api/cron/daily', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = { chases_sent: 0, reminders_sent: 0, errors: [] };
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);

  // ── 1. PAYMENT CHASE — 7 / 14 / 30 day reminders for unpaid invoices ──
  try {
    const { data: invoicedJobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('status', 'Invoiced')
      .not('customer_email', 'is', null);

    for (const job of invoicedJobs || []) {
      const invoicedAt = new Date(job.invoiced_at || job.updated_at);
      const daysSince = Math.floor((now - invoicedAt) / (1000 * 60 * 60 * 24));
      const chaseCount = job.chase_count || 0;

      let shouldChase = false;
      let chaseLevel = '';
      if (daysSince >= 30 && chaseCount < 3) { shouldChase = true; chaseLevel = 'final'; }
      else if (daysSince >= 14 && chaseCount < 2) { shouldChase = true; chaseLevel = 'second'; }
      else if (daysSince >= 7 && chaseCount < 1) { shouldChase = true; chaseLevel = 'first'; }

      if (!shouldChase) continue;

      const { data: profile } = await supabase.from('profiles').select('*').eq('id', job.user_id).single();
      if (!profile) continue;

      const businessName = profile.bizname || profile.name || 'Tradie AI';
      const value = parseFloat(job.value || 0).toFixed(2);
      const firstName = job.customer_name ? job.customer_name.split(' ')[0] : 'there';
      const phone = profile.phone || '';

      const chaseMessages = {
        first: {
          subject: 'Payment reminder — ' + businessName,
          body: 'Hi ' + firstName + ',\n\nJust a friendly reminder that payment of $' + value + ' is now due.\n\nJob: ' + job.description + '\nInvoice: ' + job.job_number + '\n\nIf you\'ve already paid, please disregard this message.\n\nCheers,\n' + businessName + (phone ? '\n' + phone : '')
        },
        second: {
          subject: 'Payment overdue — ' + businessName,
          body: 'Hi ' + firstName + ',\n\nThis is a reminder that payment of $' + value + ' is now 14 days overdue.\n\nJob: ' + job.description + '\nInvoice: ' + job.job_number + '\n\nPlease arrange payment at your earliest convenience.\n\nCheers,\n' + businessName + (phone ? '\n' + phone : '')
        },
        final: {
          subject: 'Final payment notice — ' + businessName,
          body: 'Hi ' + firstName + ',\n\nThis is a final notice that payment of $' + value + ' is now 30 days overdue.\n\nJob: ' + job.description + '\nInvoice: ' + job.job_number + '\n\nPlease arrange payment urgently. If you have any questions, please contact us.\n\nRegards,\n' + businessName + (phone ? '\n' + phone : '')
        }
      };

      try {
        await resend.emails.send({
          from: businessName + ' <noreply@mailoncall.net>',
          to: job.customer_email,
          subject: chaseMessages[chaseLevel].subject,
          text: chaseMessages[chaseLevel].body
        });
await supabase.from('jobs').update({
          chase_count: chaseCount + 1,
          last_chase_at: now.toISOString()
        }).eq('id', job.id);

        // Log chase to activity
        await supabase.from('job_activity').insert({
          job_id: job.id,
          user_id: job.user_id,
          user_name: 'Auto',
          action: chaseLevel + ' payment chase email sent to ' + job.customer_email
        });
        results.chases_sent++;
      } catch (err) {
        console.error('Chase email error for job ' + job.job_number + ':', err);
        results.errors.push('Chase: ' + job.job_number);
      }
    }
  } catch (err) {
    console.error('Chase query error:', err);
    results.errors.push('Chase query failed');
  }

  // ── 2. JOB REMINDERS — jobs due tomorrow ──
  try {
    const { data: tomorrowJobs } = await supabase
      .from('jobs')
      .select('*')
      .eq('due_date', tomorrowStr)
      .in('status', ['New', 'Quoted', 'Accepted', 'In Progress']);

    for (const job of tomorrowJobs || []) {
      const { data: profile } = await supabase.from('profiles').select('*').eq('id', job.user_id).single();
      if (!profile) continue;

      const businessName = profile.bizname || profile.name || 'Tradie AI';
      const dueDate = new Date(job.due_date).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
      const firstName = job.customer_name ? job.customer_name.split(' ')[0] : 'there';
      const phone = profile.phone || 'our office number';

      // Email to customer
      if (job.customer_email) {
        try {
          await resend.emails.send({
            from: businessName + ' <noreply@mailoncall.net>',
            to: job.customer_email,
            subject: 'Reminder: ' + businessName + ' is scheduled tomorrow',
            text: 'Hi ' + firstName + ',\n\nJust a reminder that ' + businessName + ' is scheduled to visit you tomorrow.\n\nDate: ' + dueDate + (job.due_time ? '\nTime: ' + job.due_time.slice(0, 5) : '') + '\nJob: ' + job.description + (job.job_address ? '\nAddress: ' + job.job_address : '') + '\n\nIf you need to reschedule, please call us on ' + phone + '.\n\nCheers,\n' + businessName
          });
// Log reminder to activity
          await supabase.from('job_activity').insert({
            job_id: job.id,
            user_id: job.user_id,
            user_name: 'Auto',
            action: 'job reminder email sent to ' + job.customer_email
          });
          results.reminders_sent++;
        } catch (err) {
          console.error('Customer reminder error:', err);
          results.errors.push('Reminder email: ' + job.job_number);
        }
      }

      // Push notification to assigned staff
      if (job.assigned_to) {
        await sendPushToUser(
          job.assigned_to,
          'Job tomorrow',
          job.customer_name + (job.due_time ? ' at ' + job.due_time.slice(0, 5) : '') + ' — ' + (job.job_address || job.description),
          '/'
        );
      }
    }
  } catch (err) {
    console.error('Reminder query error:', err);
    results.errors.push('Reminder query failed');
  }

console.log('Cron daily completed:', results);
  res.json({ success: true, timestamp: now.toISOString(), results: results });
});

async function runDailyCronTasks() {
  console.log('Running cron tasks directly...');
  const results = { chases_sent: 0, reminders_sent: 0, errors: [] };
  const fakeRes = { json: (d) => console.log('Cron result:', JSON.stringify(d)) };
  const fakeReq = { headers: { 'x-cron-secret': process.env.CRON_SECRET }, query: { secret: process.env.CRON_SECRET } };
  
  // Make internal request to cron endpoint
  const http = require('http');
  const options = {
    hostname: 'localhost',
    port: process.env.PORT || 10000,
    path: '/api/cron/daily',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET }
  };
  return new Promise((resolve) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { console.log('Cron result:', data); resolve(); });
    });
    req.on('error', (err) => { console.error('Cron error:', err.message); resolve(); });
    req.end();
  });
}

// ── CUSTOMERS ──
app.get('/api/customers', requireAuth, async (req, res) => {
  try {
    let ownerId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) ownerId = staffCtx.teams.owner_user_id;

    const { data: customers, error } = await supabase
      .from('customers')
      .select('*')
      .eq('owner_user_id', ownerId)
      .order('name', { ascending: true });

    if (error) throw error;

    const { data: jobs } = await supabase
      .from('jobs')
      .select('customer_name, customer_email, value, status, created_at')
      .eq('user_id', ownerId);

    const enriched = customers.map(c => {
      const cJobs = jobs?.filter(j => j.customer_email && j.customer_email === c.email) || [];
      const totalValue = cJobs.reduce((sum, j) => sum + (parseFloat(j.value) || 0), 0);
      const lastJob = cJobs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
      return { ...c, job_count: cJobs.length, total_value: totalValue, last_job_date: lastJob?.created_at || null };
    });

    res.json(enriched);
  } catch (err) {
    console.error('customers error:', err);
    res.status(500).json({ error: 'Could not load customers' });
  }
});

app.post('/api/customers', requireAuth, async (req, res) => {
  try {
    let ownerId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) ownerId = staffCtx.teams.owner_user_id;

    const { name, phone, email, address } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const { data, error } = await supabase
      .from('customers')
      .insert({ owner_user_id: ownerId, name, phone: phone||null, email: email||null, address: address||null })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('create customer error:', err);
    res.status(500).json({ error: 'Could not create customer' });
  }
});

app.delete('/api/customers/:id', requireAuth, async (req, res) => {
  try {
    let ownerId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) ownerId = staffCtx.teams.owner_user_id;

    const { error } = await supabase
      .from('customers')
      .delete()
      .eq('id', req.params.id)
      .eq('owner_user_id', ownerId);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete customer' });
  }
});

app.listen(PORT, () => {
  console.log(`Tradie AI backend running on port ${PORT}`);

  // ── BUILT-IN DAILY CRON — runs every hour, checks if it's 5pm AEST ──
  let lastCronDate = '';
  setInterval(async () => {
    const now = new Date();
    const aest = new Date(now.toLocaleString('en-US', { timeZone: 'Australia/Melbourne' }));
    const hour = aest.getHours();
    const dateStr = aest.toISOString().slice(0, 10);
    // Run once per day at 5pm Melbourne time
 if (hour === 17 && dateStr !== lastCronDate) {
      lastCronDate = dateStr;
      console.log('Running daily cron at', now.toISOString());
      try {
await runDailyCronTasks();
      } catch (err) {
        console.error('Cron self-call error:', err);
      }
    }
}, 60 * 60 * 1000); // Check every 2 minutes (TESTING ONLY)
});