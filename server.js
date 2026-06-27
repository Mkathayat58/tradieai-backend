require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ──
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
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

  const prompts = {
    quote: `You are Tradie AI, a professional assistant for Australian tradies. Write a clean professional trade quote in Australian English.
${base}
Rules: Always include GST breakdown (price ex GST + 10% GST = total inc GST). Reference relevant Australian standards where appropriate (e.g. AS/NZS 3000 for electrical). Include "Quote valid for 30 days" and "Payment due on completion." Use Australian English. Keep it professional but not overly corporate. Output the quote text only, no extra commentary.`,

    email: `You are Tradie AI, helping an Australian tradie write professional customer emails.
${base}
Rules: Write in Australian English. Tone should be professional but warm — like a confident business owner, not a corporate robot. No grovelling or excessive apologising. Be firm but fair. Output the email text only, with subject line if appropriate.`,

    jobad: `You are Tradie AI, helping an Australian tradie write an effective job advertisement.
${base}
Rules: Write in Australian English. Comply with Fair Work requirements — no discriminatory language, accurate pay information. Write in an approachable tone that attracts good applicants. Include: role overview, what you will be doing, what we are looking for, what we offer. Output the job ad text only, ready to paste into Seek or Gumtree.`,

    complaint: `You are Tradie AI, helping an Australian tradie respond professionally to a customer complaint.
${base}
Rules: Write in Australian English. Acknowledge the concern without admitting fault unnecessarily. Be calm, firm, and professional. Protect the business while keeping the customer relationship intact. Output the reply text only.`,

    followup: `You are Tradie AI, helping an Australian tradie write a confident follow-up message.
${base}
Rules: Write in Australian English. Keep it short, friendly, and not desperate. Sound like a busy professional following up — not chasing work. Output the message text only.`,

  chat: `You are Tradie AI, a friendly business assistant for Australian tradies. You help with quotes, emails, job ads, business advice, pricing, customer handling, and anything else a tradie needs.
${base}
Rules: Be helpful, direct, and use Australian English. Keep responses concise and practical. No jargon.`,

    swms: `You are Tradie AI, generating a Safe Work Method Statement (SWMS) for an Australian tradie.
${base}
Rules: Generate a compliant Australian SWMS. Include: 1) Job details and location 2) List of high risk tasks as numbered steps 3) For each step list hazards, risk rating (Low/Medium/High) and control measures 4) PPE required 5) Emergency procedures 6) Sign-off section. Reference relevant Australian WHS legislation. Use plain English that workers can understand. Output the SWMS text only, ready to print or share.`,

    jsa: `You are Tradie AI, generating a Job Safety Analysis (JSA) for an Australian tradie.
${base}
Rules: Generate a practical JSA. Include: 1) Job description and location 2) Break the job into steps 3) For each step identify hazards and control measures 4) PPE required 5) Sign-off section. Keep it simple and practical — this is for everyday non-high-risk work. Use plain English. Output the JSA text only, ready to print or share.`,

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

  // Also update the team_members record if phone changed
  if (phone !== undefined) {
    await supabase.from('team_members').update({ phone }).eq('user_id', req.user.id);
  }

  res.json(data);
});

// ── AI: GENERATE ──
app.post('/api/generate', requireAuth, async (req, res) => {
  const { template, message } = req.body;
  if (!template || !message) return res.status(400).json({ error: 'Template and message required' });

  // Check if user is a supervisor — if so, use the owner's profile for AI context
  let profileUserId = req.user.id;
  const staffCtx = await getStaffMember(req.user.id);
  if (staffCtx && staffCtx.role === 'supervisor') {
    profileUserId = staffCtx.teams.owner_user_id;
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', profileUserId)
    .single();
  if (profileError) return res.status(404).json({ error: 'Profile not found' });

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
    const systemPrompt = getSystemPrompt(template, profile);
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

// ── AI: CHAT (multi-turn) ──
app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'Messages array required' });

  // Supervisor uses owner's profile for context
  let profileUserId = req.user.id;
  const staffCtx = await getStaffMember(req.user.id);
  if (staffCtx && staffCtx.role === 'supervisor') {
    profileUserId = staffCtx.teams.owner_user_id;
  }

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', profileUserId).single();
  if (!profile) return res.status(404).json({ error: 'Profile not found' });

  const limit = PLAN_LIMITS[profile.plan] || PLAN_LIMITS.free;
  if (profile.usage_count >= limit) {
    return res.status(429).json({ error: 'Monthly message limit reached', limit, plan: profile.plan });
  }

  try {
    const systemPrompt = getSystemPrompt('chat', profile);
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

    await supabase.from('profiles').update({ usage_count: profile.usage_count + 1 }).eq('id', profileUserId);

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
    .in('role', ['supervisor', 'team_member'])
    .single();
  return data || null;
}

// Legacy alias
async function getStaffContext(userId) {
  return getStaffMember(userId);
}

// ── TEAM: INVITE STAFF ──
app.post('/api/team/invite', requireAuth, async (req, res) => {
  const { name, email, role } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });

  // Validate role — default to team_member if not provided
  const memberRole = (role === 'supervisor') ? 'supervisor' : 'team_member';

  const team = await getOrCreateTeam(req.user.id);
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

// ── TEAM: REMOVE MEMBER (owner only) ──
app.delete('/api/team/members/:id', requireAuth, async (req, res) => {
  const team = await getOrCreateTeam(req.user.id);
  if (!team) return res.status(404).json({ error: 'Team not found' });

  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('id', req.params.id)
    .eq('team_id', team.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ── TEAM: UPDATE MEMBER ROLE (owner only) ──
app.put('/api/team/members/:id/role', requireAuth, async (req, res) => {
  const { role } = req.body;
  if (!role || !['supervisor', 'team_member'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role. Must be supervisor or team_member.' });
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
  const { invite_token } = req.body;

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
      .eq('status', 'pending')
      .select('*, teams(owner_user_id)')
      .single();
    if (error || !data) return res.status(404).json({ error: 'No pending invite found' });
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
  if (!staffCtx || staffCtx.role !== 'supervisor') {
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
  if (!staffCtx || staffCtx.role !== 'supervisor') {
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
  if (!staffCtx || staffCtx.role !== 'supervisor') {
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
  if (!staffCtx || staffCtx.role !== 'supervisor') {
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

// ── JOB ACTIVITY: LOG ──
app.post('/api/jobs/:id/activity', requireAuth, async (req, res) => {
  const { action, user_name } = req.body;
  if (!action) return res.status(400).json({ error: 'Action required' });

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
  const { data, error } = await supabase
    .from('job_activity')
    .select('*')
    .eq('job_id', req.params.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ error: error.message });
  res.json(data || []);
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
app.get('/api/team/invite/:token', async (req, res) => {
  const { data, error } = await supabase
    .from('team_members')
    .select('name, email, status, role')
    .eq('invite_token', req.params.token)
    .single();
  if (error || !data) return res.status(404).json({ error: 'Invalid or expired invite link' });
  if (data.status === 'active') return res.status(400).json({ error: 'This invite has already been used' });
  res.json({ name: data.name, email: data.email, role: data.role });
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

    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (jobError || !job) return res.status(404).json({ error: 'Job not found' });

    let profileId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) profileId = staffCtx.teams.owner_user_id;

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
    doc.fillColor('#FFFFFF').fontSize(24).font('Helvetica-Bold')
       .text(profile.bizname || profile.name || 'Tradie AI', 50, 30);
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

    let profileId = req.user.id;
    const staffCtx = await getStaffMember(req.user.id);
    if (staffCtx) profileId = staffCtx.teams.owner_user_id;

    const { data: profile } = await supabase
      .from('profiles')
      .select('bizname, name, email')
      .eq('id', profileId)
      .single();

    const businessName = profile?.bizname || profile?.name || 'Tradie AI';
    const isInvoice = type === 'invoice';
    const subject = isInvoice ? `Invoice from ${businessName}` : `Quote from ${businessName}`;
    const bodyText = isInvoice
      ? `Please find your invoice attached.\n\nThank you for your business.\n\n${businessName}`
      : `Please find your quote attached. This quote is valid for 30 days.\n\nPlease don't hesitate to get in touch if you have any questions.\n\n${businessName}`;

  await resend.emails.send({
      from: `${businessName} <noreply@mailoncall.net>`,
      to: customerEmail,
      subject,
      text: bodyText,
      attachments: [{
        filename: filename || `${type}.pdf`,
        content: pdf
      }]
    });

    res.json({ success: true, message: `${isInvoice ? 'Invoice' : 'Quote'} sent to ${customerEmail}` });

  } catch (err) {
    console.error('Email PDF error:', err);
    res.status(500).json({ error: 'Could not send email — please check your email settings' });
  }
});
// ── JOBS: NEXT NUMBER (server-side, prevents duplicates) ──
app.get('/api/jobs/next-number', requireAuth, async (req, res) => {
  try {
    const ownerId = req.user.id;

    // Count all jobs for this owner to get next number
    const { count, error } = await supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', ownerId);

    if (error) throw error;

    // Format as JOB-0001, JOB-0042 etc.
    const nextNum = String((count || 0) + 1).padStart(4, '0');
    res.json({ job_number: `JOB-${nextNum}` });

  } catch (err) {
    console.error('next-number error:', err);
    res.status(500).json({ error: 'Could not generate job number' });
  }
});


// ══════════════════════════════════════════════════
// ── AUTOMATION ENGINE ──
// ══════════════════════════════════════════════════

// ── CUSTOMER STATUS EMAIL HELPER ──
async function sendCustomerStatusEmail(job, profile, newStatus) {
  if (!job.customer_email) return;
  const businessName = profile.bizname || profile.name || 'Tradie AI';
  const firstName = job.customer_name ? job.customer_name.split(' ')[0] : 'there';
  const value = parseFloat(job.value || 0).toFixed(2);
  const dueDate = job.due_date ? new Date(job.due_date).toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  const phone = profile.phone || '';

  const msgs = {
    'Quoted': {
      subject: 'Quote from ' + businessName,
      body: 'Hi ' + firstName + ',\n\nThanks for getting in touch. We\'ve prepared a quote for you.\n\nJob: ' + job.description + '\nAmount: $' + value + ' inc GST\n\nPlease let us know if you\'d like to go ahead.\n\nCheers,\n' + businessName
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
    await resend.emails.send({
      from: businessName + ' <noreply@mailoncall.net>',
      to: job.customer_email,
      subject: template.subject,
      text: template.body
    });
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

  let profileId = req.user.id;
  const staffCtx = await getStaffMember(req.user.id);
  if (staffCtx) profileId = staffCtx.teams.owner_user_id;

  const updateData = { status: status, updated_at: new Date().toISOString() };
  if (status === 'Invoiced') updateData.invoiced_at = new Date().toISOString();
  if (notes !== undefined) updateData.notes = notes;

  const { data: job, error } = await supabase
    .from('jobs')
    .update(updateData)
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(400).json({ error: error.message });

  // Send customer status email
  const { data: profile } = await supabase.from('profiles').select('*').eq('id', profileId).single();
  if (profile) {
    await sendCustomerStatusEmail(job, profile, status);
  }

  // Push to owner when supervisor/staff completes a job
  if (status === 'Completed' && staffCtx) {
    await sendPushToUser(
      profileId,
      'Job completed',
      '"' + job.customer_name + '" marked complete',
      '/'
    );
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