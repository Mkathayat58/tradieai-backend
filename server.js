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
  res.json({ status: 'Tradie AI backend running', version: '1.0.0' });
});

// ── AUTH: SIGNUP ──
app.post('/api/auth/signup', async (req, res) => {
  const { email, password, profile } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  // Create auth user
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email, password, email_confirm: true
  });
  if (authError) return res.status(400).json({ error: authError.message });

  // Create profile
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

// ── AI: GENERATE ──
app.post('/api/generate', requireAuth, async (req, res) => {
  const { template, message } = req.body;
  if (!template || !message) return res.status(400).json({ error: 'Template and message required' });

  // Get user profile + check usage
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();
  if (profileError) return res.status(404).json({ error: 'Profile not found' });

  // Reset usage if new month
  const now = new Date();
  const resetDate = new Date(profile.usage_reset);
  if (now >= resetDate) {
    const nextReset = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
    await supabase.from('profiles').update({ usage_count: 0, usage_reset: nextReset }).eq('id', req.user.id);
    profile.usage_count = 0;
  }

  // Check limit
  const limit = PLAN_LIMITS[profile.plan] || PLAN_LIMITS.free;
  if (profile.usage_count >= limit) {
    return res.status(429).json({
      error: 'Monthly message limit reached',
      limit,
      used: profile.usage_count,
      plan: profile.plan
    });
  }

  // Call DeepSeek
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

    // Increment usage
    const newCount = profile.usage_count + 1;
    await supabase.from('profiles').update({ usage_count: newCount }).eq('id', req.user.id);

    // Save to history
    const { data: historyItem } = await supabase.from('history').insert({
      user_id: req.user.id,
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

  const { data: profile } = await supabase.from('profiles').select('*').eq('id', req.user.id).single();
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

// ── START ──
app.listen(PORT, () => console.log(`Tradie AI backend running on port ${PORT}`));
