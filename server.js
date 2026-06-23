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
Rules: Be helpful, direct, and use Australian English. Keep responses concise and practical. No jargon.`
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

app.listen(PORT, () => console.log(`Tradie AI backend running on port ${PORT}`));